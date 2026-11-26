/**
 * Local OCR with RapidOCR (PP-OCRv4 ONNX).
 *
 * The plugin does not ship a model or a Python runtime. Instead it detects a
 * Python interpreter and, when the user asks for OCR, creates an isolated venv
 * under `ocrInstallDir` and installs `rapidocr_onnxruntime` there. The wheel
 * bundles the PP-OCR ONNX models; the first warmup initializes them and is the
 * "download/install the local OCR component" step surfaced by the UI.
 *
 * The Node side only speaks one JSON line with the Python runner; model
 * download logs on stderr never break the protocol. Every function returns
 * data instead of throwing, so a missing OCR engine simply means "unavailable".
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.js';
import { runTool } from './render.js';
import { errorMessage } from './util.js';

const RUNNER_PATH = fileURLToPath(new URL('../assets/rapidocr-runner.py', import.meta.url));
const PROBE_TTL_MS = 60_000;
const PACKAGE = 'rapidocr_onnxruntime==1.2.3';
const probeCache = new Map();

/** Resolve the managed OCR directory. */
export function defaultOcrInstallDir(config = {}) {
  const configured = typeof config.ocrInstallDir === 'string' ? config.ocrInstallDir.trim() : '';
  if (configured !== '') return path.resolve(configured);
  return path.join(os.homedir(), '.dsh-latex', 'ocr');
}

/** Python executable inside the managed venv (undefined when it does not exist). */
export function venvPython(installDir) {
  return process.platform === 'win32'
    ? path.join(installDir, 'venv', 'Scripts', 'python.exe')
    : path.join(installDir, 'venv', 'bin', 'python');
}

async function isFile(target) {
  return Boolean((await stat(target).catch(() => undefined))?.isFile());
}

/** Base interpreter used to create the venv. */
export function basePython(config = {}) {
  const configured = typeof config.ocrPython === 'string' ? config.ocrPython.trim() : '';
  return configured !== '' ? configured : 'python';
}

let basePythonCache;

/** Find a usable base Python (config wins; otherwise python/python3). */
export async function findBasePython(config = {}, options = {}) {
  const configured = typeof config.ocrPython === 'string' ? config.ocrPython.trim() : '';
  if (configured !== '') return configured;
  if (!options.refresh && basePythonCache) return basePythonCache;
  for (const candidate of ['python', 'python3']) {
    const probe = await runTool([candidate, '-c', 'import sys; print(sys.version_info[0])'], {
      timeoutMs: 5_000,
    });
    if (probe.code === 0) {
      basePythonCache = candidate;
      return candidate;
    }
  }
  basePythonCache = undefined;
  return undefined;
}

/** Interpreter actually used for OCR: the managed venv when present. */
export async function rapidOcrPython(config = {}) {
  const installDir = defaultOcrInstallDir(config);
  const managed = venvPython(installDir);
  if (await isFile(managed)) return managed;
  return (await findBasePython(config)) ?? basePython(config);
}

/**
 * Check whether `rapidocr_onnxruntime` imports in the chosen interpreter.
 * Cached for a minute; `refresh: true` forces a probe after an install.
 *
 * @returns {Promise<{ok: boolean, python: string, version?: string, message?: string}>}
 */
export async function probeRapidOcr(config = {}, options = {}) {
  const python = await rapidOcrPython(config);
  const key = `${python}\u0000${RUNNER_PATH}`;
  const cached = probeCache.get(key);
  if (!options.refresh && cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  const result = await runTool(
    [
      python,
      '-c',
      'import rapidocr_onnxruntime as r; print(getattr(r, "__version__", "unknown"))',
    ],
    { timeoutMs: Math.max(3_000, Number(options.timeoutMs) || 10_000) },
  );
  const value = {
    ok: result.code === 0,
    python,
    version: result.code === 0 ? result.stdout.trim() : undefined,
    message:
      result.code === 0
        ? undefined
        : (result.stderr.trim() || result.stdout.trim() || 'rapidocr_onnxruntime is not importable').slice(
            0,
            600,
          ),
  };
  probeCache.set(key, { checkedAt: Date.now(), value });
  return value;
}

/** Drop the probe cache after an install/cancel. */
export function clearRapidOcrProbe() {
  probeCache.clear();
}

/** Parse the runner's single JSON line without trusting arbitrary stdout. */
export function parseRunnerOutput(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (!parsed || parsed.ok !== true) {
        return { ok: false, message: parsed?.error ?? 'RapidOCR returned an error' };
      }
      const rows = Array.isArray(parsed.lines) ? parsed.lines : [];
      const text = typeof parsed.text === 'string' ? parsed.text : rows.map((row) => row.text).join('\n');
      return { ok: true, text, lines: rows };
    } catch {
      // Keep looking for an earlier JSON line.
    }
  }
  return { ok: false, message: 'RapidOCR produced no JSON output' };
}

/** Run RapidOCR on one image file. */
export async function ocrWithRapidOcr(imagePath, options = {}) {
  const probe = await probeRapidOcr(options.config ?? {}, { refresh: options.refresh });
  if (!probe.ok) {
    return {
      ok: false,
      text: '',
      engine: 'rapidocr',
      message: probe.message ?? 'RapidOCR is not installed.',
    };
  }
  const result = await runTool([probe.python, RUNNER_PATH, imagePath], {
    timeoutMs: Math.max(5_000, Number(options.timeoutMs) || 60_000),
  });
  if (result.aborted) return { ok: false, text: '', engine: 'rapidocr', message: 'OCR cancelled.' };
  if (result.timedOut) return { ok: false, text: '', engine: 'rapidocr', message: 'OCR timed out.' };
  if (result.code !== 0) {
    const parsed = parseRunnerOutput(result.stdout);
    return {
      ok: false,
      text: '',
      engine: 'rapidocr',
      message:
        parsed.message ||
        (result.stderr.trim() || result.stdout.trim() || `RapidOCR exited with ${result.code}`).slice(0, 800),
    };
  }
  const parsed = parseRunnerOutput(result.stdout);
  if (!parsed.ok) return { ok: false, text: '', engine: 'rapidocr', message: parsed.message };
  return { ok: true, text: parsed.text, lines: parsed.lines, engine: 'rapidocr' };
}

/**
 * Create the managed venv and install RapidOCR, then warm the model cache.
 *
 * This is a one-shot action exposed through `/latex/ocr/install`; progress is
 * coarse (venv/pip/models) because pip's own output is not a stable protocol.
 *
 * @returns {Promise<{ok: boolean, python?: string, version?: string, message?: string, code?: string}>}
 */
export async function installRapidOcr(options = {}) {
  const config = options.config ?? {};
  const installDir = defaultOcrInstallDir(config);
  const venvDir = path.join(installDir, 'venv');
  const python = await findBasePython(config);
  const managedPython = venvPython(installDir);
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;
  const timeout = Math.max(60_000, Number(options.timeoutMs) || 900_000);
  const scratch = path.join(installDir, `warmup-${process.pid}-${Date.now()}.png`);
  try {
    if (signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'OCR install cancelled.' };
    if (!python) {
      return {
        ok: false,
        code: 'NO_PYTHON',
        message:
          'Python 3 was not found. Install Python 3 (or set ocrPython) to use the local OCR model.',
      };
    }
    await mkdir(installDir, { recursive: true });
    if (!(await isFile(managedPython))) {
      report({ phase: 'venv', percent: 5, message: '创建 Python 虚拟环境…' });
      const venv = await runTool([python, '-m', 'venv', venvDir], {
        timeoutMs: 180_000,
        signal,
      });
      if (venv.aborted) return { ok: false, code: 'CANCELLED', message: 'OCR install cancelled.' };
      if (venv.code !== 0) {
        throw new Error(
          (venv.stderr.trim() || venv.stdout.trim() || 'python -m venv failed').slice(0, 800),
        );
      }
    }
    if (!(await isFile(managedPython))) throw new Error('venv did not create a Python executable');
    report({
      phase: 'pip',
      percent: 25,
      message: '安装 RapidOCR 与 ONNX Runtime（含 PP-OCR 模型，约 150 MB）…',
    });
    // `uv` is dramatically faster when present; pip is the portable fallback.
    let installed = await runTool(['uv', '--version'], { timeoutMs: 5_000, signal });
    let installResult;
    if (installed.code === 0) {
      installResult = await runTool(
        ['uv', 'pip', 'install', '--python', managedPython, PACKAGE],
        { timeoutMs: timeout, signal },
      );
    }
    if (!installResult || installResult.code !== 0) {
      installResult = await runTool(
        [
          managedPython,
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-input',
          '--no-warn-script-location',
          '--timeout',
          '60',
          '--retries',
          '2',
          PACKAGE,
        ],
        { timeoutMs: timeout, signal },
      );
    }
    if (installResult.aborted) return { ok: false, code: 'CANCELLED', message: 'OCR install cancelled.' };
    if (installResult.code !== 0) {
      throw new Error(
        (installResult.stderr.trim() || installResult.stdout.trim() || 'OCR package install failed').slice(
          0,
          1200,
        ),
      );
    }
    report({ phase: 'models', percent: 85, message: '初始化 PP-OCR 模型…' });
    // A blank white image is enough to make RapidOCR download/initialize its
    // detection/recognition models; the empty result is intentionally ignored.
    const blank = encodePng({ width: 32, height: 32, channels: 3, data: Buffer.alloc(32 * 32 * 3, 255) });
    await writeFile(scratch, blank);
    const warm = await runTool([managedPython, RUNNER_PATH, scratch], {
      timeoutMs: Math.min(timeout, 240_000),
      signal,
    });
    if (warm.aborted) return { ok: false, code: 'CANCELLED', message: 'OCR install cancelled.' };
    if (warm.code !== 0) {
      const parsed = parseRunnerOutput(warm.stdout);
      throw new Error(
        parsed.message ||
          (warm.stderr.trim() || warm.stdout.trim() || 'RapidOCR model warmup failed').slice(0, 1200),
      );
    }
    const probe = await probeRapidOcr(config, { refresh: true });
    if (!probe.ok) throw new Error(probe.message ?? 'RapidOCR did not become importable');
    report({ phase: 'done', percent: 100, message: '本地 OCR 已就绪。' });
    return { ok: true, python: managedPython, version: probe.version };
  } catch (error) {
    await rm(venvDir, { recursive: true, force: true }).catch(() => {});
    clearRapidOcrProbe();
    return { ok: false, code: 'INSTALL_FAILED', message: errorMessage(error) };
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}
