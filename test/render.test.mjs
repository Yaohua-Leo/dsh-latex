import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clampDpi,
  clampPage,
  findQuoteBox,
  listLookCaches,
  lookCacheDir,
  lookPagePath,
  parseBboxWords,
  parsePdfInfo,
  previousLookPage,
  probeRenderTools,
  pruneLookCaches,
  renderCapability,
  renderPageToPng,
  runTool,
  sha256File,
} from '../src/render.js';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();

async function tempDir(t) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-render-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parsePdfInfo reads pages, size and encryption', () => {
  const parsed = parsePdfInfo('Pages:           3\nPage size:      595.276 x 841.89 pts (A4)\nEncrypted:      no\n');
  assert.equal(parsed.pages, 3);
  assert.equal(parsed.width, 595.276);
  assert.equal(parsed.height, 841.89);
  assert.equal(parsed.encrypted, false);
});

test('parseBboxWords reads pdftotext -bbox words and decodes entities', () => {
  const html = [
    '<page width="595.276" height="841.89">',
    '<word xMin="90.0" yMin="100.5" xMax="130.0" yMax="112.5">Hello</word>',
    '<word xMin="132.0" yMin="100.5" xMax="170.0" yMax="112.5">a&amp;b</word>',
    '</page>',
  ].join('');
  const words = parseBboxWords(html);
  assert.equal(words.length, 2);
  assert.deepEqual(words[0], { text: 'Hello', x: 90, y: 100.5, w: 40, h: 12 });
  assert.equal(words[1].text, 'a&b');
});

test('findQuoteBox returns the union of the matched words', () => {
  const words = [
    { text: 'Hello', x: 10, y: 20, w: 30, h: 10 },
    { text: 'world', x: 45, y: 20, w: 28, h: 10 },
    { text: 'again', x: 80, y: 20, w: 30, h: 10 },
  ];
  const box = findQuoteBox(words, 'Hello world');
  assert.deepEqual(box, { x: 10, y: 20, w: 63, h: 10 });
  assert.equal(findQuoteBox(words, 'missing text'), undefined);
  assert.equal(findQuoteBox(words, 'ab'), undefined, 'quotes under 4 characters are refused');
});

test('clampPage and clampDpi bound model input', () => {
  assert.equal(clampPage(0), 1);
  assert.equal(clampPage('7.4'), 7);
  assert.equal(clampPage(Number.NaN), 1);
  assert.equal(clampDpi(0), 120);
  assert.equal(clampDpi(10), 36);
  assert.equal(clampDpi(10_000), 600);
});

test('probeRenderTools finds tools in texBinDir and reports capability', async (t) => {
  const dir = await tempDir(t);
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const exe = process.platform === 'win32' ? '.exe' : '';
  await writeFile(path.join(bin, `pdftoppm${exe}`), '');
  await writeFile(path.join(bin, `pdftotext${exe}`), '');
  await writeFile(path.join(bin, `pdfinfo${exe}`), '');
  const tools = await probeRenderTools({ texBinDir: bin }, { extraDirs: [], refresh: true });
  assert.equal(tools.pdftoppm, path.join(bin, `pdftoppm${exe}`));
  assert.equal(tools.pdftotext, path.join(bin, `pdftotext${exe}`));
  const capability = renderCapability(tools);
  assert.equal(capability.canRender, true);
  assert.equal(capability.canExtractText, true);
  assert.equal(capability.engine, 'pdftoppm');
});

test('probeRenderTools reports no renderer when nothing is installed', async (t) => {
  const dir = await tempDir(t);
  const tools = await probeRenderTools({ texBinDir: dir }, { extraDirs: [], refresh: true, includePath: false });
  const capability = renderCapability(tools);
  assert.equal(capability.canRender, false);
  assert.equal(capability.canExtractText, false);
});

test('runTool captures stdout and exit code without a shell', async () => {
  const result = await runTool([process.execPath, '-e', "process.stdout.write('hello')"], {
    timeoutMs: 20_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
});

test('renderPageToPng refuses missing PDFs and missing renderers', async (t) => {
  const dir = await tempDir(t);
  const missing = await renderPageToPng(
    { pdftoppm: process.execPath },
    { pdfPath: path.join(dir, 'missing.pdf'), outPath: path.join(dir, 'page.png'), page: 1 },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_PDF');
  const noRenderer = await renderPageToPng(
    {},
    { pdfPath: path.join(dir, 'missing.pdf'), outPath: path.join(dir, 'page.png'), page: 1 },
  );
  assert.equal(noRenderer.ok, false);
  assert.equal(noRenderer.code, 'NO_PDF');
});

test('look cache paths, pruning and previous lookup', async (t) => {
  const stateDir = await tempDir(t);
  const first = lookCacheDir(stateDir, 'a'.repeat(64));
  const second = lookCacheDir(stateDir, 'b'.repeat(64));
  assert.match(first, /look[\\/]+a{16}$/);
  assert.match(lookPagePath(first, 3, 120), /page-3-d120\.png$/);
  assert.match(
    lookPagePath(first, 3, 120, { x: 1, y: 2, w: 3, h: 4 }),
    /page-3-d120-c1_2_3_4\.png$/,
  );
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(lookPagePath(first, 1, 120), 'old');
  const old = new Date(Date.now() - 60_000);
  await utimes(first, old, old);
  const previous = await previousLookPage(stateDir, second, 1, 120);
  assert.equal(previous, lookPagePath(first, 1, 120));
  const caches = await listLookCaches(stateDir);
  assert.equal(caches.length, 2);
  await pruneLookCaches(stateDir, 1);
  const after = await listLookCaches(stateDir);
  assert.equal(after.length, 1);
});

test('sha256File hashes file contents', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'abc');
  const hash = await sha256File(file);
  assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256File(path.join(dir, 'missing')), undefined);
});
