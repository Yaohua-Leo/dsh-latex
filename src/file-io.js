/**
 * Safe read/write access for the one class of user file the editor may change:
 * an existing `.tex` source file.
 *
 * The editor is not a general file manager. Everything here is deliberately
 * narrow: absolute path, `.tex` suffix only, no UNC/network paths, the optional
 * `allowedRoots` fence from the project resolver, realpath re-validation after
 * symlinks are resolved, a 4 MiB cap, and a compare-and-swap revision so an
 * editor tab cannot silently clobber an external edit.
 *
 * Write is atomic: a sibling temp file is written and renamed over the target.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isUncPath } from './util.js';

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Error carrying the HTTP status the route adapter should use. */
export class SourceFileError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'SourceFileError';
    this.status = status;
    this.details = details;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return 'lf';
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf >= lfOnly ? 'crlf' : 'lf';
}

/** Validate the path shape before touching the filesystem. */
function validatePath(target, resolver) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new SourceFileError(400, 'path is required');
  }
  if (target.length > 4096 || target.includes('\u0000')) {
    throw new SourceFileError(400, 'invalid path');
  }
  if (!path.isAbsolute(target)) {
    throw new SourceFileError(400, 'path must be absolute');
  }
  if (isUncPath(target)) {
    throw new SourceFileError(400, 'UNC/network paths are not supported for editing');
  }
  const absolute = path.resolve(target);
  if (path.extname(absolute).toLowerCase() !== '.tex') {
    throw new SourceFileError(400, 'only .tex files can be edited');
  }
  try {
    resolver?.assertSafePath?.(absolute);
    resolver?.assertAllowed?.(absolute);
  } catch (error) {
    throw new SourceFileError(403, error?.message ?? 'path is not allowed');
  }
  return absolute;
}

/**
 * Resolve symlinks, then re-check the real target with the same rules. A path
 * inside the project must not smuggle in an outside file through a link.
 */
async function resolveReal(target, resolver) {
  let real;
  try {
    real = await realpath(target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SourceFileError(404, 'file not found');
    throw new SourceFileError(400, `cannot resolve file: ${error?.message ?? error}`);
  }
  if (path.extname(real).toLowerCase() !== '.tex') {
    throw new SourceFileError(400, 'only .tex files can be edited');
  }
  if (isUncPath(real)) {
    throw new SourceFileError(400, 'UNC/network paths are not supported for editing');
  }
  try {
    resolver?.assertSafePath?.(real);
    resolver?.assertAllowed?.(real);
  } catch (error) {
    throw new SourceFileError(403, error?.message ?? 'path is not allowed');
  }
  return real;
}

function decodeUtf8(buffer, target) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new SourceFileError(415, `file is not valid UTF-8: ${target}`);
  }
}

/**
 * Read one `.tex` source file as UTF-8 text.
 * @param {string} target absolute path
 * @param {{ resolver?: { assertSafePath?: Function, assertAllowed?: Function } }} [options]
 */
export async function readSourceFile(target, options = {}) {
  const absolute = validatePath(target, options.resolver);
  const real = await resolveReal(absolute, options.resolver);
  const info = await stat(real).catch((error) => {
    if (error?.code === 'ENOENT') throw new SourceFileError(404, 'file not found');
    throw error;
  });
  if (!info.isFile()) throw new SourceFileError(400, 'path is not a regular file');
  if (info.size > MAX_SOURCE_BYTES + 3) {
    throw new SourceFileError(413, `file is larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  const raw = await readFile(real);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = bom ? raw.subarray(3) : raw;
  const content = decodeUtf8(body, real);
  return {
    path: real,
    content,
    revision: sha256(raw),
    eol: detectEol(content),
    bom,
    size: raw.length,
    mtime: info.mtimeMs,
  };
}

/**
 * Atomically replace one `.tex` file, preserving its original EOL style and BOM.
 * @param {string} target absolute path
 * @param {string} content new UTF-8 text (BOM/EOL are normalized by this function)
 * @param {{ expectedRevision?: string, resolver?: object }} [options]
 */
export async function writeSourceFile(target, content, options = {}) {
  const absolute = validatePath(target, options.resolver);
  if (typeof content !== 'string') {
    throw new SourceFileError(400, 'content must be a string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
    throw new SourceFileError(413, `content is larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  const real = await resolveReal(absolute, options.resolver);
  const info = await stat(real).catch((error) => {
    if (error?.code === 'ENOENT') throw new SourceFileError(404, 'file not found');
    throw error;
  });
  if (!info.isFile()) throw new SourceFileError(400, 'path is not a regular file');
  const raw = await readFile(real);
  const revision = sha256(raw);
  const expected = typeof options.expectedRevision === 'string' ? options.expectedRevision.trim() : '';
  if (expected !== '' && expected !== revision) {
    throw new SourceFileError(409, 'the file changed on disk since it was loaded', {
      revision,
      expectedRevision: expected,
    });
  }
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const originalText = decodeUtf8(bom ? raw.subarray(3) : raw, real);
  const eol = detectEol(originalText);
  const normalized = String(content).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const withEol = eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
  const bytes = Buffer.from(`${bom ? '\uFEFF' : ''}${withEol}`, 'utf8');
  if (bytes.length > MAX_SOURCE_BYTES + 3) {
    throw new SourceFileError(413, `content is larger than ${MAX_SOURCE_BYTES} bytes`);
  }
  const temp = `${real}.dsh-latex-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, real);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw new SourceFileError(500, `could not save the file: ${error?.message ?? error}`);
  }
  const after = await stat(real);
  return {
    path: real,
    revision: sha256(bytes),
    size: bytes.length,
    mtime: after.mtimeMs,
    eol,
    bom,
  };
}
