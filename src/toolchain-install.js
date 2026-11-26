/**
 * Dependency-free TinyTeX toolchain installer.
 *
 * The plugin deliberately ships no npm dependency and installs a local TeX
 * distribution only when the user asks for it. Everything happens inside one
 * `installDir` (`config.toolchainDir` or `~/.dsh-latex/toolchain`); PATH, the
 * registry and shell profiles are never touched, so an install is undone by
 * removing that directory and pointing `texBinDir` somewhere else.
 *
 * Download, verification and extraction are one explicit state machine rather
 * than a fire-and-forget script: the Web panel polls `status()` for progress
 * while a model tool awaits the same `install()` promise, and `cancel()` is a
 * real abort rather than a hint. Failures are returned as data and the partial
 * download/staging tree is always removed before the promise settles.
 *
 * The only external command is the system `tar` (`tar.exe` on Windows, whose
 * bsdtar reads both TinyTeX's .zip and .tar.gz assets). It is always spawned
 * with an argv array and `shell: false`, and the archive is listed with `-tf`
 * before extraction: any absolute path or `..` segment aborts the install
 * before a single archive entry reaches the disk.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTool } from './render.js';
import { abortError, errorMessage, isInside } from './util.js';

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 3_600_000;
const EXTRACT_TIMEOUT_MS = 180_000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const TAR_LIST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The tar used for archive inspection and extraction.
 *
 * Windows is resolved through `%SystemRoot%\System32\tar.exe` explicitly
 * instead of a PATH lookup: a PATH that prefers Git/MSYS may expose GNU tar,
 * which treats `D:\...` as a remote `host:path` and cannot read the archive
 * TinyTeX ships. Windows' own bsdtar both accepts drive-letter paths and reads
 * the .zip asset; macOS/Linux use the distribution's tar.
 */
export const TAR_COMMAND = (() => {
  if (process.platform !== 'win32') return 'tar';
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'tar.exe');
  return existsSync(candidate) ? candidate : 'tar.exe';
})();

const BIN_CANDIDATES = Object.freeze(['bin/windows', 'bin/x86_64-linux', 'bin']);
const TEX_EXECUTABLES = Object.freeze(['xelatex', 'latexmk', 'pdflatex', 'lualatex']);

/**
 * @typedef {object} ToolchainStatus
 * @property {'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed' | 'cancelled'} state
 * @property {'download' | 'verify' | 'extract' | undefined} phase current stage, retained on failure
 * @property {number} received bytes written to the temporary archive
 * @property {number | undefined} total declared archive size, when the server sent one
 * @property {number | undefined} percent integer 0..100, or undefined when the size is unknown
 * @property {string | undefined} binDir published TeX bin directory after a successful install
 * @property {string | undefined} sha256 streaming SHA-256 of the downloaded archive
 * @property {string | undefined} archive absolute path of the last temporary archive
 * @property {{ code: string, message: string } | undefined} error failure details
 * @property {string} installDir directory that receives the toolchain
 */

/**
 * @typedef {object} ToolchainInstallResult
 * @property {boolean} ok
 * @property {string} [binDir] published TeX bin directory (success only)
 * @property {string} [sha256] computed archive hash (success only)
 * @property {number} [bytes] downloaded archive size (success only)
 * @property {string} [code] stable failure code, e.g. HASH_MISMATCH
 * @property {string} [message] human-readable failure message
 */

/**
 * Default directory that receives a toolchain.
 *
 * @param {{ toolchainDir?: string } | undefined} config
 * @returns {string} absolute install directory
 */
export function defaultInstallDir(config = {}) {
  const configured = typeof config?.toolchainDir === 'string' ? config.toolchainDir.trim() : '';
  if (configured !== '') return path.resolve(configured);
  return path.join(os.homedir(), '.dsh-latex', 'toolchain');
}

/**
 * Decide whether a `tar -tf` listing is safe to extract.
 *
 * Pure and synchronous on purpose: the extraction step can be unit-tested
 * without running a process, and the caller can report every offending entry
 * before touching the filesystem. `..` is rejected even when it is not the
 * first segment, because `bin/../../x` escapes just as effectively.
 *
 * @param {unknown} entries lines printed by `tar -tf`
 * @returns {{ ok: boolean, unsafe: string[] }} offending entries, in listing order
 */
export function assertSafeTarEntries(entries) {
  const unsafe = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string') continue;
    const raw = entry.trim();
    if (raw === '') continue;
    const normalized = raw.replace(/\\/g, '/');
    const relative = normalized.replace(/^(?:\.\/)+/, '');
    if (relative === '' || relative === '.') continue;
    const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.');
    const absolute = normalized.startsWith('/') || /^[A-Za-z]:/.test(relative);
    const escapes = segments.includes('..');
    if (absolute || escapes) unsafe.push(entry);
  }
  return { ok: unsafe.length === 0, unsafe };
}

function installerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function clampTimeout(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, ms));
}

function parseDownloadUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSha256(value) {
  if (value === undefined || value === null) return undefined;
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(String(value).trim());
  return match ? match[1].toLowerCase() : undefined;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value !== null && value !== undefined) return String(value);
  }
  const record = headers[name] ?? headers[name.toLowerCase()];
  return typeof record === 'string' ? record : undefined;
}

function contentLength(response) {
  const raw = headerValue(response?.headers, 'content-length');
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function descriptionOfStatus(response) {
  const code = Number(response?.status);
  return Number.isFinite(code) && code > 0 ? String(code) : 'unknown';
}

function ensureSuccessfulResponse(response) {
  if (!response || typeof response !== 'object') {
    throw installerError('NETWORK', 'download failed: fetch returned no response');
  }
  if (response.ok === true) return;
  const status = Number(response.status);
  const httpFailure = response.ok === false || !Number.isFinite(status) || status < 200 || status > 299;
  if (httpFailure) throw installerError('HTTP_STATUS', `download failed with HTTP ${descriptionOfStatus(response)}`);
}

/** Wrap a Web ReadableStream or an async iterable as a minimal reader. */
function openBodyReader(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    return {
      read: () => reader.read(),
      cancel: async () => {
        if (typeof reader.cancel === 'function') await reader.cancel();
      },
    };
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    return {
      read: async () => {
        const next = await iterator.next();
        return { done: Boolean(next.done), value: next.value };
      },
      cancel: async () => {
        if (typeof iterator.return === 'function') await iterator.return();
      },
    };
  }
  throw installerError('NO_BODY', 'download failed: the response has no readable body');
}

/**
 * A promise that rejects when `signal` aborts, so a reader whose underlying
 * source ignores the signal cannot stall cancellation or the hard timeout.
 */
function abortRaceFor(signal) {
  let listener;
  const promise = new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? abortError('operation aborted'));
      return;
    }
    listener = () => reject(signal.reason ?? abortError('operation aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  promise.catch(() => {});
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
    },
  };
}

function archiveExtension(url) {
  const name = path.posix.basename(url.pathname).toLowerCase();
  for (const extension of ['.tar.gz', '.tar.xz', '.tar.bz2', '.tgz', '.zip', '.tar', '.exe']) {
    if (name.endsWith(extension)) return extension;
  }
  return '.archive';
}

/**
 * Stream `body` to `archivePath`, updating a SHA-256 and progress as it goes.
 *
 * @param {typeof nodeFs} fs
 * @param {{ archivePath: string, body: unknown, signal: AbortSignal, onProgress?: (received: number) => void }} options
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
async function streamBodyToFile(fs, options) {
  const hash = createHash('sha256');
  const reader = openBodyReader(options.body);
  const abortRace = abortRaceFor(options.signal);
  let handle;
  let received = 0;
  try {
    handle = await fs.open(options.archivePath, 'w');
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortRace.promise]);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : Buffer.from(value ?? '');
      if (chunk.byteLength === 0) continue;
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw installerError('TOO_LARGE', `archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`);
      }
      hash.update(chunk);
      await handle.write(chunk);
      options.onProgress?.(received);
    }
  } finally {
    abortRace.dispose();
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The file may already be closed by a failed write.
      }
    }
  }
  return { sha256: hash.digest('hex'), bytes: received };
}

function isAbortedSignal(signal) {
  return Boolean(signal?.aborted);
}

function cancelReason(signal) {
  return signal?.reason ?? abortError('operation aborted');
}

/**
 * Run the Windows self-extracting TinyTeX asset.
 *
 * The release assets for Windows are `.exe` self-extractors, not zip/tar
 * archives: started with `-y` from the staging directory they create
 * `TinyTeX/bin/windows/` in the current working directory. Running an
 * executable from `installDir/tmp` is only acceptable because the download was
 * SHA-256 verified when the caller supplied a hash; it is still spawned with an
 * argv array, no shell and the same hard timeout/signal as the tar path.
 */
async function extractSelfExtractingExe(archivePath, context) {
  const result = await context.runToolImpl([archivePath, '-y'], {
    cwd: context.stagingDir,
    timeoutMs: context.timeoutMs,
    maxBytes: 64 * 1024,
    signal: context.signal,
  });
  if (result.aborted) throw cancelReason(context.signal);
  if (result.timedOut) throw installerError('EXTRACT_TIMEOUT', `the TinyTeX self-extractor timed out after ${context.timeoutMs} ms`);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `the extractor exited with ${result.code}`).slice(0, 600);
    throw installerError('EXTRACT_FAILED', `the TinyTeX self-extractor failed: ${detail}`);
  }
  const binDir = path.join(context.stagingDir, 'TinyTeX', 'bin', 'windows');
  const info = await nodeFs.stat(binDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw installerError('EXTRACT_FAILED', 'the TinyTeX self-extractor did not create TinyTeX/bin/windows');
  }
  return { ok: true };
}

/**
 * Default `extractImpl`: extract a TinyTeX asset from `archivePath` into
 * `stagingDir`.
 *
 * Two layouts are handled:
 * - `.exe` (the Windows release asset) is a self-extracting archive started
 *   with `-y` whose working directory is `stagingDir`;
 * - everything else is a `.zip`/`.tar.*` archive read with the system tar,
 *   after a `tar -tf` listing proves no entry is absolute or contains `..`.
 *
 * Exported so it can be unit-tested directly; `context.runToolImpl` is the
 * test seam that replaces the actual process runner.
 *
 * @param {string} archivePath
 * @param {{
 *   stagingDir: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   runToolImpl?: Function,
 *   logger?: object,
 * }} context
 * @returns {Promise<{ ok: true }>}
 */
export async function extractTinyTexArchive(archivePath, context = {}) {
  const stagingDir = path.resolve(String(context.stagingDir ?? ''));
  const timeoutMs = Math.max(1_000, Number(context.timeoutMs) || EXTRACT_TIMEOUT_MS);
  const runToolImpl = typeof context.runToolImpl === 'function' ? context.runToolImpl : runTool;
  if (String(archivePath).toLowerCase().endsWith('.exe')) {
    return extractSelfExtractingExe(path.resolve(String(archivePath)), {
      stagingDir,
      timeoutMs,
      signal: context.signal,
      runToolImpl,
    });
  }
  const list = await runToolImpl([TAR_COMMAND, '-tf', archivePath], {
    cwd: stagingDir,
    timeoutMs,
    maxBytes: TAR_LIST_MAX_BYTES,
    signal: context.signal,
  });
  if (list.aborted) throw cancelReason(context.signal);
  if (list.timedOut) throw installerError('EXTRACT_TIMEOUT', `tar -tf timed out after ${timeoutMs} ms`);
  if (list.code !== 0) {
    const detail = (list.stderr.trim() || list.stdout.trim() || `tar exited with ${list.code}`).slice(0, 600);
    throw installerError('EXTRACT_FAILED', `tar could not list the archive: ${detail}`);
  }
  if (list.truncated) {
    throw installerError('EXTRACT_FAILED', 'archive listing is too large to validate safely');
  }
  const entries = list.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (entries.length === 0) throw installerError('EXTRACT_FAILED', 'archive contains no entries');
  const safety = assertSafeTarEntries(entries);
  if (!safety.ok) {
    const preview = safety.unsafe.slice(0, 5).join(', ');
    throw installerError('UNSAFE_ARCHIVE', `archive contains unsafe paths: ${preview}`);
  }
  const extracted = await runToolImpl([TAR_COMMAND, '-xf', archivePath, '-C', stagingDir], {
    cwd: stagingDir,
    timeoutMs,
    maxBytes: 64 * 1024,
    signal: context.signal,
  });
  if (extracted.aborted) throw cancelReason(context.signal);
  if (extracted.timedOut) throw installerError('EXTRACT_TIMEOUT', `tar -xf timed out after ${timeoutMs} ms`);
  if (extracted.code !== 0) {
    const detail = (extracted.stderr.trim() || extracted.stdout.trim() || `tar exited with ${extracted.code}`).slice(0, 600);
    throw installerError('EXTRACT_FAILED', `tar could not extract the archive: ${detail}`);
  }
  return { ok: true };
}

async function isDirectory(fs, target) {
  const info = await fs.stat(target).catch(() => undefined);
  return info?.isDirectory() === true;
}

/** True when `dir` holds at least one TeX executable the build could use. */
async function hasTexExecutable(fs, dir) {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : ['', '.exe'];
  for (const name of TEX_EXECUTABLES) {
    for (const suffix of suffixes) {
      const info = await fs.stat(path.join(dir, `${name}${suffix}`)).catch(() => undefined);
      if (info?.isFile()) return true;
    }
  }
  return false;
}

function binCandidatesForPlatform() {
  return process.platform === 'win32' ? BIN_CANDIDATES : ['bin/x86_64-linux', 'bin', 'bin/windows'];
}

/**
 * Find `bin/windows`, `bin/x86_64-linux` or `bin` directly under the staging
 * root, or one directory deep (TinyTeX archives wrap everything in `TinyTeX/`).
 *
 * @returns {Promise<{ binDir: string, relative: string } | undefined>}
 */
async function locateBinDir(fs, stagingDir) {
  const topLevel = await fs.readdir(stagingDir, { withFileTypes: true }).catch(() => []);
  const prefixes = [''];
  for (const entry of topLevel) {
    if (entry.isDirectory()) prefixes.push(entry.name);
  }
  for (const relative of binCandidatesForPlatform()) {
    for (const prefix of prefixes) {
      const candidate = prefix === '' ? relative : `${prefix}/${relative}`;
      const absolute = path.join(stagingDir, ...candidate.split('/'));
      if (!(await isDirectory(fs, absolute))) continue;
      if (!(await hasTexExecutable(fs, absolute))) continue;
      return { binDir: absolute, relative: candidate };
    }
  }
  return undefined;
}

/** The toolchain root that will be published into `installDir`. */
function extractionRoot(stagingDir, binDir) {
  const base = path.basename(binDir);
  let binContainer;
  if (base === 'bin') {
    binContainer = binDir;
  } else if (path.basename(path.dirname(binDir)) === 'bin') {
    binContainer = path.dirname(binDir);
  }
  if (!binContainer) return undefined;
  const rootDir = path.dirname(binContainer);
  if (!isInside(stagingDir, rootDir)) return undefined;
  return rootDir;
}

async function resolveInstalledBinDir(fs, stagingDir, extracted) {
  let binDir;
  if (extracted && typeof extracted.binDir === 'string' && extracted.binDir.trim() !== '') {
    const value = extracted.binDir.trim();
    binDir = path.isAbsolute(value) ? path.normalize(value) : path.resolve(stagingDir, value);
    if (!isInside(stagingDir, binDir) || path.relative(stagingDir, binDir) === '') {
      throw installerError('EXTRACT_FAILED', 'the extractor reported a bin directory outside its staging directory');
    }
  } else {
    const located = await locateBinDir(fs, stagingDir);
    if (!located) {
      throw installerError(
        'BIN_NOT_FOUND',
        'the archive contains no bin/windows, bin/x86_64-linux or bin directory with xelatex/latexmk',
      );
    }
    binDir = located.binDir;
  }
  if (!(await isDirectory(fs, binDir))) {
    throw installerError('BIN_NOT_FOUND', `extracted bin directory is missing: ${binDir}`);
  }
  if (!(await hasTexExecutable(fs, binDir))) {
    throw installerError('BIN_NOT_FOUND', `no TeX executable was found in ${binDir}`);
  }
  return binDir;
}

/**
 * Publish `rootDir` into `installDir` by renaming its top-level entries.
 *
 * A previous install is first moved into a sibling backup directory so a
 * failed rename can roll back instead of leaving a half-old, half-new tree.
 * `tmp/` is the installer's scratch area and is never published or backed up.
 */
async function promoteExtractedRoot(fs, rootDir, installDir, token, logger) {
  const entries = await fs.readdir(rootDir);
  if (entries.length === 0) throw installerError('EXTRACT_FAILED', 'the archive extracted an empty toolchain directory');
  for (const name of entries) {
    if (name === 'tmp' || name.startsWith('.backup-')) {
      throw installerError('EXTRACT_FAILED', `archive contains a reserved top-level entry: ${name}`);
    }
  }
  const backupDir = path.join(installDir, `.backup-${token}`);
  await fs.mkdir(backupDir, { recursive: true });
  const stashed = [];
  const moved = [];
  try {
    for (const name of await fs.readdir(installDir)) {
      if (name === 'tmp' || name.startsWith('.backup-')) continue;
      await fs.rename(path.join(installDir, name), path.join(backupDir, name));
      stashed.push(name);
    }
    for (const name of entries) {
      await fs.rename(path.join(rootDir, name), path.join(installDir, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved) {
      await fs.rm(path.join(installDir, name), { recursive: true, force: true }).catch(() => {});
    }
    for (const name of stashed) {
      await fs.rename(path.join(backupDir, name), path.join(installDir, name)).catch(() => {});
    }
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await fs.rm(backupDir, { recursive: true, force: true }).catch((error) => {
    logger?.warn?.('LaTeX toolchain: leftover backup %s could not be removed: %s', backupDir, errorMessage(error));
  });
}

async function promoteToolchain(fs, stagingDir, binDir, installDir, token, logger) {
  const rootDir = extractionRoot(stagingDir, binDir);
  if (!rootDir) {
    throw installerError('BIN_NOT_FOUND', 'could not determine the toolchain root that contains bin/');
  }
  const relativeBin = path.relative(rootDir, binDir);
  await promoteExtractedRoot(fs, rootDir, installDir, token, logger);
  const finalBinDir = path.join(installDir, relativeBin);
  if (!(await isDirectory(fs, finalBinDir))) {
    throw installerError('BIN_NOT_FOUND', `published bin directory is missing: ${finalBinDir}`);
  }
  return finalBinDir;
}

/** Create `installDir`, clear stale scratch entries and return `installDir/tmp`. */
async function prepareDirectories(fs, installDir) {
  const tmpDir = path.join(installDir, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  for (const name of await fs.readdir(tmpDir).catch(() => [])) {
    await fs.rm(path.join(tmpDir, name), { recursive: true, force: true }).catch(() => {});
  }
  for (const name of await fs.readdir(installDir).catch(() => [])) {
    if (name.startsWith('.backup-')) {
      await fs.rm(path.join(installDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  return tmpDir;
}

async function cleanupInstall(fs, run) {
  await fs.rm(run.archivePath, { force: true }).catch(() => {});
  await fs.rm(run.stagingDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Create the TinyTeX installer state machine.
 *
 * `installDir` is resolved once, at creation time. One installer instance
 * owns exactly one install at a time (`install()` during a run returns a
 * `BUSY` result) and must not share an `installDir` with another live
 * installer; stale scratch files from a crashed process are cleaned before
 * the next download starts.
 *
 * @param {{
 *   config?: { toolchainDir?: string },
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   fetchImpl?: typeof fetch,
 *   extractImpl?: (archivePath: string, context: {
 *     stagingDir: string, installDir: string, platform: string, timeoutMs: number,
 *     signal: AbortSignal, logger?: object,
 *   }) => Promise<{ ok?: boolean, binDir?: string, code?: string, message?: string } | undefined>,
 *   runToolImpl?: Function,
 *   fsImpl?: typeof nodeFs,
 * }} [options]
 * @returns {{
 *   status: () => ToolchainStatus,
 *   install: (options: { url: string, sha256?: string, timeoutMs?: number }) => Promise<ToolchainInstallResult>,
 *   cancel: () => boolean,
 *   reset: () => ToolchainStatus,
 * }}
 */
export function createToolchainInstaller(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const logger = options.logger;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const extractImpl = typeof options.extractImpl === 'function' ? options.extractImpl : extractTinyTexArchive;
  const runToolImpl = typeof options.runToolImpl === 'function' ? options.runToolImpl : undefined;
  const fs = options.fsImpl ?? nodeFs;
  const installDir = defaultInstallDir(config);

  let state = idleStatus();
  let active = null;
  let counter = 0;

  function idleStatus() {
    return {
      state: 'idle',
      phase: undefined,
      received: 0,
      total: undefined,
      percent: 0,
      binDir: undefined,
      sha256: undefined,
      archive: undefined,
      error: undefined,
      installDir,
    };
  }

  function status() {
    const snapshot = { ...state };
    if (state.error) snapshot.error = { ...state.error };
    return snapshot;
  }

  function update(run, patch) {
    if (active !== run) return;
    Object.assign(state, patch);
  }

  function cancel() {
    const run = active;
    if (!run || run.settled || run.controller.signal.aborted) return false;
    run.controller.abort(abortError('toolchain install cancelled'));
    update(run, {
      state: 'cancelled',
      phase: undefined,
      error: { code: 'CANCELLED', message: 'install cancelled' },
    });
    return true;
  }

  function reset() {
    const run = active;
    if (run && !run.settled) run.controller.abort(abortError('toolchain install reset'));
    active = null;
    state = idleStatus();
    return status();
  }

  /**
   * Download, verify and extract one TinyTeX archive.
   *
   * @param {{ url?: string, sha256?: string, timeoutMs?: number }} [installOptions]
   * @returns {Promise<ToolchainInstallResult>}
   */
  async function install(installOptions = {}) {
    if (active) return { ok: false, code: 'BUSY', message: 'a toolchain install is already running' };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'NO_FETCH', message: 'global fetch is unavailable; pass fetchImpl' };
    }
    const requested = installOptions && typeof installOptions === 'object' ? installOptions : {};
    const url = parseDownloadUrl(requested.url);
    if (!url) return { ok: false, code: 'INVALID_URL', message: 'url must be an absolute http(s) URL' };
    const expectedSha256 = normalizeSha256(requested.sha256);
    const hashProvided = requested.sha256 !== undefined && requested.sha256 !== null && String(requested.sha256).trim() !== '';
    if (hashProvided && expectedSha256 === undefined) {
      return { ok: false, code: 'INVALID_HASH', message: 'sha256 must be a 64-character hex digest' };
    }
    const timeoutMs = clampTimeout(requested.timeoutMs);
    const token = `${counter += 1}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    const run = {
      token,
      controller,
      settled: false,
      timedOut: false,
      archivePath: path.join(installDir, 'tmp', `archive-${token}${archiveExtension(url)}`),
      stagingDir: path.join(installDir, 'tmp', `staging-${token}`),
    };
    active = run;
    state = idleStatus();
    Object.assign(state, { state: 'downloading', phase: 'download', archive: run.archivePath });
    let timer;
    logger?.info?.('LaTeX toolchain: downloading %s', url.href);

    try {
      await prepareDirectories(fs, installDir);
      await fs.mkdir(run.stagingDir, { recursive: true });
      timer = setTimeout(() => {
        run.timedOut = true;
        controller.abort(installerError('TIMEOUT', `install timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      const response = await fetchImpl(url.href, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'dsh-latex-toolchain-installer' },
      });
      ensureSuccessfulResponse(response);
      const totalSize = contentLength(response);
      if (totalSize !== undefined && totalSize > MAX_ARCHIVE_BYTES) {
        throw installerError('TOO_LARGE', `archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`);
      }
      update(run, { total: totalSize, percent: totalSize ? 0 : undefined });

      const downloaded = await streamBodyToFile(fs, {
        archivePath: run.archivePath,
        body: response.body,
        signal: controller.signal,
        onProgress: (received) => {
          update(run, {
            received,
            percent: totalSize ? Math.min(100, Math.round((received / totalSize) * 100)) : undefined,
          });
        },
      });

      update(run, {
        state: 'verifying',
        phase: 'verify',
        received: downloaded.bytes,
        total: totalSize ?? downloaded.bytes,
        percent: 100,
        sha256: downloaded.sha256,
      });
      if (expectedSha256 !== undefined && expectedSha256 !== downloaded.sha256) {
        throw installerError(
          'HASH_MISMATCH',
          `SHA-256 mismatch: expected ${expectedSha256}, computed ${downloaded.sha256}`,
          { expected: expectedSha256, actual: downloaded.sha256 },
        );
      }
      if (isAbortedSignal(controller.signal)) throw cancelReason(controller.signal);
      logger?.info?.('LaTeX toolchain: verified archive sha256=%s bytes=%d', downloaded.sha256, downloaded.bytes);

      update(run, { state: 'extracting', phase: 'extract' });
      const extracted = await extractImpl(run.archivePath, {
        stagingDir: run.stagingDir,
        installDir,
        platform: process.platform,
        timeoutMs: EXTRACT_TIMEOUT_MS,
        signal: controller.signal,
        logger,
        runToolImpl,
      });
      if (extracted && extracted.ok === false) {
        throw installerError(
          typeof extracted.code === 'string' && extracted.code !== '' ? extracted.code : 'EXTRACT_FAILED',
          typeof extracted.message === 'string' && extracted.message !== ''
            ? extracted.message
            : 'archive extraction failed',
        );
      }
      if (isAbortedSignal(controller.signal)) throw cancelReason(controller.signal);
      const binDirOnDisk = await resolveInstalledBinDir(fs, run.stagingDir, extracted);
      const finalBinDir = await promoteToolchain(fs, run.stagingDir, binDirOnDisk, installDir, token, logger);
      update(run, {
        state: 'done',
        phase: undefined,
        binDir: finalBinDir,
        sha256: downloaded.sha256,
        received: downloaded.bytes,
        total: totalSize ?? downloaded.bytes,
        percent: 100,
        error: undefined,
      });
      run.settled = true;
      logger?.info?.('LaTeX toolchain: installed at %s', finalBinDir);
      return { ok: true, binDir: finalBinDir, sha256: downloaded.sha256, bytes: downloaded.bytes };
    } catch (error) {
      if (active !== run) return { ok: false, code: 'CANCELLED', message: 'install was reset' };
      const cancelled = isAbortedSignal(controller.signal) && !run.timedOut;
      const code = run.timedOut
        ? 'TIMEOUT'
        : cancelled
          ? 'CANCELLED'
          : typeof error?.code === 'string' && error.code !== ''
            ? error.code
            : 'INSTALL_FAILED';
      const message = errorMessage(error) || 'toolchain install failed';
      update(run, { state: cancelled ? 'cancelled' : 'failed', error: { code, message } });
      run.settled = true;
      if (cancelled) logger?.warn?.('LaTeX toolchain: install cancelled');
      else logger?.warn?.('LaTeX toolchain: install failed: %s', message);
      return { ok: false, code, message };
    } finally {
      if (timer) clearTimeout(timer);
      await cleanupInstall(fs, run);
      if (active === run) active = null;
    }
  }

  return { status, install, cancel, reset };
}
