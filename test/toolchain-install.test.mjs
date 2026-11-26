import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TAR_COMMAND,
  assertSafeTarEntries,
  createToolchainInstaller,
  defaultInstallDir,
  extractTinyTexArchive,
} from '../src/toolchain-install.js';

const TEST_TMP = process.env.DSH_LATEX_TEST_TMP || os.tmpdir();
const EXE = process.platform === 'win32' ? 'xelatex.exe' : 'xelatex';

async function tempDir(t) {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, 'dsh-latex-toolchain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mockLogger() {
  const entries = [];
  return {
    entries,
    info(...args) {
      entries.push(args);
    },
    warn(...args) {
      entries.push(args);
    },
  };
}

/** A fetch-like response whose whole body is available at once. */
function byteResponse(bytes, { total = bytes.length } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length' ? String(total) : null;
      },
    },
    body: stream,
  };
}

/** A response that emits half its bytes, then waits for `gate`. */
function gatedResponse(bytes, gate, { total = bytes.length } = {}) {
  const split = Math.max(1, Math.floor(bytes.length / 2));
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      await gate.promise;
      if (bytes.length > split) controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length' ? String(total) : null;
      },
    },
    body: stream,
  };
}

/** Injection stand-in for the tar extractor: creates bin/<xelatex> in staging. */
function mockExtractor(calls = []) {
  return async (archivePath, context) => {
    calls.push({ archivePath, context });
    const bin = path.join(context.stagingDir, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, EXE), 'fake tinytex executable');
    return { ok: true };
  };
}

function makeInstaller(installDir, { fetchImpl, extractImpl, runToolImpl } = {}) {
  const logger = mockLogger();
  const installer = createToolchainInstaller({
    config: { toolchainDir: installDir },
    logger,
    fetchImpl,
    extractImpl,
    runToolImpl,
  });
  return { installer, logger };
}

/** The shape runTool() resolves to, so fake runners are interchangeable. */
function fakeToolResult(overrides = {}) {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: '',
    stderr: '',
    truncated: false,
    ...overrides,
  };
}

function assertStatusShape(status) {
  for (const key of [
    'state',
    'phase',
    'received',
    'total',
    'percent',
    'binDir',
    'sha256',
    'archive',
    'error',
    'installDir',
  ]) {
    assert.ok(Object.hasOwn(status, key), `status() is missing ${key}`);
  }
}

/** Minimal POSIX ustar writer used to build deliberately hostile archives. */
function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100);
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write('root', 265, 'ascii');
  header.write('root', 297, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(tarHeader(entry.name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarAvailable(t) {
  const probe = spawnSync(TAR_COMMAND, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip(`tar is unavailable (${probe.error?.message ?? `exit ${probe.status}`})`);
    return false;
  }
  return true;
}

test('defaultInstallDir prefers toolchainDir and falls back to ~/.dsh-latex/toolchain', () => {
  assert.equal(defaultInstallDir({ toolchainDir: path.join(TEST_TMP, 'custom') }), path.resolve(TEST_TMP, 'custom'));
  assert.equal(defaultInstallDir({ toolchainDir: '   ' }), path.join(os.homedir(), '.dsh-latex', 'toolchain'));
  assert.equal(defaultInstallDir({}), path.join(os.homedir(), '.dsh-latex', 'toolchain'));
});

test('install reports download progress, verifies the hash and publishes bin/', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('TinyTeX fake archive payload '.repeat(64));
  const gate = deferred();
  const calls = [];
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => gatedResponse(bytes, gate),
    extractImpl: mockExtractor(calls),
  });

  const idle = installer.status();
  assertStatusShape(idle);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.phase, undefined);
  assert.equal(idle.received, 0);
  assert.equal(idle.installDir, path.resolve(dir));
  assert.equal(installer.cancel(), false);

  const running = installer.install({
    url: 'https://example.test/TinyTeX-1-v2026.tar.gz',
    sha256: `sha256:${sha256Of(bytes).toUpperCase()}`,
  });
  await waitFor(() => installer.status().received > 0);

  const progress = installer.status();
  assert.equal(progress.state, 'downloading');
  assert.equal(progress.phase, 'download');
  assert.equal(progress.total, bytes.length);
  assert.ok(progress.received > 0 && progress.received < bytes.length);
  assert.ok(progress.percent >= 0 && progress.percent <= 100);
  assert.match(progress.archive, /[\\/]tmp[\\/]archive-/);

  gate.resolve();
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, sha256Of(bytes));
  assert.equal(result.binDir, path.join(path.resolve(dir), 'bin'));
  assert.equal(existsSync(path.join(result.binDir, EXE)), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.installDir, path.resolve(dir));
  assert.equal(path.dirname(path.dirname(calls[0].context.stagingDir)), path.resolve(dir));
  assert.ok(calls[0].context.signal instanceof AbortSignal);

  const done = installer.status();
  assertStatusShape(done);
  assert.equal(done.state, 'done');
  assert.equal(done.phase, undefined);
  assert.equal(done.binDir, result.binDir);
  assert.equal(done.sha256, sha256Of(bytes));
  assert.equal(done.percent, 100);
  assert.equal(done.error, undefined);
  assert.equal(existsSync(done.archive), false, 'the temporary archive is removed');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
  assert.deepEqual((await readdir(dir)).sort(), ['bin', 'tmp']);
});

test('a SHA-256 mismatch fails the install before extraction and cleans up', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('untrusted bytes');
  const calls = [];
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => byteResponse(bytes),
    extractImpl: mockExtractor(calls),
  });

  const result = await installer.install({
    url: 'https://example.test/TinyTeX-1.zip',
    sha256: '0'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HASH_MISMATCH');
  assert.equal(calls.length, 0, 'nothing is extracted from an unverified archive');

  const status = installer.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'HASH_MISMATCH');
  assert.match(status.error.message, /SHA-256 mismatch/);
  assert.equal(status.binDir, undefined);
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
  assert.equal(existsSync(path.join(dir, 'bin')), false);
});

test('cancel aborts an in-flight download and removes partial files', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('x'.repeat(4_096));
  const gate = deferred();
  const calls = [];
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => gatedResponse(bytes, gate),
    extractImpl: mockExtractor(calls),
  });

  const running = installer.install({ url: 'https://example.test/TinyTeX-1.tar.gz' });
  await waitFor(() => installer.status().received > 0);
  assert.equal(installer.cancel(), true);
  assert.equal(installer.cancel(), false, 'cancel is idempotent');

  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  assert.equal(calls.length, 0);
  const status = installer.status();
  assert.equal(status.state, 'cancelled');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
  assert.equal(existsSync(path.join(dir, 'bin')), false);
});

test('the hard timeout fails the install and cleans partial files', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('y'.repeat(4_096));
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => gatedResponse(bytes, deferred()),
    extractImpl: mockExtractor(),
  });

  const result = await installer.install({
    url: 'https://example.test/TinyTeX-1.tar.gz',
    timeoutMs: 400,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
  const status = installer.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'TIMEOUT');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('an extraction failure fails the install and removes staging', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('archive that will not extract');
  let seen;
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => byteResponse(bytes),
    extractImpl: async (archivePath, context) => {
      seen = { archivePath, ...context };
      await mkdir(path.join(context.stagingDir, 'junk'), { recursive: true });
      await writeFile(path.join(context.stagingDir, 'junk', 'partial.bin'), 'partial');
      return { ok: false, code: 'EXTRACT_FAILED', message: 'corrupt archive' };
    },
  });

  const result = await installer.install({ url: 'https://example.test/TinyTeX-1.zip' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXTRACT_FAILED');
  assert.equal(result.message, 'corrupt archive');
  assert.ok(seen);
  assert.equal(seen.signal.aborted, false);
  const status = installer.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'EXTRACT_FAILED');
  assert.equal(existsSync(path.join(dir, 'bin')), false);
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('reset aborts work, returns to idle and keeps the cancelled run quiet', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('z'.repeat(2_048));
  const gate = deferred();
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => gatedResponse(bytes, gate),
    extractImpl: mockExtractor(),
  });

  const running = installer.install({ url: 'https://example.test/TinyTeX-1.tar.gz' });
  await waitFor(() => installer.status().received > 0);
  const idle = installer.reset();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.received, 0);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  assert.equal(installer.status().state, 'idle', 'reset wins over the aborted run');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('assertSafeTarEntries rejects absolute paths and parent traversal', () => {
  const safe = assertSafeTarEntries([
    'bin/xelatex.exe',
    './TinyTeX/texmf-dist/tex/latex/base/article.cls',
    'TinyTeX/bin/windows/',
    './',
  ]);
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.unsafe, []);

  const hostile = [
    '../escaped.txt',
    'TinyTeX/../../escaped.txt',
    'bin\\..\\..\\escaped.txt',
    '/etc/passwd',
    'C:/Windows/System32/evil.exe',
    'C:relative-to-drive',
    '\\\\server\\share\\evil',
    '..',
  ];
  const unsafe = assertSafeTarEntries(hostile);
  assert.equal(unsafe.ok, false);
  for (const entry of hostile) assert.ok(unsafe.unsafe.includes(entry), `expected ${entry} to be rejected`);

  assert.deepEqual(assertSafeTarEntries(undefined), { ok: true, unsafe: [] });
});

test('the default extractor lists, scans and extracts a real tar archive', async (t) => {
  if (!tarAvailable(t)) return;
  const dir = await tempDir(t);
  const fixture = path.join(dir, 'fixture');
  await mkdir(path.join(fixture, 'bin'), { recursive: true });
  await writeFile(path.join(fixture, 'bin', EXE), 'fake tinytex executable');
  const archive = path.join(dir, 'tinytex.tar');
  const created = spawnSync(TAR_COMMAND, ['-cf', archive, '-C', fixture, '.'], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const bytes = await readFile(archive);

  const installDir = path.join(dir, 'toolchain');
  const { installer } = makeInstaller(installDir, { fetchImpl: async () => byteResponse(bytes) });
  const result = await installer.install({
    url: 'https://example.test/TinyTeX-1.tar.gz',
    sha256: sha256Of(bytes),
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.binDir, path.join(installDir, 'bin'));
  assert.equal(existsSync(path.join(result.binDir, EXE)), true);
  assert.equal(installer.status().state, 'done');
  assert.deepEqual(await readdir(path.join(installDir, 'tmp')), []);
});

test('a TinyTeX/ top-level wrapper is published flat into installDir', async (t) => {
  const dir = await tempDir(t);
  const platformBin = process.platform === 'win32' ? 'windows' : 'x86_64-linux';
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => byteResponse(Buffer.from('nested tinytex payload')),
    extractImpl: async (archivePath, context) => {
      const bin = path.join(context.stagingDir, 'TinyTeX', 'bin', platformBin);
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, EXE), 'fake tinytex executable');
      return { ok: true };
    },
  });

  const result = await installer.install({ url: 'https://example.test/TinyTeX-1.tar.gz' });
  assert.equal(result.ok, true);
  assert.equal(result.binDir, path.join(dir, 'bin', platformBin));
  assert.equal(existsSync(path.join(result.binDir, EXE)), true);
  assert.equal(existsSync(path.join(dir, 'TinyTeX')), false, 'the wrapper directory is collapsed');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('the default extractor refuses traversal entries before extracting', async (t) => {
  if (!tarAvailable(t)) return;
  const dir = await tempDir(t);
  const archive = makeTar([
    { name: '../escaped.txt', content: 'pwned' },
    { name: 'bin/xelatex.exe', content: 'fake' },
  ]);
  const { installer } = makeInstaller(dir, { fetchImpl: async () => byteResponse(archive) });

  const result = await installer.install({ url: 'https://example.test/evil.tar', timeoutMs: 30_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSAFE_ARCHIVE');
  assert.match(result.message, /unsafe paths/);
  const status = installer.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'UNSAFE_ARCHIVE');
  assert.equal(existsSync(path.join(dir, 'tmp', 'escaped.txt')), false);
  assert.equal(existsSync(path.join(dir, 'bin')), false);
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('the default extractor runs a Windows .exe asset as a self-extractor', async (t) => {
  const dir = await tempDir(t);
  const staging = path.join(dir, 'staging');
  await mkdir(staging, { recursive: true });
  const archive = path.join(dir, 'TinyTeX-1-v2026.01.exe');
  const controller = new AbortController();
  const calls = [];
  const runToolImpl = async (argv, options) => {
    calls.push({ argv, options });
    const bin = path.join(staging, 'TinyTeX', 'bin', 'windows');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'xelatex.exe'), 'fake self-extracted binary');
    return fakeToolResult();
  };

  const outcome = await extractTinyTexArchive(archive, {
    stagingDir: staging,
    timeoutMs: 5_000,
    signal: controller.signal,
    runToolImpl,
  });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, [archive, '-y'], 'the self-extractor runs with -y and an argv array');
  assert.equal(calls[0].options.cwd, staging);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.timeoutMs, 5_000);
});

test('a .exe self-extractor that never creates TinyTeX/bin/windows fails', async (t) => {
  const dir = await tempDir(t);
  const staging = path.join(dir, 'staging');
  await mkdir(staging, { recursive: true });
  const archive = path.join(dir, 'TinyTeX-1-v2026.01.exe');
  await assert.rejects(
    extractTinyTexArchive(archive, {
      stagingDir: staging,
      runToolImpl: async () => fakeToolResult(),
    }),
    (error) => {
      assert.equal(error.code, 'EXTRACT_FAILED');
      assert.match(error.message, /TinyTeX\/bin\/windows/);
      return true;
    },
  );
});

test('install accepts a .exe asset and publishes TinyTeX/bin/windows', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('fake self-extracting TinyTeX payload');
  const calls = [];
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => byteResponse(bytes),
    runToolImpl: async (argv, options) => {
      calls.push({ argv, options });
      const bin = path.join(options.cwd, 'TinyTeX', 'bin', 'windows');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'xelatex.exe'), 'fake self-extracted binary');
      return fakeToolResult();
    },
  });

  const result = await installer.install({
    url: 'https://example.test/TinyTeX-1-v2026.01.exe',
    sha256: sha256Of(bytes),
  });
  assert.equal(result.ok, true);
  assert.equal(result.binDir, path.join(dir, 'bin', 'windows'));
  assert.equal(existsSync(path.join(result.binDir, 'xelatex.exe')), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].argv[0], /\.exe$/, 'the temporary archive keeps the .exe extension');
  assert.equal(path.basename(calls[0].argv[0]).startsWith('archive-'), true);
  assert.deepEqual(calls[0].argv.slice(1), ['-y']);
  assert.equal(calls[0].options.cwd.startsWith(path.join(path.resolve(dir), 'tmp')), true);
  assert.equal(installer.status().state, 'done');
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});

test('a reinstall replaces the previous tree and leaves no backup behind', async (t) => {
  const dir = await tempDir(t);
  const bytes = Buffer.from('reinstall payload');
  const { installer } = makeInstaller(dir, {
    fetchImpl: async () => byteResponse(bytes),
    extractImpl: mockExtractor(),
  });

  const first = await installer.install({ url: 'https://example.test/TinyTeX-1.zip' });
  assert.equal(first.ok, true);
  await writeFile(path.join(first.binDir, 'stale.txt'), 'from the old install');

  const second = await installer.install({ url: 'https://example.test/TinyTeX-2.zip' });
  assert.equal(second.ok, true);
  assert.equal(second.binDir, first.binDir);
  assert.equal(existsSync(path.join(second.binDir, EXE)), true);
  assert.equal(existsSync(path.join(second.binDir, 'stale.txt')), false);
  assert.equal(installer.status().state, 'done');
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('.backup-')), []);
  assert.deepEqual(await readdir(path.join(dir, 'tmp')), []);
});
