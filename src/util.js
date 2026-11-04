/**
 * Small, dependency-free helpers shared by the Host half of dsh-latex.
 *
 * Everything here is deliberately Node-builtin only: the plugin is installed as
 * a plain ES module bundle into a DSH profile and must not drag a dependency
 * tree with it.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Stable, opaque project id derived from the main file, not just its directory. */
export function projectIdOf(root, mainFile) {
  const normalizedRoot = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  const normalizedMain = (mainFile ? path.resolve(mainFile) : '').replace(/\\/g, '/').toLowerCase();
  return `p_${createHash('sha1').update(`${normalizedRoot}\u0000${normalizedMain}`).digest('hex').slice(0, 16)}`;
}

/** True for a UNC / network path, which this plugin refuses to build. */
export function isUncPath(value) {
  return typeof value === 'string' && (value.startsWith('\\\\') || value.startsWith('//'));
}

/** True when `child` is `parent` or lives below it (case-insensitive on Windows). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../');
}

/** Normalize a path for display: forward slashes, no trailing separator. */
export function displayPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** `stat` that resolves to `undefined` instead of throwing. */
export async function statOrUndefined(target) {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

/** Read a UTF-8 text file, returning `undefined` for missing/unreadable files. */
export async function readTextOrUndefined(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const { readFile } = await import('node:fs/promises');
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Create every parent directory of `file` (and the file's own directory). */
export async function ensureParent(file) {
  await mkdir(path.dirname(file), { recursive: true });
}

/**
 * Atomically publish `source` at `dest`: write a sibling temp file, then
 * rename over the destination. A concurrent reader therefore never observes a
 * half-written preview PDF.
 */
export async function atomicCopy(source, dest) {
  await ensureParent(dest);
  const temp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await copyFile(source, temp);
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Atomically replace a UTF-8 text file. */
export async function atomicWriteText(dest, text) {
  const { writeFile } = await import('node:fs/promises');
  await ensureParent(dest);
  const temp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Keep the last `max` characters of a string. */
export function tailText(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/** A human-oriented duration such as `2.4 s` or `850 ms`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** Current local time as a short `HH:MM:SS` string. */
export function clockText(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Wait for `ms`, resolving early when `signal` aborts. Never rejects. */
export function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Turn an unknown thrown value into a readable message. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * A bounded asynchronous semaphore used to cap concurrent latexmk processes.
 * `release` is idempotent so failure paths cannot leak permits.
 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  get pending() {
    return this.waiters.length;
  }

  async acquire(signal) {
    if (signal?.aborted) throw abortError();
    if (this.active < this.limit) {
      this.active += 1;
      return this.#releaser();
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
    this.active += 1;
    return this.#releaser();
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (!next) return;
      if (next.onAbort) next.signal?.removeEventListener?.('abort', next.onAbort);
      next.onAbort = undefined;
      next.resolve();
    };
  }
}

/** Abort error with a stable marker used to classify cancelled work. */
export function abortError(message = 'operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

/** True for an error produced by an AbortSignal. */
export function isAbortError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' || error.code === 'ABORTED' || error.code === 'ABORT_ERR'),
  );
}

/** Convert a Windows or POSIX path into the `dsh-resource://file/session/...` address. */
export function sessionFileAddress(sessionId, cwd, absolutePath) {
  const normalize = (value) => String(value ?? '').replace(/\\/g, '/');
  const normalized = normalize(absolutePath);
  const root = normalize(cwd).replace(/\/+$/, '');
  let relative = normalized;
  if (root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    relative = normalized.slice(root.length + 1);
  }
  const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
  const encoded = relative
    .replace(/^(?:\.\/)+/, '')
    .split('/')
    .map(encodeSegment)
    .join('/');
  return `dsh-resource://file/session/${encodeSegment(String(sessionId))}/${encoded}`;
}
