import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LatexBuilder } from '../src/build.js';
import { normalizeConfig } from '../src/config.js';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function tempDir(t) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject(dir) {
  const root = path.join(dir, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'main.tex'), 'hello\n');
  return root;
}

async function placeStalePdf(root, contents = 'STALE-PDF') {
  await mkdir(path.join(root, 'build'), { recursive: true });
  const file = path.join(root, 'build', 'main.pdf');
  await writeFile(file, contents);
  const old = new Date(Date.now() - 3_600_000);
  await utimes(file, old, old);
  return file;
}

function fakeSubprocess(plan) {
  const calls = [];
  return {
    calls,
    spawn(request) {
      calls.push(request);
      const buildDir = path.join(request.cwd, 'build');
      mkdirSync(buildDir, { recursive: true });
      if (plan.writeDvi === true) writeFileSync(path.join(buildDir, 'main.dvi'), 'DVI');
      if (plan.writePdf === true) {
        writeFileSync(path.join(buildDir, plan.pdfName ?? 'main.pdf'), plan.pdfContents ?? 'PDF-NEW');
      }
      if (plan.writeLog !== undefined) writeFileSync(path.join(buildDir, 'main.log'), plan.writeLog);
      return {
        done: Promise.resolve({ exitCode: plan.exitCode ?? 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: plan.stdout ?? '' }) },
          stderr: { readFrom: () => ({ text: plan.stderr ?? '' }) },
        },
      };
    },
  };
}

async function makeBuilder(dir, plan) {
  const latexmkPath = path.join(dir, process.platform === 'win32' ? 'latexmk.exe' : 'latexmk');
  await writeFile(latexmkPath, 'fake latexmk\n');
  const subprocess = fakeSubprocess(plan);
  const ctx = {
    get(name) { return name === 'subprocess' ? subprocess : undefined; },
    logger() { return logger; },
  };
  const config = normalizeConfig({ latexmkPath });
  return { builder: new LatexBuilder(ctx, config, logger), subprocess };
}

async function buildProject(builder, root, options = {}) {
  const resolution = { rootDir: root, mainFile: path.join(root, 'main.tex') };
  const paths = builder.projectPaths(resolution);
  const result = await builder.build(
    { ...resolution, engine: 'xelatex', paths },
    { reason: 'manual', ...options },
  );
  return { result, paths };
}

async function exists(file) {
  const info = await stat(file).catch(() => undefined);
  return info?.isFile() === true;
}

test('DVI-only latexmk run never publishes a stale PDF', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  await writeFile(path.join(root, '.latexmkrc'), '$pdf_mode = 0;\n');
  const stale = await placeStalePdf(root);
  const { builder } = await makeBuilder(dir, {
    writeDvi: true,
    writeLog: 'Output written on build/main.dvi (1 page, 996 bytes).\n',
    stdout:
      "Latexmk: Nothing to do for 'main.tex'.\n" +
      'Latexmk: All targets (build/main.dvi) are up-to-date\n',
  });

  const { result, paths } = await buildProject(builder, root);

  assert.equal(result.status, 'failure');
  assert.equal(result.pdfPath, undefined);
  assert.equal(result.previewPath, undefined);
  assert.match(result.error ?? '', /DVI mode|fresh PDF/i);
  assert.equal(await readFile(stale, 'utf8'), 'STALE-PDF');
  assert.equal(await exists(paths.previewPath), false);
  assert.equal(await exists(paths.metaPath), false);
});

test('a genuinely up-to-date PDF rebuild is still a success', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const current = await placeStalePdf(root, 'PDF-CURRENT');
  const { builder } = await makeBuilder(dir, {
    stdout:
      "Latexmk: Nothing to do for 'main.tex'.\n" +
      'Latexmk: All targets (build/main.xdv build/main.pdf) are up-to-date\n',
  });

  const { result, paths } = await buildProject(builder, root);

  assert.equal(result.status, 'success');
  assert.equal(result.upToDate, true);
  assert.equal(result.pdfPath, current);
  assert.ok(result.version > 0);
  assert.equal(await readFile(paths.previewPath, 'utf8'), 'PDF-CURRENT');
  assert.equal(await exists(paths.metaPath), true);
});

test('a fresh PDF is accepted even without an up-to-date target line', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const { builder } = await makeBuilder(dir, {
    writePdf: true,
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: This is Latexmk, John Collins, 15 June 2025. Version 4.87\n',
  });

  const { result, paths } = await buildProject(builder, root);

  assert.equal(result.status, 'success');
  assert.equal(result.upToDate, false);
  assert.equal(await readFile(paths.previewPath, 'utf8'), 'PDF-NEW');
});

test('an up-to-date target named by latexmk wins over a stale expected PDF', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const stale = await placeStalePdf(root);
  const { builder } = await makeBuilder(dir, {
    writePdf: true,
    pdfName: 'other.pdf',
    pdfContents: 'PDF-OTHER',
    writeLog: 'Output written on build/other.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: All targets (build/other.pdf) are up-to-date\n',
  });

  const { result, paths } = await buildProject(builder, root);

  assert.equal(result.status, 'success');
  assert.equal(result.pdfPath, path.join(paths.buildDirAbs, 'other.pdf'));
  assert.equal(await readFile(paths.previewPath, 'utf8'), 'PDF-OTHER');
  assert.equal(await readFile(stale, 'utf8'), 'STALE-PDF');
});

test('a stale log "Output written on .pdf" line alone is not fresh evidence', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  await placeStalePdf(root);
  await writeFile(
    path.join(root, 'build', 'main.log'),
    'Output written on build/main.pdf (1 page, 1234 bytes).\n',
  );
  const { builder } = await makeBuilder(dir, {
    writeDvi: true,
    stdout: 'Latexmk: All targets (build/main.dvi) are up-to-date\n',
  });

  const { result, paths } = await buildProject(builder, root);

  assert.equal(result.status, 'failure');
  assert.equal(result.pdfPath, undefined);
  assert.equal(await exists(paths.previewPath), false);
});

test('a successful rebuild keeps the previous preview for audit', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const first = await makeBuilder(dir, {
    writePdf: true,
    pdfContents: 'PDF-FIRST',
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: This is Latexmk\n',
  });
  const firstBuild = await buildProject(first.builder, root);
  assert.equal(firstBuild.result.status, 'success');
  assert.equal(await readFile(firstBuild.paths.previewPath, 'utf8'), 'PDF-FIRST');
  assert.equal(await exists(firstBuild.paths.previousPath), false);

  const second = await makeBuilder(dir, {
    writePdf: true,
    pdfContents: 'PDF-SECOND',
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: This is Latexmk\n',
  });
  const secondBuild = await buildProject(second.builder, root);
  assert.equal(secondBuild.result.status, 'success');
  assert.equal(await readFile(secondBuild.paths.previewPath, 'utf8'), 'PDF-SECOND');
  assert.equal(await readFile(secondBuild.paths.previousPath, 'utf8'), 'PDF-FIRST');
});

test('cleaning the preview also removes the retained previous build', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const first = await makeBuilder(dir, {
    writePdf: true,
    pdfContents: 'PDF-FIRST',
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: This is Latexmk\n',
  });
  const firstBuild = await buildProject(first.builder, root);
  await writeFile(firstBuild.paths.previousPath, 'PDF-PREVIOUS');
  await first.builder.clean(
    { paths: firstBuild.paths },
    { includePreview: true },
  );
  assert.equal(await exists(firstBuild.paths.previousPath), false);
  assert.equal(await exists(firstBuild.paths.previewPath), false);
});

test('force mode still passes -gg and accepts a fresh PDF', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const { builder, subprocess } = await makeBuilder(dir, {
    writePdf: true,
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: All targets (build/main.xdv build/main.pdf) are up-to-date\n',
  });

  const { result } = await buildProject(builder, root, { force: true });

  assert.equal(result.status, 'success');
  assert.ok(subprocess.calls[0].argv.includes('-gg'));
});

test('build history keeps the last five successful builds', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  let paths;
  for (let index = 1; index <= 6; index += 1) {
    const helper = await makeBuilder(dir, {
      writePdf: true,
      pdfContents: `PDF-${index}`,
      writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
      stdout: 'Latexmk: This is Latexmk\n',
    });
    const built = await buildProject(helper.builder, root);
    assert.equal(built.result.status, 'success');
    paths = built.paths;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const index = JSON.parse(await readFile(paths.historyIndexPath, 'utf8'));
  assert.equal(index.entries.length, 5);
  assert.match(index.entries[0].pdf, /^build-\d+\.pdf$/);
  assert.equal(index.entries[0].reason, 'manual');
  assert.equal(await readFile(path.join(paths.historyDir, index.entries[0].pdf), 'utf8'), 'PDF-6');
  const files = await readdir(paths.historyDir);
  assert.equal(files.filter((name) => name.endsWith('.pdf')).length, 5);
});

test('cleaning the preview removes the build history directory', async (t) => {
  const dir = await tempDir(t);
  const root = await makeProject(dir);
  const helper = await makeBuilder(dir, {
    writePdf: true,
    pdfContents: 'PDF-HISTORY',
    writeLog: 'Output written on build/main.pdf (1 page, 1234 bytes).\n',
    stdout: 'Latexmk: This is Latexmk\n',
  });
  const built = await buildProject(helper.builder, root);
  assert.ok(await exists(built.paths.historyIndexPath));
  await helper.builder.clean({ paths: built.paths }, { includePreview: true });
  assert.equal(await exists(built.paths.historyIndexPath), false);
});
