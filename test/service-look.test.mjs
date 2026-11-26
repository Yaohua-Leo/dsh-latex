import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LatexService } from '../src/service.js';
import { normalizeConfig } from '../src/config.js';
import { registerLatexTools } from '../src/tools.js';
import { encodePng } from './png-helper.mjs';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function tempDir(t) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeContext({ sessionController, attachments, tools } = {}) {
  return {
    get(name) {
      if (name === 'sessionController') return sessionController;
      if (name === 'attachments') return attachments;
      if (name === 'tools') return tools;
      if (name === 'workingDirectory') return undefined;
      return undefined;
    },
    logger() {
      return logger;
    },
  };
}

function fakeProject(dir) {
  const stateDir = path.join(dir, 'build', '.dsh-latex');
  return {
    id: 'p_test',
    rootDir: dir,
    mainFile: path.join(dir, 'main.tex'),
    previewVersion: 7,
    previewPages: 1,
    paths: {
      buildDirAbs: path.join(dir, 'build'),
      stateDir,
      stem: 'main',
      fingerprint: 'render01',
      pdfPath: path.join(dir, 'build', 'main.pdf'),
      previewPath: path.join(stateDir, 'preview-render01.pdf'),
      metaPath: path.join(stateDir, 'last-build-render01.json'),
      logPath: path.join(dir, 'build', 'main.log'),
    },
  };
}

function fakeBuilder(tools) {
  return {
    async checkToolchain() {
      return { ok: true, latexmk: 'latexmk', binDir: '', tools: {} };
    },
    renderTools: tools,
  };
}

test('askFromSelection composes the quote and calls sessionController.prompt', async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const ctx = fakeContext({
    sessionController: {
      async resolveAgent() {
        return {};
      },
      async prompt(request, signal) {
        calls.push({ request, aborted: signal?.aborted ?? false });
        return { accepted: true };
      },
    },
  });
  const config = normalizeConfig({});
  const service = new LatexService(ctx, config, fakeBuilder(), {}, logger);
  const project = fakeProject(dir);
  const result = await service.askFromSelection({
    sessionId: 'session-abc',
    project,
    page: 3,
    quote: 'a quoted paragraph',
    question: 'Why is this wrong?',
    source: { file: path.join(dir, 'main.tex'), line: 42 },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { request } = calls[0];
  assert.equal(request.sessionId, 'session-abc');
  assert.equal(request.mode, 'queue');
  assert.match(request.content[0].text, /a quoted paragraph/);
  assert.match(request.content[0].text, /Why is this wrong\?/);
  assert.match(request.content[0].text, /第 3 页/);
  assert.ok(request.content[0].text.includes(`项目：${dir}`), 'message names the project root');
  assert.match(request.content[0].text, /main\.tex:42/);
});

test('askFromSelection reports missing session service and invalid ids', async (t) => {
  const dir = await tempDir(t);
  const service = new LatexService(fakeContext(), normalizeConfig({}), fakeBuilder(), {}, logger);
  await assert.rejects(service.askFromSelection({ sessionId: 'bad id!', quote: 'x' }), /sessionId is invalid/);
  await assert.rejects(
    service.askFromSelection({ sessionId: 'session-abc', quote: 'x', project: fakeProject(dir) }),
    (error) => error.status === 503 && /session controller/.test(error.message),
  );
});

test('latex_look tool attaches the rendered page as an image block', async (t) => {
  const dir = await tempDir(t);
  const pngPath = path.join(dir, 'page.png');
  const png = encodePng({ width: 2, height: 1, colorType: 6, channels: 4, rows: [[1, 2, 3, 255, 4, 5, 6, 255]] });
  await writeFile(pngPath, png);
  const saved = [];
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    attachments: {
      async saveImages(images) {
        saved.push(...images);
        return images.map((image, index) => ({ id: `att-${index}`, mediaType: image.mediaType }));
      },
    },
  });
  const config = normalizeConfig({});
  const service = {
    async ensureProject() {
      return fakeProject(dir);
    },
    async look() {
      return {
        ok: true,
        projectId: 'p_test',
        mainFile: path.join(dir, 'main.tex'),
        rootDir: dir,
        page: 2,
        pages: 3,
        dpi: 120,
        engine: 'pdftoppm',
        cached: false,
        pngPath,
        text: { found: true, page: 2, box: { x: 10, y: 20, w: 30, h: 10 } },
        diff: { comparable: true, changed: 4, ratio: 0.02, box: { x: 1, y: 2, w: 3, h: 4 } },
        source: { ok: true, relativeFile: 'main.tex', line: 12 },
        capability: { canRender: true, canExtractText: true, engine: 'pdftoppm' },
      };
    },
  };
  const dispose = registerLatexTools(ctx, service, config);
  const look = registered.find((definition) => definition.name === 'latex_look');
  assert.ok(look, 'latex_look is registered');
  const value = await look.execute({ project: 'p_test' }, { signal: undefined });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.equal(value.image.id, 'att-0');
  const blocks = look.output.render({}, value);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /page 2\/3/);
  assert.match(blocks[1].text, /main\.tex:12/);
  assert.match(blocks[1].text, /diff vs previous build: 4 px/);
  dispose();
});

test('latex_look degrades to a path when attachments are unavailable', async (t) => {
  const dir = await tempDir(t);
  const pngPath = path.join(dir, 'page.png');
  await writeFile(
    pngPath,
    encodePng({ width: 1, height: 1, colorType: 6, channels: 4, rows: [[0, 0, 0, 255]] }),
  );
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  });
  const service = {
    async ensureProject() {
      return fakeProject(dir);
    },
    async look() {
      return {
        ok: true,
        page: 1,
        pages: 1,
        dpi: 120,
        engine: 'pdftoppm',
        cached: true,
        pngPath,
        source: { ok: false, message: 'SyncTeX unavailable' },
        diff: { comparable: false, reason: 'size-changed' },
      };
    },
  };
  const dispose = registerLatexTools(ctx, service, normalizeConfig({}));
  const look = registered.find((definition) => definition.name === 'latex_look');
  const value = await look.execute({}, {});
  assert.equal(value.image, undefined);
  assert.match(value.text, /attachment service is unavailable/);
  assert.match(value.text, /not comparable/);
  dispose();
});

test('latex_annotations lists and resolves through the service', async (t) => {
  const dir = await tempDir(t);
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  });
  const items = [
    { id: 'a0123456789ab', page: 1, quote: 'one', comment: 'first', status: 'open' },
    { id: 'a0123456789cd', page: 2, quote: 'two', comment: '', status: 'stale' },
  ];
  const resolved = [];
  const service = {
    async ensureProject() {
      return fakeProject(dir);
    },
    async listAnnotations() {
      return {
        ok: true,
        mainFile: path.join(dir, 'main.tex'),
        buildVersion: 7,
        counts: { total: 2, open: 1, resolved: 0, stale: 1 },
        reanchorAvailable: true,
        items,
      };
    },
    async updateAnnotation(project, input) {
      resolved.push(input);
      return { ...items[0], status: 'resolved' };
    },
    async clearAnnotations() {
      return { removed: 1, remaining: 1 };
    },
  };
  const dispose = registerLatexTools(ctx, service, normalizeConfig({}));
  const annotations = registered.find((definition) => definition.name === 'latex_annotations');
  const listed = await annotations.execute({ action: 'list' }, {});
  assert.match(listed, /open 1 \| stale 1/);
  assert.match(listed, /a0123456789ab p1 \[open\] "one"/);
  const resolvedText = await annotations.execute(
    { action: 'resolve', ids: ['a0123456789ab'] },
    {},
  );
  assert.deepEqual(resolved, [{ id: 'a0123456789ab', status: 'resolved' }]);
  assert.match(resolvedText, /resolved 1 of 1/);
  const cleared = await annotations.execute({ action: 'clear' }, {});
  assert.match(cleared, /removed 1, 1 remaining/);
  dispose();
});

test('askImage sends a text + image prompt and skips unavailable OCR', async (t) => {
  const dir = await tempDir(t);
  const prompts = [];
  const ctx = fakeContext({
    sessionController: {
      async resolveAgent() {
        return {};
      },
      async prompt(request) {
        prompts.push(request);
        return { accepted: true };
      },
    },
  });
  const service = new LatexService(ctx, normalizeConfig({}), fakeBuilder(), {}, logger);
  const png = encodePng({ width: 2, height: 1, colorType: 6, channels: 4, rows: [[1, 2, 3, 255, 4, 5, 6, 255]] });
  const result = await service.askImage({
    sessionId: 'session-image',
    project: fakeProject(dir),
    page: 2,
    question: 'What does this diagram show?',
    image: `data:image/png;base64,${png.toString('base64')}`,
  });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 1);
  const content = prompts[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /What does this diagram show\?/);
  assert.match(content[0].text, /第 2 页/);
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].mediaType, 'image/png');
  assert.ok(content[1].data.length > 20);
  assert.equal(result.ocr, undefined, 'no tesseract on this machine -> no OCR hint');
});

test('askImage rejects invalid or oversized images', async (t) => {
  const dir = await tempDir(t);
  const service = new LatexService(fakeContext(), normalizeConfig({ askImageMaxBytes: 65_536 }), fakeBuilder(), {}, logger);
  await assert.rejects(
    service.askImage({ sessionId: 'session-image', project: fakeProject(dir), image: 'not-base64' }),
    /image must be/,
  );
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(70_000)]);
  await assert.rejects(
    service.askImage({
      sessionId: 'session-image',
      project: fakeProject(dir),
      image: `data:image/jpeg;base64,${big.toString('base64')}`,
    }),
    /image must be/,
  );
});

test('createAnnotation stores a screenshot and a best-effort item', async (t) => {
  const dir = await tempDir(t);
  const ctx = fakeContext();
  const service = new LatexService(ctx, normalizeConfig({ ocrEnabled: 'off' }), fakeBuilder(), {}, logger);
  const project = fakeProject(dir);
  const png = encodePng({ width: 2, height: 2, colorType: 6, channels: 4, rows: [[1, 2, 3, 255, 4, 5, 6, 255], [7, 8, 9, 255, 10, 11, 12, 255]] });
  const item = await service.createAnnotation(project, {
    page: 1,
    image: `data:image/png;base64,${png.toString('base64')}`,
    comment: 'scan region',
    rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
  });
  assert.match(item.id, /^a[0-9a-f]{12}$/);
  assert.match(item.image, /^[0-9a-f-]+\.png$/);
  assert.equal(item.anchor, 'image');
  assert.equal(item.quote, '');
  const imagePath = path.join(project.paths.stateDir, 'annotation-images', item.image);
  assert.ok((await stat(imagePath)).isFile(), 'screenshot is stored');
  const listed = await service.listAnnotations(project);
  assert.equal(listed.items.length, 1);
  const removed = await service.clearAnnotations(project, { all: true });
  assert.equal(removed.removed, 1);
  assert.equal(await stat(imagePath).catch(() => undefined), undefined);
});

test('latex_audit tool attaches side-by-side images and formats the summary', async (t) => {
  const dir = await tempDir(t);
  const pngPath = path.join(dir, 'audit-1.png');
  const png = encodePng({ width: 3, height: 1, colorType: 6, channels: 4, rows: [[1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]] });
  await writeFile(pngPath, png);
  const saved = [];
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    attachments: {
      async saveImages(images) {
        saved.push(...images);
        return images.map((image, index) => ({ id: `audit-att-${index}`, mediaType: image.mediaType }));
      },
    },
  });
  const service = {
    async ensureProject() {
      return fakeProject(dir);
    },
    async audit() {
      return {
        ok: true,
        previous: true,
        identical: false,
        pages: 3,
        previousPages: 3,
        from: 1,
        to: 3,
        dpi: 100,
        truncated: false,
        changed: [
          {
            page: 2,
            status: 'changed',
            changed: 42,
            ratio: 0.01,
            box: { x: 10, y: 20, w: 30, h: 40 },
            source: { file: path.join(dir, 'main.tex'), line: 12 },
            imagePath: pngPath,
          },
        ],
        added: [],
        removed: [],
        failed: [],
        images: [{ page: 2, path: pngPath }],
      };
    },
  };
  const dispose = registerLatexTools(ctx, service, normalizeConfig({}));
  const audit = registered.find((definition) => definition.name === 'latex_audit');
  assert.ok(audit, 'latex_audit is registered');
  const value = await audit.execute({}, {});
  assert.equal(saved.length, 1);
  assert.equal(value.images.length, 1);
  const blocks = audit.output.render({}, value);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /changed: 1/);
  assert.match(blocks[1].text, /page 2: 42 px changed/);
  assert.match(blocks[1].text, /main\.tex:12/);
  dispose();
});

test('latex_annotations remove deletes one item through the service', async (t) => {
  const dir = await tempDir(t);
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  });
  const removed = [];
  const service = {
    async ensureProject() {
      return fakeProject(dir);
    },
    async removeAnnotation(project, id) {
      removed.push(id);
      return { removed: 1, remaining: 0 };
    },
  };
  const dispose = registerLatexTools(ctx, service, normalizeConfig({}));
  const annotations = registered.find((definition) => definition.name === 'latex_annotations');
  const text = await annotations.execute({ action: 'remove', id: 'a0123456789ab' }, {});
  assert.deepEqual(removed, ['a0123456789ab']);
  assert.match(text, /removed 1, 0 remaining/);
  dispose();
});

test('paper checks collect sources, citations, bib issues and layout warnings', async (t) => {
  const dir = await tempDir(t);
  const project = fakeProject(dir);
  await mkdir(project.paths.buildDirAbs, { recursive: true });
  await writeFile(
    path.join(dir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\cite{known,missing}\n\\section{One}\n\\end{document}\n',
  );
  await writeFile(
    path.join(dir, 'refs.bib'),
    '@article{known, title={Known}, author={A. Author}, journal={J}, year={2020}}\n@article{unused, title={Unused}}\n',
  );
  await writeFile(
    path.join(project.paths.buildDirAbs, 'main.aux'),
    '\\newlabel{fig:one}{{1}{1}}\n\\newlabel{tab:one}{{1}{2}}\n',
  );
  await writeFile(project.paths.logPath, 'Overfull \\hbox (10.0pt too wide) in paragraph at lines 3--4\n');
  const config = normalizeConfig({ layoutRules: [{ pattern: 'TODO', message: 'resolve TODO', target: 'log' }] });
  const service = new LatexService(fakeContext(), config, fakeBuilder(), {}, logger);
  await writeFile(project.paths.logPath, 'Overfull \\hbox (10.0pt too wide) in paragraph at lines 3--4\nTODO finish\n');
  const citations = await service.citationAudit(project);
  assert.deepEqual(citations.missing, ['missing']);
  assert.deepEqual(citations.neverCited, ['unused']);
  const bib = await service.bibliographyLint(project);
  assert.ok(bib.issues.some((issue) => issue.code === 'missing-field' && issue.key === 'unused'));
  const layout = await service.layoutCheck(project);
  assert.equal(layout.figures.length, 1);
  assert.equal(layout.tables.length, 1);
  assert.ok(layout.issues.some((issue) => issue.code === 'overfull-hbox'));
  assert.ok(layout.issues.some((issue) => issue.code === 'custom-rule'));
});

test('toolchain status exposes the platform default and stays idle without an install', (t) => {
  const service = new LatexService(fakeContext(), normalizeConfig({}), fakeBuilder(), {}, logger);
  const status = service.toolchainStatus();
  assert.equal(status.ok, true);
  assert.equal(status.state, 'idle');
  assert.match(status.defaultUrl, /TinyTeX/);
  assert.equal(typeof status.platform, 'string');
});

test('paper check tools are registered and format real service results', async (t) => {
  const dir = await tempDir(t);
  const project = fakeProject(dir);
  await writeFile(
    path.join(dir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\cite{missing}\n\\end{document}\n',
  );
  await writeFile(path.join(dir, 'refs.bib'), '@article{present, title={Present}}\n');
  const registered = [];
  const ctx = fakeContext({
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  });
  const service = new LatexService(ctx, normalizeConfig({}), fakeBuilder(), {}, logger);
  service.ensureProject = async () => project;
  const dispose = registerLatexTools(ctx, service, normalizeConfig({}));
  const tool = registered.find((definition) => definition.name === 'latex_cite_audit');
  assert.ok(tool, 'latex_cite_audit is registered');
  const text = await tool.execute({ project: 'p_test' }, { signal: undefined });
  assert.match(text, /missing from bib: 1/);
  assert.match(text, /missing/);
  assert.match(text, /present/);
  dispose();
});
