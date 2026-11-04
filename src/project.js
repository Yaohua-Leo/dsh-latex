/**
 * LaTeX project / root-document resolution.
 *
 * The hard part of a LaTeX tool is not running latexmk, it is deciding *which*
 * document a chapter file belongs to. The rules implemented here follow the
 * practical subset LaTeX Workshop established:
 *
 *   1. an explicitly requested main file always wins;
 *   2. `% !TEX root = ...` in the edited file wins over structure guesses;
 *   3. a file that itself declares `\documentclass` is a root;
 *   4. otherwise walk the reverse `\input` / `\include` graph to the documents
 *      that pull the edited file in, preferring conventional main-file names;
 *   5. without any file reference, search the working directory for a single
 *      plausible root document.
 *
 * The dependency index is cached per scan root. `invalidate()` is called from
 * the source watcher so a newly added `\input` is picked up before the next
 * build; resolution never trusts a stale index for longer than its TTL.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isUncPath } from './util.js';

const MAGIC_ROOT_RE = /^[ \t]*%+[ \t]*!?[ \t]*TEX[ \t]+root[ \t]*=[ \t]*(.+?)[ \t]*$/gim;
const MAGIC_PROGRAM_RE = /^[ \t]*%+[ \t]*!?[ \t]*TEX[ \t]+(?:program|TS-program)[ \t]*=[ \t]*([A-Za-z]+)/gim;
const MAGIC_ENCODING_RE = /^[ \t]*%+[ \t]*!?[ \t]*TEX[ \t]+encoding[ \t]*=[ \t]*([A-Za-z0-9_-]+)/gim;
const DOCUMENTCLASS_RE = /\\documentclass\b/;
const BEGIN_DOCUMENT_RE = /\\begin\s*\{document\}/;
const INPUT_RE = /\\(input|include|subfile|InputIfFileExists)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
const PLAIN_INPUT_RE = /\\input\s+([^\s{}\\]+)/g;
const IMPORT_RE = /\\import\s*\{([^{}]*)\}\s*\{([^{}]+)\}/g;

const PREFERRED_ROOTS = new Map([
  ['main.tex', 0],
  ['paper.tex', 1],
  ['thesis.tex', 2],
  ['dissertation.tex', 3],
  ['article.tex', 4],
  ['document.tex', 5],
  ['root.tex', 6],
  ['book.tex', 7],
  ['report.tex', 8],
  ['manuscript.tex', 9],
  ['latex.tex', 10],
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.dsh-latex',
  '.cache',
  '__pycache__',
  'dist',
  '.venv',
  'venv',
  'site-packages',
]);

const MAX_INDEX_FILES = 6000;
const INDEX_TTL_MS = 10_000;

/** A resolution failure that is safe to surface to the model verbatim. */
export class ProjectResolutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectResolutionError';
    this.code = details.code ?? 'LATEX_PROJECT_UNRESOLVED';
    this.details = details;
  }
}

function mergeMagic(text, file) {
  const result = { root: undefined, program: undefined, encoding: undefined };
  if (typeof text !== 'string') return result;
  const head = text.slice(0, 64 * 1024);
  for (const match of head.matchAll(MAGIC_ROOT_RE)) {
    const raw = match[1].trim().replace(/^["']|["']$/g, '');
    if (raw !== '') result.root = raw;
  }
  for (const match of head.matchAll(MAGIC_PROGRAM_RE)) {
    const program = match[1].toLowerCase();
    if (['xelatex', 'pdflatex', 'lualatex'].includes(program)) result.program = program;
  }
  for (const match of head.matchAll(MAGIC_ENCODING_RE)) {
    result.encoding = match[1];
  }
  return result;
}

/** Remove LaTeX comments without touching `\%` or `\\%`. */
function stripComments(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/(?<!\\)%.*$/, ''))
    .join('\n');
}

function cleanReference(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (value === '' || value.length > 400) return undefined;
  if (/[\\#{}\s]/.test(value)) return undefined;
  return value.replace(/^\.\//, '');
}

/**
 * Extract the source references of one `.tex` file.
 * @returns {string[]} raw (unresolved) reference strings
 */
export function extractReferences(text) {
  const references = [];
  const stripped = stripComments(text);
  for (const match of stripped.matchAll(INPUT_RE)) {
    const reference = cleanReference(match[2]);
    if (reference) references.push(reference);
  }
  for (const match of stripped.matchAll(PLAIN_INPUT_RE)) {
    const reference = cleanReference(match[1]);
    if (reference) references.push(reference);
  }
  for (const match of stripped.matchAll(IMPORT_RE)) {
    const dir = cleanReference(match[1]) ?? '';
    const file = cleanReference(match[2]);
    if (file) references.push(path.posix.join(dir.replace(/\\/g, '/'), file));
  }
  return [...new Set(references)];
}

function looksLikeDocument(text) {
  const stripped = stripComments(text);
  return DOCUMENTCLASS_RE.test(stripped)
    ? 'documentclass'
    : BEGIN_DOCUMENT_RE.test(stripped)
      ? 'document'
      : undefined;
}

async function readTex(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function listTexFiles(root, { skipDirNames } = {}) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (found.length >= MAX_INDEX_FILES) break;
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth >= 8) continue;
        const name = entry.name.toLowerCase();
        if (name.startsWith('.') || SKIP_DIRS.has(name) || skipDirNames.has(name)) continue;
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex')) {
        found.push(path.join(current.dir, entry.name));
        if (found.length >= MAX_INDEX_FILES) break;
      }
    }
  }
  return found;
}

function resolveReference(referenceCandidates, sourceDir, scanRoot) {
  const value = referenceCandidates;
  const withExt = path.extname(value) === '' ? `${value}.tex` : value;
  const bases = [sourceDir];
  if (scanRoot && path.resolve(scanRoot) !== path.resolve(sourceDir)) bases.push(scanRoot);
  const results = [];
  for (const base of bases) {
    for (const candidate of [value, withExt]) {
      const absolute = path.resolve(base, candidate);
      results.push(absolute);
    }
  }
  return results;
}

function preferredRank(file) {
  const name = path.basename(file).toLowerCase();
  if (PREFERRED_ROOTS.has(name)) return PREFERRED_ROOTS.get(name);
  return 50;
}

async function chooseScanRoot(fileDir, cwd) {
  // Prefer the nearest project container: a chapter in `sections/` normally
  // belongs to a document one or two directories above. Walking up first keeps
  // a workspace with many unrelated projects from being indexed wholesale.
  let current = fileDir;
  for (let depth = 0; depth < 4; depth += 1) {
    if (depth > 0) {
      const marker = await stat(path.join(current, '.git')).catch(() => undefined);
      if (marker?.isDirectory()) return current;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      const topLevelRoots = entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.tex') &&
          PREFERRED_ROOTS.has(entry.name.toLowerCase()),
      );
      if (topLevelRoots.length > 0) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (cwd) {
    const relative = path.relative(cwd, fileDir);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return cwd;
  }
  return fileDir;
}

/** Cached reverse-dependency index for one scan root. */
class DependencyIndex {
  constructor(root, buildDirName) {
    this.root = root;
    this.buildDirName = buildDirName;
    this.at = 0;
    this.files = new Map();
  }

  async refresh() {
    const skip = new Set();
    if (this.buildDirName) skip.add(this.buildDirName.toLowerCase());
    const files = await listTexFiles(this.root, { skipDirNames: skip });
    const table = new Map();
    await Promise.all(
      files.map(async (file) => {
        const text = await readTex(file);
        if (text === undefined) return;
        const magic = mergeMagic(text, file);
        const document = looksLikeDocument(text);
        const references = extractReferences(text);
        table.set(file, { file, text, magic, document, references, inputs: [] });
      }),
    );
    for (const record of table.values()) {
      const targets = [];
      for (const reference of record.references) {
        for (const candidate of resolveReference(reference, path.dirname(record.file), this.root)) {
          if (table.has(candidate) && candidate !== record.file) {
            targets.push(candidate);
            break;
          }
        }
      }
      record.inputs = [...new Set(targets)];
    }
    this.files = table;
    this.at = Date.now();
  }

  get stale() {
    return Date.now() - this.at > INDEX_TTL_MS;
  }

  rootsReferencing(target) {
    const reverse = new Map();
    for (const record of this.files.values()) {
      for (const input of record.inputs) {
        let bucket = reverse.get(input);
        if (!bucket) {
          bucket = new Set();
          reverse.set(input, bucket);
        }
        bucket.add(record.file);
      }
    }
    const documents = new Set();
    const visited = new Set([target]);
    const queue = [target];
    let steps = 0;
    while (queue.length > 0 && steps < 2000) {
      steps += 1;
      const current = queue.shift();
      for (const parent of reverse.get(current) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        queue.push(parent);
        const record = this.files.get(parent);
        if (record?.document) documents.add(parent);
      }
    }
    return [...documents];
  }

  candidatesInDirectory(directory, deep = true) {
    const prefix = path.resolve(directory);
    const result = [];
    for (const record of this.files.values()) {
      if (!record.document) continue;
      const relative = path.relative(prefix, record.file);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const depth = relative.split(path.sep).length - 1;
      if (!deep && depth > 0) continue;
      result.push({ file: record.file, depth, document: record.document });
    }
    return result;
  }
}

/** Resolve a file reference that may be relative to `cwd` or to `fileDir`. */
async function resolveInputPath(value, { cwd, fileDir }) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const candidate = value.trim();
  if (path.isAbsolute(candidate)) return path.resolve(candidate);
  const bases = [];
  if (cwd) bases.push(cwd);
  if (fileDir) bases.push(fileDir);
  for (const base of bases) {
    const resolved = path.resolve(base, candidate);
    if (await stat(resolved).catch(() => undefined)) return resolved;
    if (path.extname(resolved).toLowerCase() !== '.tex') {
      const withExt = `${resolved}.tex`;
      if (await stat(withExt).catch(() => undefined)) return withExt;
    }
  }
  return path.resolve(cwd ?? fileDir ?? process.cwd(), candidate);
}

export class ProjectResolver {
  /**
   * @param {ReturnType<typeof import('./config.js').normalizeConfig>} config
   * @param {{ info: Function, warn: Function, error: Function }} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.indexes = new Map();
  }

  /** Drop cached indexes overlapping `changedPath` (or all of them). */
  invalidate(changedPath) {
    if (changedPath === undefined) {
      this.indexes.clear();
      return;
    }
    for (const root of [...this.indexes.keys()]) {
      const relative = path.relative(root, changedPath);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        this.indexes.delete(root);
      }
    }
  }

  async #index(root) {
    let index = this.indexes.get(root);
    if (!index) {
      index = new DependencyIndex(root, this.config.buildDir);
      this.indexes.set(root, index);
    }
    if (index.at === 0 || index.stale) await index.refresh();
    return index;
  }

  async describeMagic(file) {
    const text = await readTex(file);
    return mergeMagic(text ?? '', file);
  }

  /**
   * Resolve a project.
   * @param {{ file?: string, mainFile?: string, project?: string, cwd?: string }} input
   * @returns {Promise<{ rootDir: string, mainFile: string, source: string, engineHint?: string, encoding?: string }>}
   */
  async resolve(input = {}) {
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? path.resolve(input.cwd) : undefined;
    if (cwd) this.assertSafePath(cwd);
    let file = input.file ? path.resolve(cwd ?? '.', input.file) : undefined;
    if (file) this.assertSafePath(file);
    let mainFile = undefined;

    // `file` may also be a project directory (the tools document this).
    let projectHint = input.project ?? input.mainFile;
    if (file && (projectHint === undefined || projectHint === '')) {
      const info = await stat(file).catch(() => undefined);
      if (info?.isDirectory()) {
        projectHint = file;
        file = undefined;
      }
    }

    // `project` accepts either a main .tex file or a directory containing one.
    if (typeof projectHint === 'string' && projectHint.trim() !== '') {
      this.assertSafePath(projectHint);
      const resolved = await resolveInputPath(projectHint, {
        cwd,
        fileDir: file ? path.dirname(file) : undefined,
      });
      this.assertSafePath(resolved);
      const info = await stat(resolved).catch(() => undefined);
      if (info?.isDirectory()) {
        const found = await this.findMainInDirectory(resolved, { deep: false });
        if (found.length === 0) {
          throw new ProjectResolutionError(
            `No LaTeX root document found in ${resolved}. Pass the main .tex file explicitly.`,
            { code: 'LATEX_NO_ROOT_DOCUMENT', directory: resolved },
          );
        }
        if (found.length > 1) {
          throw new ProjectResolutionError(
            `Multiple LaTeX root documents found in ${resolved}: ${found.join(', ')}. Pass one explicitly.`,
            { code: 'LATEX_AMBIGUOUS_ROOT', candidates: found },
          );
        }
        mainFile = found[0];
      } else {
        mainFile = resolved;
      }
    }

    if (mainFile) {
      if (path.extname(mainFile).toLowerCase() !== '.tex') {
        const withExt = `${mainFile}.tex`;
        mainFile = (await stat(withExt).catch(() => undefined)) ? withExt : mainFile;
      }
      const info = await stat(mainFile).catch(() => undefined);
      if (!info?.isFile()) {
        throw new ProjectResolutionError(`Main file not found: ${mainFile}`, {
          code: 'LATEX_MAIN_NOT_FOUND',
          file: mainFile,
        });
      }
      this.assertSafePath(mainFile);
      const magic = await this.describeMagic(mainFile);
      this.assertAllowed(mainFile);
      return {
        rootDir: path.dirname(mainFile),
        mainFile,
        source: 'explicit',
        engineHint: magic.program,
        encoding: magic.encoding,
      };
    }

    if (!file) {
      if (!cwd) {
        throw new ProjectResolutionError(
          'No LaTeX project could be identified. Pass a .tex path, a main file, or a working directory.',
          { code: 'LATEX_NO_INPUT' },
        );
      }
      const found = await this.findMainInDirectory(cwd, { deep: false });
      if (found.length === 0) {
        const deeper = await this.findMainInDirectory(cwd, { deep: true });
        if (deeper.length === 0) {
          throw new ProjectResolutionError(
            `No LaTeX root document found under ${cwd}. Pass the main .tex file explicitly.`,
            { code: 'LATEX_NO_ROOT_DOCUMENT', directory: cwd },
          );
        }
        if (deeper.length === 1) {
          return await this.#success(deeper[0], 'search');
        }
        throw new ProjectResolutionError(
          `Several LaTeX root documents exist under ${cwd}: ${deeper.join(', ')}. Pass one explicitly.`,
          { code: 'LATEX_AMBIGUOUS_ROOT', candidates: deeper },
        );
      }
      const ranked = this.#rank(found);
      if (ranked.length > 1) {
        throw new ProjectResolutionError(
          `Several LaTeX root documents exist in ${cwd}: ${ranked.join(', ')}. Pass one explicitly.`,
          { code: 'LATEX_AMBIGUOUS_ROOT', candidates: ranked },
        );
      }
      return await this.#success(ranked[0], 'search');
    }

    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      throw new ProjectResolutionError(`File not found: ${file}`, {
        code: 'LATEX_FILE_NOT_FOUND',
        file,
      });
    }
    this.assertAllowed(file);
    const text = await readTex(file);
    const magic = mergeMagic(text ?? '', file);

    // 2. A magic root comment is an explicit user instruction.
    if (magic.root) {
      const rootCandidate = path.resolve(path.dirname(file), magic.root);
      this.assertSafePath(rootCandidate);
      const withExt =
        path.extname(rootCandidate) === '' ? `${rootCandidate}.tex` : rootCandidate;
      const rootInfo = await stat(withExt).catch(() => undefined);
      if (rootInfo?.isFile()) {
        // The magic directive may point outside the allowlist; enforce the same
        // boundary the explicit-main and search branches enforce.
        this.assertAllowed(withExt);
        this.assertAllowed(path.dirname(withExt));
        return {
          rootDir: path.dirname(withExt),
          mainFile: withExt,
          source: 'magic',
          engineHint: magic.program,
          encoding: magic.encoding,
        };
      }
      throw new ProjectResolutionError(
        `The % !TEX root directive in ${file} points to a missing file: ${withExt}`,
        { code: 'LATEX_MAGIC_ROOT_MISSING', file, mainFile: withExt },
      );
    }

    // 3. The file is a document itself.
    if (looksLikeDocument(text ?? '') === 'documentclass') {
      return {
        rootDir: path.dirname(file),
        mainFile: file,
        source: 'self',
        engineHint: magic.program,
        encoding: magic.encoding,
      };
    }

    // 4. Reverse dependency walk.
    const scanRoot = await chooseScanRoot(path.dirname(file), cwd);
    const index = await this.#index(scanRoot);
    const candidates = index.rootsReferencing(file);
    if (candidates.length === 1) {
      return await this.#success(candidates[0], 'reference');
    }
    if (candidates.length > 1) {
      const ranked = this.#rank(candidates);
      if (ranked.length === 1) return await this.#success(ranked[0], 'reference');
      throw new ProjectResolutionError(
        `${file} is included by several LaTeX root documents: ${ranked.join(', ')}. ` +
          'Pass the intended main file explicitly, or add a `% !TEX root = ...` directive.',
        { code: 'LATEX_AMBIGUOUS_ROOT', candidates: ranked, file },
      );
    }

    // 5. Fall back to the working directory when it contains one plausible root.
    if (cwd) {
      const foundInCwd = await this.findMainInDirectory(cwd, { deep: false });
      const ranked = this.#rank(foundInCwd);
      if (ranked.length === 1) return await this.#success(ranked[0], 'search');
    }

    throw new ProjectResolutionError(
      `${file} does not declare a document and is not referenced by any LaTeX root document under ${scanRoot}. ` +
        'Open the main file, pass it explicitly, or add a `% !TEX root = ...` directive.',
      { code: 'LATEX_ORPHAN_TEX', file, scanRoot },
    );
  }

  async #success(mainFile, source) {
    this.assertSafePath(mainFile);
    this.assertAllowed(mainFile);
    const magic = await this.describeMagic(mainFile);
    return {
      rootDir: path.dirname(mainFile),
      mainFile,
      source,
      engineHint: magic.program,
      encoding: magic.encoding,
    };
  }

  /** Rank candidates, returning only the best tier when it is unique. */
  #rank(candidates) {
    const unique = [...new Set(candidates)];
    const scored = unique
      .map((file) => ({
        file,
        rank: preferredRank(file),
        depth: file.split(path.sep).length,
      }))
      .sort((a, b) => a.rank - b.rank || a.depth - b.depth);
    if (scored.length > 1 && scored[0].rank < scored[1].rank) return [scored[0].file];
    return scored.map((entry) => entry.file);
  }

  /** Pick plausible root documents inside `directory`. */
  async findMainInDirectory(directory, { deep = false } = {}) {
    const resolved = path.resolve(directory);
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isDirectory()) return [];
    const direct = await this.#scanDirectory(resolved, deep);
    if (direct.length > 0) return direct;
    const index = await this.#index(resolved);
    return index.candidatesInDirectory(resolved, deep).map((entry) => entry.file);
  }

  async #scanDirectory(directory, deep) {
    const files = await listTexFiles(directory, {
      skipDirNames: new Set([this.config.buildDir.toLowerCase()]),
    });
    const found = [];
    for (const file of files) {
      const relative = path.relative(directory, file);
      const depth = relative.split(path.sep).length - 1;
      if (!deep && depth > 2) continue;
      const text = await readTex(file);
      if (text === undefined) continue;
      const stripped = stripComments(text);
      if (!DOCUMENTCLASS_RE.test(stripped) && !BEGIN_DOCUMENT_RE.test(stripped)) continue;
      found.push(file);
    }
    return found;
  }

  /** Enforce the optional allowed-root boundary. */
  assertAllowed(target) {
    const roots = this.config.allowedRoots;
    if (!Array.isArray(roots) || roots.length === 0) return;
    const resolved = path.resolve(target);
    for (const root of roots) {
      const relative = path.relative(root, resolved);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
    }
    throw new ProjectResolutionError(
      `Path is outside the configured LaTeX allowedRoots: ${target}`,
      { code: 'LATEX_PATH_NOT_ALLOWED', file: target, allowedRoots: roots },
    );
  }

  /**
   * Reject UNC/network paths before any filesystem access. `stat()` on a UNC
   * path can initiate an SMB connection (and an NTLM exchange) even when the
   * target does not exist, so this check must run before `stat`.
   */
  assertSafePath(target) {
    if (isUncPath(String(target ?? ''))) {
      throw new ProjectResolutionError(
        `UNC/network paths are not supported by the LaTeX plugin: ${target}`,
        { code: 'LATEX_UNC_PATH', file: String(target) },
      );
    }
  }
}
