import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AnnotationError, AnnotationStore, annotationImageDir } from '../src/annotations.js';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS_MODULE = pathToFileURL(path.resolve(HERE, '../src/annotations.js')).href;

async function setup(t, config = {}) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-ann-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'build', '.dsh-latex');
  await mkdir(stateDir, { recursive: true });
  const project = {
    id: 'p_test',
    mainFile: path.join(dir, 'main.tex'),
    previewVersion: 10,
    paths: { stateDir, fingerprint: 'abc123' },
  };
  return { dir, stateDir, project, store: new AnnotationStore(config) };
}

test('creates, lists and resolves annotations atomically', async (t) => {
  const { project, store } = await setup(t);
  const item = await store.create(project, {
    page: 2,
    quote: 'The quick brown fox',
    comment: 'check this',
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
  });
  assert.match(item.id, /^a[0-9a-f]{12}$/);
  assert.equal(item.status, 'open');
  assert.equal(item.buildVersion, 10);

  const listed = await store.list(project, { buildVersion: 10 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.counts.open, 1);

  await store.update(project, { id: item.id, status: 'resolved', comment: 'done' });
  const after = await store.list(project, { buildVersion: 10 });
  assert.equal(after.items[0].status, 'resolved');
  assert.equal(after.items[0].comment, 'done');

  const cleared = await store.clear(project);
  assert.equal(cleared.removed, 1);
  const empty = await store.list(project, { buildVersion: 10 });
  assert.equal(empty.items.length, 0);
});

test('re-anchors across rebuilds and marks unfindable quotes stale', async (t) => {
  const { project, store } = await setup(t);
  const first = await store.create(project, { page: 1, quote: 'alpha beta gamma' });
  const second = await store.create(project, { page: 4, quote: 'cannot find me' });
  project.previewVersion = 11;
  const listed = await store.list(project, {
    buildVersion: 11,
    reanchor: async ({ quote, page }) => {
      if (quote.includes('alpha')) return { page: 3, rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.05 }] };
      return undefined;
    },
  });
  const alpha = listed.items.find((item) => item.id === first.id);
  const missing = listed.items.find((item) => item.id === second.id);
  assert.equal(alpha.page, 3);
  assert.deepEqual(alpha.rects, [{ x: 0.2, y: 0.3, w: 0.4, h: 0.05 }]);
  assert.equal(alpha.status, 'open');
  assert.equal(alpha.buildVersion, 11);
  assert.equal(missing.status, 'stale');
  assert.match(missing.staleReason, /not found/i);
});

test('enforces quote, page and rect bounds', async (t) => {
  const { project, store } = await setup(t);
  await assert.rejects(store.create(project, { page: 0, quote: 'x' }), /page/);
  await assert.rejects(store.create(project, { page: 1, quote: 'x'.repeat(4001) }), /too long/);
  const item = await store.create(project, {
    page: 1,
    quote: 'x',
    rects: [{ x: -1, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0.5, w: 9, h: 9 }],
  });
  assert.deepEqual(item.rects, [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }]);
  await assert.rejects(store.update(project, { id: 'nope', status: 'resolved' }), /id is invalid/);
});

test('enforces the item limit and configurable caps', async (t) => {
  const { project, store } = await setup(t, { annotationsMaxItems: 2 });
  await store.create(project, { page: 1, quote: 'one' });
  await store.create(project, { page: 1, quote: 'two' });
  await assert.rejects(store.create(project, { page: 1, quote: 'three' }), /already has 2 annotations/);
});

test('a corrupt annotations file is backed up and reported, not fatal', async (t) => {
  const { project, store } = await setup(t);
  const file = store.fileFor(project);
  await writeFile(file, '{not json');
  const listed = await store.list(project, { buildVersion: 10 });
  assert.equal(listed.corrupt, true);
  assert.equal(listed.items.length, 0);
  const files = await readdir(path.dirname(file));
  assert.ok(files.some((name) => name.includes('.corrupt-')));
  const created = await store.create(project, { page: 1, quote: 'after corruption' });
  assert.equal(created.status, 'open');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.items.length, 1);
});

test('clear all removes the store file', async (t) => {
  const { project, store } = await setup(t);
  await store.create(project, { page: 1, quote: 'one' });
  await store.create(project, { page: 2, quote: 'two' });
  const result = await store.clear(project, { all: true });
  assert.equal(result.remaining, 0);
  const listed = await store.list(project, { buildVersion: 10 });
  assert.equal(listed.items.length, 0);
});

test('rejects invalid update payloads', async (t) => {
  const { project, store } = await setup(t);
  const item = await store.create(project, { page: 1, quote: 'one' });
  await assert.rejects(store.update(project, { id: item.id, status: 'bogus' }), AnnexErrorPredicate);
  await assert.rejects(store.update(project, { id: 'a000000000000', status: 'resolved' }), /not found/);
});

function AnnexErrorPredicate(error) {
  return error instanceof AnnotationError && error.code === 'BAD_INPUT';
}

test('remove deletes one annotation, its screenshot and leaves the rest', async (t) => {
  const { project, store } = await setup(t);
  const imageDir = annotationImageDir(project);
  await mkdir(imageDir, { recursive: true });
  const imageName = 'shot-1.png';
  await writeFile(path.join(imageDir, imageName), 'PNG-BYTES');
  const withImage = await store.create(project, { page: 1, image: imageName, comment: 'scan' });
  const other = await store.create(project, { page: 2, quote: 'keep me' });
  assert.equal(withImage.anchor, 'image');
  const result = await store.remove(project, withImage.id);
  assert.equal(result.removed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(await stat(path.join(imageDir, imageName)).catch(() => undefined), undefined);
  const listed = await store.list(project, { buildVersion: 10 });
  assert.deepEqual(listed.items.map((item) => item.id), [other.id]);
});

test('an image-only annotation survives a rebuild as best-effort', async (t) => {
  const { project, store } = await setup(t);
  const imageDir = annotationImageDir(project);
  await mkdir(imageDir, { recursive: true });
  await writeFile(path.join(imageDir, 'shot-2.png'), 'PNG-BYTES');
  const item = await store.create(project, { page: 3, image: 'shot-2.png' });
  project.previewVersion = 11;
  const listed = await store.list(project, { buildVersion: 11 });
  const after = listed.items.find((entry) => entry.id === item.id);
  assert.equal(after.status, 'open');
  assert.equal(after.page, 3);
  assert.match(after.reanchorNote, /best-effort/);
});

test('a stale annotation lock is reclaimed', async (t) => {
  const { project, store } = await setup(t, {
    annotationsLockWaitMs: 500,
    annotationsLockStaleMs: 1000,
  });
  const file = store.fileFor(project);
  const lock = `${file}.lock`;
  await writeFile(lock, 'stale');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const item = await store.create(project, { page: 1, quote: 'after stale lock' });
  assert.equal(item.status, 'open');
  assert.equal(await stat(lock).catch(() => undefined), undefined);
});

test('a live lock makes the writer wait, then fail with a retryable error', async (t) => {
  const { project, store } = await setup(t, {
    annotationsLockWaitMs: 300,
    annotationsLockStaleMs: 30_000,
  });
  const lock = `${store.fileFor(project)}.lock`;
  await writeFile(lock, 'live');
  const started = Date.now();
  await assert.rejects(
    store.create(project, { page: 1, quote: 'blocked' }),
    (error) => error instanceof AnnotationError && error.code === 'ANNOTATIONS_BUSY' && error.status === 503,
  );
  assert.ok(Date.now() - started >= 250, 'it waited for the configured window');
  await rm(lock, { force: true });
});

test('two processes append annotations without losing entries', async (t) => {
  const { project, store } = await setup(t);
  const childCode = `
    import { AnnotationStore } from ${JSON.stringify(ANNOTATIONS_MODULE)};
    const project = JSON.parse(process.argv[1]);
    const store = new AnnotationStore({ annotationsLockWaitMs: 15000, annotationsLockStaleMs: 30000 });
    for (let i = 0; i < 8; i += 1) {
      await store.create(project, { page: 1, quote: 'child ' + process.pid + ' item ' + i });
    }
  `;
  const runChild = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify(project)], {
        cwd: path.resolve(HERE, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}: ${stderr}`))));
    });
  await Promise.all([runChild(), runChild()]);
  const listed = await store.list(project, { buildVersion: 10 });
  assert.equal(listed.items.length, 16);
  const raw = JSON.parse(await readFile(store.fileFor(project), 'utf8'));
  assert.equal(raw.items.length, 16);
  assert.equal(await stat(`${store.fileFor(project)}.lock`).catch(() => undefined), undefined);
});
