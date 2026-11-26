/**
 * Config normalization for the `latex` bundle row.
 *
 * The values arrive from `cordis.patch.yml` (or a profile override) as a plain
 * object. Nothing here trusts them: every field is bounded and a malformed
 * value falls back to the documented default instead of failing plugin load.
 */
import path from 'node:path';

/**
 * Default TeX bin directory.
 *
 * An empty value means "discover `latexmk` from the process PATH (or the
 * `DSH_LATEX_TEX_BIN` environment variable)". This keeps a fresh install
 * portable; machines with a non-PATH TeX Live set `texBinDir` explicitly.
 */
export const DEFAULT_TEX_BIN_DIR = '';
export const ENGINES = Object.freeze(['xelatex', 'pdflatex', 'lualatex']);

const ENGINE_FLAGS = Object.freeze({
  xelatex: '-xelatex',
  pdflatex: '-pdf',
  lualatex: '-pdflua',
});

/** Bundled defaults; also the shape documented in README.md. */
export function defaultConfig() {
  return {
    texBinDir: DEFAULT_TEX_BIN_DIR,
    latexmkPath: '',
    engine: 'xelatex',
    buildDir: 'build',
    autoBuild: true,
    debounceMs: 800,
    timeoutMs: 180_000,
    preserveLastGood: true,
    autoOpenPreview: true,
    previewSurface: 'native',
    allowedRoots: [],
    extraLatexmkArgs: [],
    maxConcurrentBuilds: 2,
    maxPrintLine: 2000,
    respectLatexmkrc: true,
    allowProjectLatexmkrc: true,
    allowShellEscape: false,
    editorAutoSave: true,
    editorAutoSaveDelayMs: 900,
    keepBuildLogTail: 1_048_576,
    watchExtraExtensions: [],
    // Agent-facing page rendering (`latex_look`).
    renderDpi: 120,
    renderEngine: 'auto',
    renderTimeoutMs: 30_000,
    lookMaxPixels: 4_000_000,
    lookCacheKeep: 2,
    // Preview annotations.
    annotationsMaxItems: 200,
    annotationsMaxBytes: 262_144,
    annotationImageMaxBytes: 5_242_880,
    // Cross-process lock around annotation read-modify-write cycles.
    annotationsLockWaitMs: 5_000,
    annotationsLockStaleMs: 15_000,
    // Whole-document audit (`latex_audit`).
    auditMaxPages: 30,
    auditDpi: 100,
    auditMaxImages: 3,
    // Preview screenshot questions and optional local OCR.
    askImageMaxBytes: 8_388_608,
    ocrEnabled: 'auto',
    ocrEngine: 'auto',
    ocrPython: '',
    ocrInstallDir: '',
    ocrInstallTimeoutMs: 900_000,
    ocrLanguages: 'eng',
    ocrTimeoutMs: 20_000,
    // Optional regex rules for `latex_layout_lint` (submission/competition rules).
    layoutRules: [],
    // Optional one-click TinyTeX install (explicit user action).
    toolchainDir: '',
    toolchainUrl: '',
    toolchainSha256: '',
    toolchainTimeoutMs: 600_000,
  };
}

function text(value, fallback, maxLength = 4096) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.slice(0, maxLength);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function stringList(value, maxItems = 64) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.length > 2048) continue;
    result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}

/** Bounded, shape-checked layout rules for the paper checks. */
function normalizeLayoutRules(value) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.pattern !== 'string' || entry.pattern.trim() === '') continue;
    if (entry.pattern.length > 500) continue;
    const rule = {
      pattern: entry.pattern,
      message: typeof entry.message === 'string' ? entry.message.slice(0, 300) : undefined,
      severity: entry.severity === 'error' ? 'error' : 'warning',
      target: entry.target === 'aux' || entry.target === 'log' ? entry.target : 'all',
      code: typeof entry.code === 'string' ? entry.code.slice(0, 60) : undefined,
    };
    rules.push(rule);
    if (rules.length >= 20) break;
  }
  return rules;
}

/**
 * Normalize a raw bundle config.
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = defaultConfig();
  const engine = ENGINES.includes(source.engine) ? source.engine : defaults.engine;
  const buildDirRaw = text(source.buildDir, defaults.buildDir, 512);
  const buildDir =
    path.isAbsolute(buildDirRaw) || buildDirRaw.split(/[\\/]+/).includes('..')
      ? defaults.buildDir
      : buildDirRaw;
  const previewSurface =
    source.previewSurface === 'document' || source.previewSurface === 'native'
      ? source.previewSurface
      : defaults.previewSurface;
  const maxPrintLine = integer(source.maxPrintLine, defaults.maxPrintLine, 79, 100_000);
  const envBin = typeof process.env.DSH_LATEX_TEX_BIN === 'string' ? process.env.DSH_LATEX_TEX_BIN.trim() : '';
  const configuredBin =
    typeof source.texBinDir === 'string' && source.texBinDir.trim() !== ''
      ? source.texBinDir.trim()
      : envBin;
  return {
    texBinDir: configuredBin === '' ? '' : path.normalize(configuredBin),
    latexmkPath: text(source.latexmkPath, '', 1024),
    engine,
    engineFlag: ENGINE_FLAGS[engine],
    buildDir,
    autoBuild: bool(source.autoBuild, defaults.autoBuild),
    debounceMs: integer(source.debounceMs, defaults.debounceMs, 100, 30_000),
    timeoutMs: integer(source.timeoutMs, defaults.timeoutMs, 5_000, 3_600_000),
    preserveLastGood: bool(source.preserveLastGood, defaults.preserveLastGood),
    autoOpenPreview: bool(source.autoOpenPreview, defaults.autoOpenPreview),
    previewSurface,
    allowedRoots: stringList(source.allowedRoots, 32).map((entry) => path.resolve(entry)),
    extraLatexmkArgs: stringList(source.extraLatexmkArgs, 32),
    maxConcurrentBuilds: integer(source.maxConcurrentBuilds, defaults.maxConcurrentBuilds, 1, 8),
    maxPrintLine,
    respectLatexmkrc: bool(source.respectLatexmkrc, defaults.respectLatexmkrc),
    // Project rc files are executable Perl. Honouring them is the documented
    // default because a project's own recipe is part of its build contract;
    // setting this false passes -norc.
    allowProjectLatexmkrc: bool(source.allowProjectLatexmkrc, defaults.allowProjectLatexmkrc),
    // `-no-shell-escape` is passed unless a project explicitly opts in.
    allowShellEscape: bool(source.allowShellEscape, defaults.allowShellEscape),
    editorAutoSave: bool(source.editorAutoSave, defaults.editorAutoSave),
    editorAutoSaveDelayMs: integer(
      source.editorAutoSaveDelayMs,
      defaults.editorAutoSaveDelayMs,
      300,
      10_000,
    ),
    keepBuildLogTail: integer(source.keepBuildLogTail, defaults.keepBuildLogTail, 65_536, 8_388_608),
    watchExtraExtensions: stringList(source.watchExtraExtensions, 32).map((entry) =>
      entry.startsWith('.') ? entry.toLowerCase() : `.${entry.toLowerCase()}`,
    ),
    renderDpi: integer(source.renderDpi, defaults.renderDpi, 36, 300),
    renderEngine: ['auto', 'pdftoppm', 'ghostscript', 'mutool'].includes(source.renderEngine)
      ? source.renderEngine
      : defaults.renderEngine,
    renderTimeoutMs: integer(source.renderTimeoutMs, defaults.renderTimeoutMs, 5_000, 120_000),
    lookMaxPixels: integer(source.lookMaxPixels, defaults.lookMaxPixels, 100_000, 50_000_000),
    lookCacheKeep: integer(source.lookCacheKeep, defaults.lookCacheKeep, 1, 5),
    annotationsMaxItems: integer(source.annotationsMaxItems, defaults.annotationsMaxItems, 1, 2000),
    annotationsMaxBytes: integer(
      source.annotationsMaxBytes,
      defaults.annotationsMaxBytes,
      16_384,
      8_388_608,
    ),
    annotationImageMaxBytes: integer(
      source.annotationImageMaxBytes,
      defaults.annotationImageMaxBytes,
      65_536,
      20 * 1024 * 1024,
    ),
    annotationsLockWaitMs: integer(
      source.annotationsLockWaitMs,
      defaults.annotationsLockWaitMs,
      200,
      60_000,
    ),
    annotationsLockStaleMs: integer(
      source.annotationsLockStaleMs,
      defaults.annotationsLockStaleMs,
      1_000,
      300_000,
    ),
    auditMaxPages: integer(source.auditMaxPages, defaults.auditMaxPages, 1, 60),
    auditDpi: integer(source.auditDpi, defaults.auditDpi, 36, 300),
    auditMaxImages: integer(source.auditMaxImages, defaults.auditMaxImages, 0, 5),
    askImageMaxBytes: integer(source.askImageMaxBytes, defaults.askImageMaxBytes, 65_536, 20 * 1024 * 1024),
    ocrEnabled: ['auto', 'always', 'off'].includes(source.ocrEnabled)
      ? source.ocrEnabled
      : defaults.ocrEnabled,
    ocrEngine: ['auto', 'rapidocr', 'tesseract', 'off'].includes(source.ocrEngine)
      ? source.ocrEngine
      : defaults.ocrEngine,
    ocrPython: text(source.ocrPython, defaults.ocrPython, 1024),
    ocrInstallDir: text(source.ocrInstallDir, defaults.ocrInstallDir, 1024),
    ocrInstallTimeoutMs: integer(source.ocrInstallTimeoutMs, defaults.ocrInstallTimeoutMs, 60_000, 3_600_000),
    ocrLanguages: text(source.ocrLanguages, defaults.ocrLanguages, 128),
    ocrTimeoutMs: integer(source.ocrTimeoutMs, defaults.ocrTimeoutMs, 3_000, 120_000),
    layoutRules: normalizeLayoutRules(source.layoutRules),
    toolchainDir: text(source.toolchainDir, '', 1024),
    toolchainUrl: text(source.toolchainUrl, '', 2048),
    toolchainSha256: text(source.toolchainSha256, '', 128),
    toolchainTimeoutMs: integer(source.toolchainTimeoutMs, defaults.toolchainTimeoutMs, 30_000, 3_600_000),
  };
}

/** The model-facing view of the effective config (no secrets exist here). */
export function publicConfig(config) {
  return {
    engine: config.engine,
    buildDir: config.buildDir,
    autoBuild: config.autoBuild,
    debounceMs: config.debounceMs,
    timeoutMs: config.timeoutMs,
    previewSurface: config.previewSurface,
    preserveLastGood: config.preserveLastGood,
    texBinDir: config.texBinDir,
    latexmkPath: config.latexmkPath,
    autoOpenPreview: config.autoOpenPreview,
    maxConcurrentBuilds: config.maxConcurrentBuilds,
    allowProjectLatexmkrc: config.allowProjectLatexmkrc,
    allowShellEscape: config.allowShellEscape,
    editorAutoSave: config.editorAutoSave,
    editorAutoSaveDelayMs: config.editorAutoSaveDelayMs,
    renderDpi: config.renderDpi,
    renderEngine: config.renderEngine,
    lookMaxPixels: config.lookMaxPixels,
    annotationsMaxItems: config.annotationsMaxItems,
    annotationsMaxBytes: config.annotationsMaxBytes,
    annotationImageMaxBytes: config.annotationImageMaxBytes,
    auditMaxPages: config.auditMaxPages,
    auditDpi: config.auditDpi,
    auditMaxImages: config.auditMaxImages,
    askImageMaxBytes: config.askImageMaxBytes,
    ocrEnabled: config.ocrEnabled,
    ocrLanguages: config.ocrLanguages,
    ocrEngine: config.ocrEngine,
    ocrInstallDir: config.ocrInstallDir,
    toolchainDir: config.toolchainDir,
    toolchainUrl: config.toolchainUrl,
  };
}
