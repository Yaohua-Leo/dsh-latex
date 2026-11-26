/**
 * PDF rasterization and text extraction for `latex_look`.
 *
 * The plugin already requires a local TeX distribution, and TeX Live ships
 * Poppler's `pdftoppm`/`pdftotext`/`pdfinfo`. That makes it possible to give
 * the model a real page image without adding an npm dependency or asking the
 * user to install Ghostscript. Ghostscript and `mutool` remain fallbacks for
 * distributions that drop the Poppler tools (MiKTeX keeps them optional).
 *
 * Every command is an argv array, never a shell string; every failure is
 * returned as data (`{ ok: false, code, message }`) so a missing renderer
 * degrades to "look is unavailable", not a broken tool call.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './util.js';

const PROBE_TTL_MS = 60_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/** Probe cache keyed by the directories that could change the result. */
const probeCache = new Map();

function executableName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function candidateDirs(config = {}, extraDirs = [], includePath = true) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const dirs = [];
  if (config.texBinDir) dirs.push(config.texBinDir);
  if (config.latexmkPath) dirs.push(path.dirname(config.latexmkPath));
  for (const dir of extraDirs) dirs.push(dir);
  if (!includePath) return unique(dirs);
  for (const entry of String(process.env.PATH ?? '').split(path.delimiter)) dirs.push(entry);
  if (process.platform === 'win32') {
    if (localAppData) dirs.push(path.join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
    if (home) dirs.push(path.join(home, '.TinyTeX', 'bin', 'windows'));
  } else {
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/Library/TeX/texbin');
    if (home) dirs.push(path.join(home, '.TinyTeX', 'bin', 'x86_64-linux'));
  }
  return unique(dirs);
}

async function findInDirs(base, dirs) {
  const name = executableName(base);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

/**
 * Locate the optional PDF tools. Results are cached for a minute so a tool
 * call does not re-stat a dozen directories on every page.
 *
 * @param {{ texBinDir?: string, latexmkPath?: string }} config
 * @param {{ extraDirs?: string[], refresh?: boolean, includePath?: boolean }} [options]
 * @returns {Promise<{ pdftoppm?: string, pdftotext?: string, pdfinfo?: string, mutool?: string, gs?: string, checkedAt: number }>}
 */
export async function probeRenderTools(config = {}, options = {}) {
  const dirs = candidateDirs(config, options.extraDirs ?? [], options.includePath !== false);
  const key = dirs.join('\u0000');
  const cached = probeCache.get(key);
  if (!options.refresh && cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) return cached;
  const [pdftoppm, pdftotext, pdfinfo, mutool, gswin, gs] = await Promise.all([
    findInDirs('pdftoppm', dirs),
    findInDirs('pdftotext', dirs),
    findInDirs('pdfinfo', dirs),
    findInDirs('mutool', dirs),
    findInDirs('gswin64c', dirs),
    findInDirs('gs', dirs),
  ]);
  const result = {
    pdftoppm,
    pdftotext,
    pdfinfo,
    mutool,
    gs: gswin ?? gs,
    checkedAt: Date.now(),
  };
  probeCache.set(key, result);
  return result;
}

/** A short description of what the look tool can do on this machine. */
export function renderCapability(tools) {
  if (!tools) return { canRender: false, canExtractText: false, engine: undefined };
  return {
    canRender: Boolean(tools.pdftoppm || tools.gs || tools.mutool),
    canExtractText: Boolean(tools.pdftotext),
    engine: tools.pdftoppm ? 'pdftoppm' : tools.gs ? 'ghostscript' : tools.mutool ? 'mutool' : undefined,
  };
}

/**
 * Run one tool with bounded output and a hard timeout.
 *
 * @param {string[]} argv absolute executable + arguments
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean, aborted: boolean, stdout: string, stderr: string, truncated: boolean }>}
 */
export function runTool(argv, options = {}) {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_RENDER_TIMEOUT_MS);
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes) || MAX_CAPTURE_BYTES);
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, stdout: '', stderr: 'empty argv', truncated: false });
      return;
    }
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: 'aborted', truncated: false });
      return;
    }
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, stdout: '', stderr: error.message, truncated: false });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const collect = (target, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (target === stdout) {
        if (stdoutBytes >= maxBytes) {
          truncated = true;
          return;
        }
        const slice = buffer.subarray(0, maxBytes - stdoutBytes);
        if (slice.length < buffer.length) truncated = true;
        stdoutBytes += slice.length;
        target.push(slice);
      } else {
        if (stderrBytes >= 64 * 1024) return;
        const slice = buffer.subarray(0, 64 * 1024 - stderrBytes);
        stderrBytes += slice.length;
        target.push(slice);
      }
    };
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk));
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', onAbort);
      resolve({
        code,
        signal: signal ?? null,
        timedOut,
        aborted,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      });
    };
    child.on('error', (error) => {
      stderr.push(Buffer.from(error.message));
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function clampPage(value, max = 100_000) {
  const page = Math.round(Number(value) || 1);
  return Math.max(1, Math.min(max, page));
}

export function clampDpi(value, fallback = 120) {
  const dpi = Math.round(Number(value) || fallback);
  return Math.max(36, Math.min(600, dpi));
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return undefined;
  const values = ['x', 'y', 'w', 'h'].map((key) => Math.round(Number(crop[key])));
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  const [x, y, w, h] = values;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

/**
 * Render a contiguous page range in one `pdftoppm` invocation.
 *
 * Audit uses this instead of one process per page: TeX Live's Poppler names
 * the outputs `<prefix>-<page>.png`, so the caller can rename them into the
 * normal per-page cache paths. Ghostscript/muPDF have no equivalent here and
 * fall back to single-page rendering.
 *
 * @returns {Promise<{ ok: boolean, files?: Map<number, string>, code?: string, message?: string }>}
 */
export async function renderPageRange(tools, options) {
  const pdfPath = path.resolve(String(options.pdfPath ?? ''));
  const dir = path.resolve(String(options.outDir ?? ''));
  const from = clampPage(options.from);
  const to = clampPage(options.to);
  const dpi = clampDpi(options.dpi);
  if (!tools?.pdftoppm) return { ok: false, code: 'NO_RANGE_RENDERER' };
  if (to < from) return { ok: false, code: 'BAD_RANGE', message: 'empty page range' };
  if (!(await stat(pdfPath).catch(() => undefined))?.isFile()) {
    return { ok: false, code: 'NO_PDF', message: `PDF not found: ${pdfPath}` };
  }
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `range-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const argv = [
    tools.pdftoppm,
    '-png',
    '-r',
    String(dpi),
    '-f',
    String(from),
    '-l',
    String(to),
    pdfPath,
    base,
  ];
  const result = await runTool(argv, {
    signal: options.signal,
    timeoutMs: options.timeoutMs || 120_000,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      code: result.timedOut ? 'TIMEOUT' : 'RENDER_FAILED',
      message: trimToolError(result.stderr, result.stdout) || 'pdftoppm range render failed',
    };
  }
  const baseName = path.basename(base);
  const pattern = new RegExp('^' + baseName + '-(\\d+)\\.png$');
  const files = new Map();
  const entries = await readdir(dir).catch(() => []);
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match) continue;
    const page = Number(match[1]);
    if (page >= from && page <= to) files.set(page, path.join(dir, name));
  }
  if (files.size === 0) {
    return { ok: false, code: 'RENDER_FAILED', message: 'pdftoppm produced no range images' };
  }
  return { ok: true, files };
}

/**
 * Render exactly one page to a PNG.
 *
 * `pdftoppm` is preferred (same distribution as latexmk); Ghostscript and
 * mutool are fallbacks. Ghostscript/mutool ignore the crop rectangle, which is
 * reported back as `cropApplied: false` instead of silently cropping wrong.
 *
 * @param {object} tools probe result
 * @param {{ pdfPath: string, outPath: string, page: number, dpi?: number, crop?: object, signal?: AbortSignal, timeoutMs?: number }} options
 */
export async function renderPageToPng(tools, options) {
  const pdfPath = path.resolve(String(options.pdfPath ?? ''));
  const outPath = path.resolve(String(options.outPath ?? ''));
  const page = clampPage(options.page);
  const dpi = clampDpi(options.dpi);
  const crop = normalizeCrop(options.crop);
  const info = await stat(pdfPath).catch(() => undefined);
  if (!info?.isFile()) {
    return { ok: false, code: 'NO_PDF', message: `PDF not found: ${pdfPath}` };
  }
  if (!outPath.toLowerCase().endsWith('.png')) {
    return { ok: false, code: 'BAD_PATH', message: 'render output must be a .png path' };
  }
  await mkdir(path.dirname(outPath), { recursive: true });
  // Render to a unique temp file and rename: two Host processes looking at the
  // same project must never read a half-written PNG.
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const tempBase = tempPath.slice(0, -4);
  const cleanup = async () => {
    await rm(tempPath, { force: true }).catch(() => {});
  };
  const finalize = async () => {
    const produced = await stat(tempPath).catch(() => undefined);
    if (!produced?.isFile() || produced.size === 0) {
      await cleanup();
      return undefined;
    }
    try {
      await rename(tempPath, outPath);
    } catch {
      await rm(outPath, { force: true }).catch(() => {});
      await rename(tempPath, outPath).catch(() => {});
    }
    await cleanup();
    return stat(outPath).catch(() => undefined);
  };
  if (tools?.pdftoppm) {
    const argv = [tools.pdftoppm, '-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile'];
    if (crop) argv.push('-x', String(crop.x), '-y', String(crop.y), '-W', String(crop.w), '-H', String(crop.h));
    argv.push(pdfPath, tempBase);
    const result = await runTool(argv, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const produced = result.code === 0 ? await finalize() : undefined;
    if (produced?.isFile() && produced.size > 0) {
      return { ok: true, path: outPath, engine: 'pdftoppm', dpi, page, cropApplied: Boolean(crop), bytes: produced.size };
    }
    await cleanup();
    return {
      ok: false,
      code: result.timedOut ? 'TIMEOUT' : 'RENDER_FAILED',
      engine: 'pdftoppm',
      message: trimToolError(result.stderr, result.stdout) || 'pdftoppm produced no image',
    };
  }
  if (tools?.gs) {
    const argv = [
      tools.gs,
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=png16m',
      `-r${dpi}`,
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${tempPath}`,
      pdfPath,
    ];
    const result = await runTool(argv, { signal: options.signal, timeoutMs: options.timeoutMs });
    const produced = result.code === 0 ? await finalize() : undefined;
    if (produced?.isFile() && produced.size > 0) {
      return {
        ok: true,
        path: outPath,
        engine: 'ghostscript',
        dpi,
        page,
        cropApplied: false,
        bytes: produced.size,
      };
    }
    await cleanup();
    return {
      ok: false,
      code: result.timedOut ? 'TIMEOUT' : 'RENDER_FAILED',
      engine: 'ghostscript',
      message: trimToolError(result.stderr, result.stdout) || 'Ghostscript produced no image',
    };
  }
  if (tools?.mutool) {
    const argv = [tools.mutool, 'draw', '-o', tempPath, '-r', String(dpi), pdfPath, String(page)];
    const result = await runTool(argv, { signal: options.signal, timeoutMs: options.timeoutMs });
    const produced = result.code === 0 ? await finalize() : undefined;
    if (produced?.isFile() && produced.size > 0) {
      return {
        ok: true,
        path: outPath,
        engine: 'mutool',
        dpi,
        page,
        cropApplied: false,
        bytes: produced.size,
      };
    }
    await cleanup();
    return {
      ok: false,
      code: result.timedOut ? 'TIMEOUT' : 'RENDER_FAILED',
      engine: 'mutool',
      message: trimToolError(result.stderr, result.stdout) || 'mutool produced no image',
    };
  }
  await cleanup();
  return {
    ok: false,
    code: 'NO_RENDERER',
    message:
      'No PDF renderer was found. Install Poppler (pdftoppm ships with TeX Live), Ghostscript, or muPDF, then retry.',
  };
}

function trimToolError(stderr, stdout) {
  const text = [stderr, stdout].filter(Boolean).join('\n').trim();
  if (text === '') return '';
  return text.length > 600 ? text.slice(0, 600) : text;
}

/** Parse `pdfinfo` output. */
export function parsePdfInfo(stdout) {
  const text = String(stdout ?? '');
  const pages = /Pages:\s*(\d+)/i.exec(text);
  const size = /Page size:\s*([\d.]+)\s*x\s*([\d.]+)/i.exec(text);
  const encrypted = /Encrypted:\s*yes/i.test(text);
  return {
    pages: pages ? Number(pages[1]) : undefined,
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    encrypted,
  };
}

/** Page count through pdfinfo, with a conservative fallback. */
export async function pdfPageCount(tools, pdfPath) {
  if (tools?.pdfinfo) {
    const result = await runTool([tools.pdfinfo, pdfPath], { timeoutMs: 15_000 });
    if (result.code === 0) {
      const parsed = parsePdfInfo(result.stdout);
      if (parsed.pages && parsed.pages > 0) return parsed.pages;
    }
  }
  // Falling back to counting `/Type /Page` objects would be wrong for
  // incrementally updated PDFs; report "unknown" and let the caller cap.
  return undefined;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extract every page's text in one `pdftotext` call.
 * Page text is separated by form feeds; the total is capped by the buffer cap.
 *
 * @returns {Promise<{ ok: boolean, pages: string[], message?: string }>}
 */
export async function pdfAllPageTexts(tools, pdfPath, signal) {
  if (!tools?.pdftotext) {
    return { ok: false, pages: [], message: 'pdftotext was not found; text anchoring is unavailable.' };
  }
  const result = await runTool([tools.pdftotext, '-enc', 'UTF-8', pdfPath, '-'], {
    signal,
    timeoutMs: 30_000,
    maxBytes: 32 * 1024 * 1024,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      pages: [],
      message: trimToolError(result.stderr, result.stdout) || `pdftotext exited with ${result.code}`,
    };
  }
  const pages = result.stdout.split('\f');
  if (pages.length > 0 && pages[pages.length - 1].trim() === '') pages.pop();
  return { ok: true, pages };
}

export async function pdfPageText(tools, pdfPath, page, signal) {
  if (!tools?.pdftotext) return { ok: false, text: '', message: 'pdftotext unavailable' };
  const result = await runTool(
    [tools.pdftotext, '-f', String(page), '-l', String(page), '-enc', 'UTF-8', pdfPath, '-'],
    { signal, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 },
  );
  if (result.code !== 0) {
    return { ok: false, text: '', message: trimToolError(result.stderr, result.stdout) || 'pdftotext failed' };
  }
  return { ok: true, text: result.stdout.replace(/\f/g, '\n') };
}

/**
 * Parse the XHTML produced by `pdftotext -bbox`.
 * @returns {{ text: string, x: number, y: number, w: number, h: number }[]}
 */
export function parseBboxWords(stdout) {
  const words = [];
  const pattern = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([\s\S]*?)<\/word>/gi;
  let match;
  while ((match = pattern.exec(String(stdout ?? ''))) !== null) {
    const x1 = Number(match[1]);
    const y1 = Number(match[2]);
    const x2 = Number(match[3]);
    const y2 = Number(match[4]);
    const text = decodeEntities(match[5]).replace(/<[^>]+>/g, '');
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    words.push({ text, x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) });
  }
  return words;
}

/**
 * Find the bounding box of a quote in a word list (PDF points, top-left origin).
 * The match is space-insensitive at word boundaries, so a selection that joins
 * two lines still resolves.
 */
export function findQuoteBox(words, quote) {
  const needle = normalizeText(quote).toLowerCase();
  if (needle.length < 4 || words.length === 0) return undefined;
  let text = '';
  const ranges = [];
  for (const word of words) {
    const normalized = normalizeText(word.text);
    const start = text.length;
    text += (text === '' ? '' : ' ') + normalized;
    ranges.push({ start, end: text.length, word });
  }
  const haystack = text.toLowerCase();
  let index = haystack.indexOf(needle);
  if (index < 0) {
    // A quote can include a hyphenated line break; retry without spaces.
    const flatNeedle = needle.replace(/\s+/g, '');
    const flat = haystack.replace(/\s+/g, '');
    const flatIndex = flat.indexOf(flatNeedle);
    if (flatIndex < 0) return undefined;
    // Map the flat offset back to the spaced text.
    let seen = 0;
    let mapped = -1;
    for (let i = 0; i < haystack.length; i += 1) {
      if (haystack[i] === ' ') continue;
      if (seen === flatIndex) {
        mapped = i;
        break;
      }
      seen += 1;
    }
    if (mapped < 0) return undefined;
    index = mapped;
  }
  const end = index + needle.length;
  const hits = ranges.filter((range) => range.end > index && range.start < end).map((range) => range.word);
  if (hits.length === 0) return undefined;
  const x = Math.min(...hits.map((hit) => hit.x));
  const y = Math.min(...hits.map((hit) => hit.y));
  const x2 = Math.max(...hits.map((hit) => hit.x + hit.w));
  const y2 = Math.max(...hits.map((hit) => hit.y + hit.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/**
 * Locate a quote's page and bounding box.
 * @returns {Promise<{ ok: boolean, page?: number, box?: object, message?: string, checked?: number }>}
 */
export async function locateQuote(tools, pdfPath, quote, options = {}) {
  const needle = normalizeText(quote);
  if (needle.length < 4) return { ok: false, message: 'quote is too short to anchor (minimum 4 characters)' };
  const hint = options.pageHint ? clampPage(options.pageHint) : undefined;
  if (hint) {
    const pageText = await pdfPageText(tools, pdfPath, hint, options.signal);
    if (pageText.ok && normalizeText(pageText.text).toLowerCase().includes(needle.toLowerCase())) {
      const box = await quoteBoxOnPage(tools, pdfPath, hint, quote, options.signal);
      return { ok: true, page: hint, box, checked: 1 };
    }
  }
  const all = await pdfAllPageTexts(tools, pdfPath, options.signal);
  if (!all.ok) return { ok: false, message: all.message };
  const maxPages = Math.max(1, Math.min(500, Number(options.maxPages) || 200));
  const pages = all.pages.slice(0, maxPages);
  for (let index = 0; index < pages.length; index += 1) {
    const page = index + 1;
    if (hint && page === hint) continue;
    if (normalizeText(pages[index]).toLowerCase().includes(needle.toLowerCase())) {
      const box = await quoteBoxOnPage(tools, pdfPath, page, quote, options.signal);
      return { ok: true, page, box, checked: index + 1 };
    }
  }
  return {
    ok: false,
    message: `Text not found in the first ${pages.length} page(s): ${needle.slice(0, 80)}`,
    checked: pages.length,
  };
}

async function quoteBoxOnPage(tools, pdfPath, page, quote, signal) {
  if (!tools?.pdftotext) return undefined;
  const result = await runTool(
    [tools.pdftotext, '-bbox', '-f', String(page), '-l', String(page), '-enc', 'UTF-8', pdfPath, '-'],
    { signal, timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 },
  );
  if (result.code !== 0) return undefined;
  return findQuoteBox(parseBboxWords(result.stdout), quote);
}

/**
 * SyncTeX inverse at a PDF point, performed by the service to keep this module
 * free of build-service knowledge. Exposed here only as a shape validator.
 */
export function validPoint(point) {
  if (!point || typeof point !== 'object') return undefined;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined;
  return { x, y };
}

/** Hash a file's bytes; used as the render-cache key and "same build" signal. */
export async function sha256File(file) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  if (info.size > 256 * 1024 * 1024) return undefined;
  const buffer = await readFile(file);
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Cache layout:
 *   <stateDir>/look/<hash16>/page-<n>-d<dpi>[-c<x>_<y>_<w>_<h>].png
 * At most two hash directories are kept so a diff against the previous build
 * stays possible without letting renders grow without bound.
 */
export function lookCacheDir(stateDir, hash) {
  return path.join(stateDir, 'look', String(hash ?? '').slice(0, 16));
}

export function lookPagePath(cacheDir, page, dpi, crop) {
  const suffix = crop ? `-c${crop.x}_${crop.y}_${crop.w}_${crop.h}` : '';
  return path.join(cacheDir, `page-${clampPage(page)}-d${clampDpi(dpi)}${suffix}.png`);
}

/** List existing look cache directories, newest first. */
export async function listLookCaches(stateDir) {
  const root = path.join(stateDir, 'look');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    const info = await stat(target).catch(() => undefined);
    if (info) result.push({ dir: target, name: entry.name, mtimeMs: info.mtimeMs });
  }
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Previous-build render for one page, if it exists. */
export async function previousLookPage(stateDir, currentDir, page, dpi, crop) {
  const caches = await listLookCaches(stateDir);
  const current = path.resolve(currentDir);
  for (const cache of caches) {
    if (path.resolve(cache.dir) === current) continue;
    const candidate = lookPagePath(cache.dir, page, dpi, crop);
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

/** Keep at most `keep` cache directories, deleting the oldest. */
export async function pruneLookCaches(stateDir, keep = 2) {
  const caches = await listLookCaches(stateDir);
  for (const cache of caches.slice(Math.max(1, keep))) {
    await rm(cache.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Safety check used before serving or attaching a rendered page. */
export function isInsideStateDir(stateDir, target) {
  return isInside(stateDir, target);
}
