/**
 * End-to-end check for the two preview features.
 *
 * This script is intentionally not part of `npm test`: it needs a real TeX
 * distribution and Poppler. It copies the bundled examples into a temporary
 * directory, compiles them with latexmk, and then exercises the actual
 * rendering / text-anchor / diff / annotation / look paths against those PDFs.
 *
 *   node test/e2e.mjs
 *
 * Environment:
 *   DSH_LATEX_TEX_BIN   directory containing latexmk/pdftoppm (optional)
 *   DSH_LATEX_TEST_TMP  where temporary projects are created (default: os tmp)
 *
 * Exits 0 with a SKIP message when latexmk is not installed, so a contributor
 * without TeX still gets a green `node test/e2e.mjs`; CI installs TeX.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.js';
import { LatexService } from '../src/service.js';
import { decodePng, diffPngs, encodePng } from '../src/png.js';
import {
  listLookCaches,
  locateQuote,
  pdfPageCount,
  probeRenderTools,
  renderPageToPng,
} from '../src/render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

async function findLatexmk() {
  const dirs = [
    process.env.DSH_LATEX_TEX_BIN,
    ...String(process.env.PATH ?? '').split(path.delimiter),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, executableName('latexmk'));
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

function run(argv, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      reject(new Error(`timeout after ${timeoutMs} ms: ${argv.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const text = Buffer.concat([...out, ...err]).toString('utf8');
        reject(new Error(`exit ${code}: ${argv.join(' ')}\n${text.slice(-4000)}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

async function tempDir() {
  await mkdir(TEST_TMP, { recursive: true });
  return mkdtemp(path.join(TEST_TMP, 'dsh-latex-e2e-'));
}

function latexmkArgv(latexmk, engine = '-xelatex') {
  return [
    latexmk,
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    '-recorder',
    '-outdir=build',
    engine,
    'main.tex',
  ];
}

function buildEnv(texBin) {
  return {
    ...process.env,
    PATH: [texBin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
  };
}

async function compileExample(latexmk, texBin, sourceDir, parentDir, { engine } = {}) {
  const name = path.basename(sourceDir);
  const target = path.join(parentDir, name);
  await cp(sourceDir, target, { recursive: true });
  await run(latexmkArgv(latexmk, engine), { cwd: target, env: buildEnv(texBin) });
  const pdf = path.join(target, 'build', 'main.pdf');
  assert.ok((await stat(pdf).catch(() => undefined))?.isFile(), `${name}: main.pdf was produced`);
  return { dir: target, pdf };
}

async function makeProject(dir) {
  const stateDir = path.join(dir, 'build', '.dsh-latex');
  await mkdir(stateDir, { recursive: true });
  return {
    id: 'p_e2e',
    rootDir: dir,
    mainFile: path.join(dir, 'main.tex'),
    engine: 'xelatex',
    previewVersion: 1,
    previewPages: undefined,
    status: 'success',
    building: false,
    queued: 0,
    paths: {
      buildDirAbs: path.join(dir, 'build'),
      stateDir,
      fingerprint: 'e2e',
      pdfPath: path.join(dir, 'build', 'main.pdf'),
      previewPath: path.join(stateDir, 'preview-e2e.pdf'),
      previousPath: path.join(stateDir, 'previous-e2e.pdf'),
      historyDir: path.join(stateDir, 'history'),
      historyIndexPath: path.join(stateDir, 'history', 'index.json'),
      metaPath: path.join(stateDir, 'last-build-e2e.json'),
      logPath: path.join(dir, 'build', 'main.log'),
    },
  };
}

async function publish(project, reason = 'manual') {
  const prior = await stat(project.paths.previewPath).catch(() => undefined);
  if (prior?.isFile() && prior.size > 0) {
    await cp(project.paths.previewPath, project.paths.previousPath);
  }
  const version = Date.now();
  const historyDir = path.join(project.paths.stateDir, 'history');
  await mkdir(historyDir, { recursive: true });
  const filename = `build-${version}.pdf`;
  await cp(project.paths.pdfPath, path.join(historyDir, filename));
  let entries = [];
  try {
    const parsed = JSON.parse(await readFile(path.join(historyDir, 'index.json'), 'utf8'));
    if (Array.isArray(parsed?.entries)) entries = parsed.entries;
  } catch {
    entries = [];
  }
  entries = [
    {
      version,
      builtAt: new Date().toISOString(),
      reason,
      engine: 'xelatex',
      durationMs: 0,
      manual: reason !== 'auto',
      mainFile: project.mainFile,
      pdf: filename,
    },
    ...entries,
  ].slice(0, 5);
  await writeFile(path.join(historyDir, 'index.json'), JSON.stringify({ schema: 1, entries }, null, 2));
  await cp(project.paths.pdfPath, project.paths.previewPath);
  project.previewVersion = version;
}

function serviceFor(texBin, latexmk) {
  const builder = {
    async checkToolchain() {
      return { ok: true, latexmk, binDir: texBin, tools: {} };
    },
  };
  const ctx = { get: () => undefined, logger: () => logger };
  const service = new LatexService(ctx, normalizeConfig({ texBinDir: texBin }), builder, {}, logger);
  const synctex = path.join(texBin, executableName('synctex'));
  // Use the real SyncTeX binary so the source-line assertion exercises the
  // same inverse lookup the Host performs, not a fixed answer.
  service.syncTeXResult = async (project, args) => {
    if (args.direction !== 'inverse') return { ok: false, direction: 'forward', message: 'not used' };
    try {
      const output = await run(
        [synctex, 'edit', '-o', `${args.page}:${args.x}:${args.y}:${project.paths.pdfPath}`],
        { cwd: project.rootDir, env: buildEnv(texBin), timeoutMs: 15_000 },
      );
      const input = /Input:([^\r\n]+)/.exec(output)?.[1]?.trim();
      const line = /Line:(\d+)/.exec(output)?.[1];
      if (!input) return { ok: false, direction: 'inverse', message: 'no input' };
      const absolute = path.resolve(project.rootDir, input);
      return {
        ok: true,
        direction: 'inverse',
        file: absolute,
        relativeFile: path.relative(project.rootDir, absolute).replace(/\\/g, '/'),
        line: line !== undefined ? Number(line) : undefined,
      };
    } catch (error) {
      return { ok: false, direction: 'inverse', message: String(error?.message ?? error) };
    }
  };
  return service;
}

async function main() {
  const latexmk = await findLatexmk();
  if (!latexmk) {
    console.log('SKIP e2e: latexmk is not installed (set DSH_LATEX_TEX_BIN or install TeX Live).');
    return;
  }
  const texBin = process.env.DSH_LATEX_TEX_BIN || path.dirname(latexmk);
  const tools = await probeRenderTools(
    { texBinDir: texBin },
    { extraDirs: [path.dirname(latexmk), texBin], includePath: true, refresh: true },
  );
  assert.ok(tools.pdftoppm, 'pdftoppm is available');
  assert.ok(tools.pdftotext, 'pdftotext is available');

  const root = await tempDir();
  try {
    const hello = await compileExample(latexmk, texBin, path.join(REPO, 'examples', 'hello'), root);
    const chinese = await compileExample(latexmk, texBin, path.join(REPO, 'examples', 'chinese'), root);
    const multi = await compileExample(latexmk, texBin, path.join(REPO, 'examples', 'multi-file'), root);
    const pages = {
      hello: await pdfPageCount(tools, hello.pdf),
      chinese: await pdfPageCount(tools, chinese.pdf),
      multi: await pdfPageCount(tools, multi.pdf),
    };
    for (const [name, count] of Object.entries(pages)) {
      assert.ok(!count || count >= 1, `${name} has at least one page`);
    }
    console.log(`compiled examples: pages hello=${pages.hello}, chinese=${pages.chinese}, multi=${pages.multi}`);

    // 1. Direct render + decode.
    const renderDir = path.join(root, 'renders');
    await mkdir(renderDir, { recursive: true });
    const page1 = path.join(renderDir, 'hello-1.png');
    const rendered = await renderPageToPng(tools, { pdfPath: hello.pdf, outPath: page1, page: 1, dpi: 120 });
    assert.equal(rendered.ok, true, `render failed: ${rendered.message ?? ''}`);
    const image = decodePng(await readFile(page1));
    assert.ok(image.width >= 200 && image.height >= 200, `unexpected page size ${image.width}x${image.height}`);
    console.log(`rendered hello page 1: ${image.width}x${image.height}`);

    // 2. Text anchor: quote -> page + box.
    const located = await locateQuote(tools, hello.pdf, 'equation');
    assert.equal(located.ok, true, `quote not found: ${located.message ?? ''}`);
    assert.equal(located.page, 1);
    assert.ok(located.box && located.box.w > 0 && located.box.h > 0, 'quote has a bounding box');

    // 3. Identical renders diff to zero.
    const page1b = path.join(renderDir, 'hello-1b.png');
    const renderedAgain = await renderPageToPng(tools, { pdfPath: hello.pdf, outPath: page1b, page: 1, dpi: 120 });
    assert.equal(renderedAgain.ok, true);
    const same = diffPngs(await readFile(page1), await readFile(page1b));
    assert.equal(same.comparable, true);
    assert.equal(same.changed, 0);

    // 4. Chinese text extraction (CJK through pdftotext UTF-8).
    const chineseQuote = await locateQuote(tools, chinese.pdf, '中文段落');
    assert.equal(chineseQuote.ok, true, `CJK quote not found: ${chineseQuote.message ?? ''}`);

    // 5. Service look against a published preview, then a real rebuild diff.
    const project = await makeProject(hello.dir);
    await publish(project);
    const service = serviceFor(texBin, latexmk);
    const firstLook = await service.look(project, { page: 1, text: 'equation', compare: false });
    assert.equal(firstLook.ok, true, `look failed: ${firstLook.message ?? ''}`);
    assert.ok((await stat(firstLook.pngPath)).isFile(), 'look produced a png');
    assert.ok((await listLookCaches(project.paths.stateDir)).length >= 1, 'look cache exists');

    // Create an annotation against the first build; it must survive the rebuild.
    const created = await service.createAnnotation(project, {
      page: 1,
      quote: 'equation',
      comment: 'check this',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
    });
    assert.equal(created.status, 'open');

    const sourceFile = path.join(hello.dir, 'main.tex');
    const source = await readFile(sourceFile, 'utf8');
    await writeFile(sourceFile, source.replace('Hello from dsh-latex', 'Hello from dsh-latex EDITED'));
    await run(latexmkArgv(latexmk), { cwd: hello.dir, env: buildEnv(texBin) });
    await publish(project);

    const secondLook = await service.look(project, { page: 1, compare: true });
    assert.equal(secondLook.ok, true);
    assert.equal(secondLook.diff?.comparable, true, `diff not comparable: ${secondLook.diff?.reason ?? ''}`);
    assert.ok(secondLook.diff.changed > 0, 'an edited page differs from the previous build');

    // 6. Annotations are re-anchored by their quote after the rebuild.
    const listed = await service.listAnnotations(project);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.reanchorAvailable, true, 'pdftotext re-anchoring is available');
    assert.equal(listed.items[0].status, 'open', 'the quote still exists after the rebuild');
    assert.equal(listed.items[0].page, 1);
    const resolved = await service.updateAnnotation(project, { id: created.id, status: 'resolved' });
    assert.equal(resolved.status, 'resolved');
    const cleared = await service.clearAnnotations(project);
    assert.equal(cleared.removed, 1);

    // 7. Ask path with a fake session controller (no model call).
    const prompts = [];
    const askService = new LatexService(
      {
        get(name) {
          if (name === 'sessionController') {
            return {
              async resolveAgent() {
                return {};
              },
              async prompt(request) {
                prompts.push(request);
                return { accepted: true };
              },
            };
          }
          return undefined;
        },
        logger: () => logger,
      },
      normalizeConfig({ texBinDir: texBin }),
      {
        async checkToolchain() {
          return { ok: true, latexmk, binDir: texBin, tools: {} };
        },
      },
      {},
      logger,
    );
    askService.syncTeXResult = service.syncTeXResult;
    const asked = await askService.askFromSelection({
      sessionId: 'session-e2e',
      project,
      page: 1,
      quote: 'equation',
      question: 'What does this equation mean?',
    });
    assert.equal(asked.ok, true);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].content[0].text, /What does this equation mean\?/);
    assert.ok(
      prompts[0].content[0].text.includes(`项目：${hello.dir}`),
      'the message names the project root',
    );
    assert.match(
      prompts[0].content[0].text,
      /源码位置：.*main\.tex:\d+/,
      'the message carries an absolute source path',
    );
    assert.match(
      prompts[0].content[0].text,
      /main\.tex:11/,
      'the quote resolves to the section heading line, not a nearby equation',
    );

    // 8. Audit after editing the title again and adding a second page.
    const beforeAudit = await readFile(path.join(hello.dir, 'main.tex'), 'utf8');
    const withSecondPage = beforeAudit
      .replace('Hello from dsh-latex EDITED', 'Hello from dsh-latex AUDITED')
      .replace(
        '\\end{document}',
        '\\newpage\n\\section{Second page}\nThis page exists only in the new build.\n\\end{document}',
      );
    await writeFile(path.join(hello.dir, 'main.tex'), withSecondPage);
    await run(latexmkArgv(latexmk), { cwd: hello.dir, env: buildEnv(texBin) });
    await publish(project);
    const history = await service.history(project);
    assert.ok(history.entries.length >= 2, 'build history has entries');
    const audit = await service.audit(project, {
      against: 'last-manual',
      maxPages: 10,
      dpi: 100,
      maxImages: 3,
    });
    assert.equal(audit.ok, true, `audit failed: ${audit.message ?? ''}`);
    assert.equal(audit.previous, true);
    assert.equal(audit.baseline?.kind, 'history', 'last-manual resolves through history');
    assert.equal(audit.pages, 2);
    assert.equal(audit.previousPages, 1);
    assert.ok(audit.changed.some((entry) => entry.page === 1), 'page 1 changed');
    assert.ok(audit.added.some((entry) => entry.page === 2), 'page 2 was added');
    assert.ok(audit.images.length >= 1 && audit.images.length <= 3, 'bounded audit images');
    const auditImage = decodePng(await readFile(audit.images[0].path));
    assert.ok(auditImage.width > 10 && auditImage.height > 10, 'side-by-side composite is a real PNG');

    // 9. Screenshot question and screenshot annotation (no text layer needed).
    const imagePrompts = [];
    const imageService = new LatexService(
      {
        get(name) {
          if (name === 'sessionController') {
            return {
              async resolveAgent() {
                return {};
              },
              async prompt(request) {
                imagePrompts.push(request);
                return { accepted: true };
              },
            };
          }
          return undefined;
        },
        logger: () => logger,
      },
      normalizeConfig({ texBinDir: texBin, ocrEnabled: 'off' }),
      service.builder,
      {},
      logger,
    );
    const cropPng = encodePng({
      width: 2,
      height: 1,
      channels: 4,
      data: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]),
    });
    const cropDataUrl = `data:image/png;base64,${cropPng.toString('base64')}`;
    const askedImage = await imageService.askImage({
      sessionId: 'session-image',
      project,
      page: 2,
      question: 'What is shown in this cropped screenshot?',
      image: cropDataUrl,
    });
    assert.equal(askedImage.ok, true);
    assert.equal(imagePrompts.length, 1);
    const imageContent = imagePrompts[0].content;
    assert.equal(imageContent[0].type, 'text');
    assert.equal(imageContent[1].type, 'image');
    assert.equal(imageContent[1].mediaType, 'image/png');
    assert.ok(imageContent[1].data.length > 20);

    const imageAnnotation = await service.createAnnotation(project, {
      page: 2,
      image: cropDataUrl,
      comment: 'screenshot note',
      rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
    });
    assert.equal(imageAnnotation.anchor, 'image');
    assert.ok(imageAnnotation.image, 'screenshot filename is stored');
    const imageFile = path.join(project.paths.stateDir, 'annotation-images', imageAnnotation.image);
    assert.ok((await stat(imageFile)).isFile(), 'screenshot file is written');
    await service.removeAnnotation(project, imageAnnotation.id);
    assert.equal(await stat(imageFile).catch(() => undefined), undefined, 'screenshot file is removed');

    // 10. Concurrent renders of the same page must both succeed and leave no temp files.
    const concurrentA = path.join(renderDir, 'concurrent-a.png');
    const concurrentB = path.join(renderDir, 'concurrent-b.png');
    const [renderA, renderB] = await Promise.all([
      renderPageToPng(tools, { pdfPath: hello.pdf, outPath: concurrentA, page: 1, dpi: 100 }),
      renderPageToPng(tools, { pdfPath: hello.pdf, outPath: concurrentB, page: 1, dpi: 100 }),
    ]);
    assert.equal(renderA.ok, true);
    assert.equal(renderB.ok, true);
    const renderFiles = await readdir(renderDir);
    assert.ok(!renderFiles.some((name) => name.includes('.tmp-')), 'no temp render files remain');

    console.log('E2E OK: render, text anchor, diff, look, annotations, ask, audit, screenshot');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
