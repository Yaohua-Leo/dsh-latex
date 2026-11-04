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
    keepBuildLogTail: 1_048_576,
    watchExtraExtensions: [],
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
    keepBuildLogTail: integer(source.keepBuildLogTail, defaults.keepBuildLogTail, 65_536, 8_388_608),
    watchExtraExtensions: stringList(source.watchExtraExtensions, 32).map((entry) =>
      entry.startsWith('.') ? entry.toLowerCase() : `.${entry.toLowerCase()}`,
    ),
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
  };
}
