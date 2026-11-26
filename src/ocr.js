/**
 * Optional local OCR for preview screenshots.
 *
 * The plugin deliberately does not ship an OCR engine: Tesseract is a large,
 * platform-specific dependency and the primary path for a scanned page is
 * "crop the region and let a vision-capable model read it". When `tesseract`
 * happens to be installed, it is used to attach a text hint to an annotation or
 * a screenshot question. A missing engine is not an error — it is reported as
 * "unavailable" and every caller keeps working without OCR text.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from './util.js';
import { runTool } from './render.js';

const PROBE_TTL_MS = 60_000;
const probeCache = new Map();

function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function candidateDirs(config = {}, extraDirs = []) {
  const dirs = [];
  if (config.texBinDir) dirs.push(config.texBinDir);
  for (const dir of extraDirs) dirs.push(dir);
  for (const entry of String(process.env.PATH ?? '').split(path.delimiter)) dirs.push(entry);
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) dirs.push(path.join(localAppData, 'Programs', 'Tesseract-OCR'));
    dirs.push('C:\\Program Files\\Tesseract-OCR');
  } else {
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin');
  }
  return [...new Set(dirs.filter(Boolean))];
}

/**
 * Locate `tesseract`. Cached for a minute, like the PDF renderer probe.
 * @returns {Promise<{ path?: string, checkedAt: number }>}
 */
export async function probeOcr(config = {}, options = {}) {
  const dirs = candidateDirs(config, options.extraDirs ?? []);
  const key = dirs.join('\u0000');
  const cached = probeCache.get(key);
  if (!options.refresh && cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) return cached;
  let found;
  for (const dir of dirs) {
    const candidate = path.join(dir, executableName('tesseract'));
    const result = await runTool([candidate, '--version'], { timeoutMs: 5_000 });
    if (result.code === 0) {
      found = candidate;
      break;
    }
  }
  const value = { path: found, checkedAt: Date.now() };
  probeCache.set(key, value);
  return value;
}

/** True when OCR is both configured and available. */
export async function ocrAvailable(config, extraDirs = []) {
  if (config?.ocrEnabled === 'off') return false;
  const probe = await probeOcr(config, { extraDirs });
  return Boolean(probe.path);
}

/**
 * Run OCR on one image file.
 *
 * `psm 6` ("assume a single uniform block of text") works better than the
 * default page-segmentation mode for a user-drawn crop. The output is
 * normalized and bounded; a failed OCR is data, not an exception.
 *
 * @returns {Promise<{ ok: boolean, text: string, message?: string, engine?: string }>}
 */
export async function ocrImage(imagePath, options = {}) {
  const probe = options.tesseract
    ? { path: options.tesseract }
    : await probeOcr(options.config ?? {}, { extraDirs: options.extraDirs ?? [] });
  if (!probe.path) {
    return { ok: false, text: '', message: 'tesseract was not found; OCR skipped.' };
  }
  const languages = typeof options.languages === 'string' && options.languages.trim() !== ''
    ? options.languages.trim()
    : 'eng';
  const argv = [probe.path, imagePath, 'stdout', '-l', languages, '--psm', '6'];
  const result = await runTool(argv, {
    timeoutMs: Math.max(3_000, Number(options.timeoutMs) || 20_000),
    signal: options.signal,
    maxBytes: 256 * 1024,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      text: '',
      message: errorMessage(result.stderr.trim() || `tesseract exited with ${result.code}`),
      engine: probe.path,
    };
  }
  const text = result.stdout
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
  if (text === '') return { ok: true, text: '', engine: probe.path };
  return { ok: true, text, engine: probe.path };
}

/** Write a temporary image for OCR and always remove it, including on failure. */
export async function withTemporaryImage(buffer, extension, task) {
  const dir = path.join(process.env.DSH_LATEX_TMP || os.tmpdir(), 'dsh-latex-ocr');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
  try {
    await writeFile(file, buffer);
    return await task(file);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}
