/**
 * The latexmk build backend.
 *
 * One `LatexBuilder` owns the toolbox probe and the actual spawn. The service
 * layer owns per-project queues and state; this module owns argv construction,
 * the child process, the .log parse and the atomic publication of the last
 * successful PDF.
 *
 * Non-negotiable invariants:
 *  - no shell: latexmk receives an argv array through ctx.subprocess;
 *  - no shell-escape: the flag is never added and callers cannot inject it;
 *  - the previous preview survives a failed build because publication happens
 *    only after a successful, diagnostic-clean build.
 */
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseBibLog, parseLatexLog } from './logparse.js';
import { atomicCopy, atomicWriteText, errorMessage, isInside, tailText } from './util.js';

/** Auxiliary files a LaTeX run may create inside the build directory. */
export const AUX_EXTENSIONS = new Set([
  '.aux',
  '.log',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.bbl',
  '.blg',
  '.bcf',
  '.run.xml',
  '.nav',
  '.snm',
  '.vrb',
  '.xdv',
  '.dvi',
  '.idx',
  '.ind',
  '.ilg',
  '.glo',
  '.gls',
  '.glg',
  '.ist',
  '.acn',
  '.acr',
  '.alg',
  '.loa',
  '.lol',
  '.fls',
  '.fdb_latexmk',
  '.synctex.gz',
  '.synctex',
  '.synctex(busy)',
  '.spl',
  '.thm',
  '.brf',
]);

const ENGINE_ARGS = Object.freeze({
  xelatex: '-xelatex',
  pdflatex: '-pdf',
  lualatex: '-pdflua',
});

function suffixOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.run.xml')) return '.run.xml';
  if (lower.endsWith('.synctex.gz')) return '.synctex.gz';
  if (lower.endsWith('.synctex(busy)')) return '.synctex(busy)';
  if (lower.endsWith('.spl')) return '.spl';
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

/** Build a process env that makes a PATH-less TeX Live work. */
export function buildEnv(config, extra = {}, binDir = config.texBinDir) {
  const pathValue = [binDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  return {
    PATH: pathValue,
    Path: pathValue,
    // TeX wraps log lines at 79 columns by default; a wider line keeps
    // diagnostics readable and makes the parser's job deterministic.
    max_print_line: String(config.maxPrintLine),
    ...extra,
  };
}

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

/** Candidate file names for one TeX executable on this platform. */
function executableNames(name) {
  if (process.platform !== 'win32') return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

/** Find one executable in DSH_LATEX_TEX_BIN or the process PATH. */
async function findExecutable(name) {
  const dirs = [
    process.env.DSH_LATEX_TEX_BIN,
    ...String(process.env.PATH ?? '').split(path.delimiter),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const candidateName of executableNames(name)) {
      const candidate = path.join(dir, candidateName);
      const info = await stat(candidate).catch(() => undefined);
      if (info?.isFile()) return candidate;
    }
  }
  return undefined;
}

/** Probe the configured (or PATH-discovered) TeX Live toolchain without building. */
export async function probeToolchain(config) {
  const explicitBin = config.texBinDir ? path.resolve(config.texBinDir) : '';
  let latexmk = config.latexmkPath ? path.resolve(config.latexmkPath) : '';
  if (!latexmk && explicitBin) latexmk = path.join(explicitBin, `latexmk${EXE_SUFFIX}`);
  if (!latexmk) latexmk = (await findExecutable('latexmk')) ?? `latexmk${EXE_SUFFIX}`;
  const binDir = explicitBin || (path.isAbsolute(latexmk) ? path.dirname(latexmk) : '');
  const tools = ['latexmk', 'xelatex', 'pdflatex', 'lualatex', 'biber', 'bibtex', 'synctex'];
  const found = {};
  for (const tool of tools) {
    let candidate = tool === 'latexmk' ? latexmk : binDir ? path.join(binDir, `${tool}${EXE_SUFFIX}`) : '';
    if (!candidate || !(await stat(candidate).catch(() => undefined))?.isFile()) {
      candidate = (await findExecutable(tool)) ?? candidate;
    }
    const info = candidate ? await stat(candidate).catch(() => undefined) : undefined;
    found[tool] = { path: candidate || tool, exists: Boolean(info?.isFile()) };
  }
  return { binDir, latexmk, tools: found };
}

export class LatexBuilder {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {ReturnType<typeof import('./config.js').normalizeConfig>} config
   * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} logger
   */
  constructor(ctx, config, logger) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.toolchain = undefined;
    this.toolchainCheckedAt = 0;
  }

  async subprocessService() {
    const service = this.ctx.get('subprocess');
    if (!service) throw new Error('The DSH subprocess service is not available in this profile.');
    return service;
  }

  async checkToolchain({ refresh = false } = {}) {
    if (!refresh && this.toolchain && Date.now() - this.toolchainCheckedAt < 30_000) {
      return this.toolchain;
    }
    const probed = await probeToolchain(this.config);
    const missing = Object.entries(probed.tools)
      .filter(([, value]) => !value.exists)
      .map(([name]) => name);
    this.toolchain = {
      ...probed,
      missing,
      ok: missing.length === 0,
      checkedAt: new Date().toISOString(),
    };
    this.toolchainCheckedAt = Date.now();
    if (!probed.tools.latexmk.exists) {
      this.logger.warn(
        'latexmk was not found at %s. Set texBinDir/latexmkPath in the latex bundle config.',
        probed.latexmk,
      );
    }
    return this.toolchain;
  }

  /**
   * Paths belonging to a resolved project.
   * @param {{ rootDir: string, mainFile: string }} resolution
   */
  projectPaths(resolution) {
    const buildDirAbs = path.resolve(resolution.rootDir, this.config.buildDir);
    if (!isInside(resolution.rootDir, buildDirAbs)) {
      throw new Error(`Refusing to build outside the project root: ${buildDirAbs}`);
    }
    const stem = path.basename(resolution.mainFile, path.extname(resolution.mainFile));
    const stateDir = path.join(buildDirAbs, '.dsh-latex');
    // Several root documents may share one directory; each project gets its
    // own published preview, keyed by the main file.
    const fingerprint = createHash('sha1')
      .update(path.resolve(resolution.mainFile).replace(/\\/g, '/').toLowerCase())
      .digest('hex')
      .slice(0, 10);
    return {
      buildDirAbs,
      stateDir,
      pdfPath: path.join(buildDirAbs, `${stem}.pdf`),
      logPath: path.join(buildDirAbs, `${stem}.log`),
      previewPath: path.join(stateDir, `preview-${fingerprint}.pdf`),
      metaPath: path.join(stateDir, `last-build-${fingerprint}.json`),
      stem,
      fingerprint,
    };
  }

  /**
   * Run one latexmk build.
   *
   * @param {{ rootDir: string, mainFile: string, engine: string, paths: object }} project
   * @param {{ reason?: string, force?: boolean, engineExplicit?: boolean, signal?: AbortSignal, timeoutMs?: number }} options
   */
  async build(project, options = {}) {
    const subprocess = await this.subprocessService();
    const toolchain = await this.checkToolchain();
    if (!toolchain.tools.latexmk.exists) {
      throw new Error(
        `latexmk was not found at ${toolchain.latexmk}. Configure texBinDir or latexmkPath for the latex plugin.`,
      );
    }
    const engine = ENGINE_ARGS[project.engine] ? project.engine : 'xelatex';
    const paths = project.paths;
    await mkdir(paths.buildDirAbs, { recursive: true });
    await mkdir(paths.stateDir, { recursive: true });
    // TeX Live's `-outdir` does not create the subdirectories that `\include`
    // writes `.aux` files into; a multi-file project with `\include{sections/a}`
    // therefore fails with "I can't write on file `sections/a.aux'". Mirror
    // those directories in the build tree before latexmk starts.
    await this.#prepareIncludeDirectories(project);

    const rcPath = this.config.allowProjectLatexmkrc
      ? await this.#findProjectLatexmkrc(project.rootDir)
      : undefined;
    const args = [
      toolchain.latexmk,
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-recorder',
      `-outdir=${this.config.buildDir}`,
    ];
    // `-no-shell-escape` is the defence-in-depth default; a project that needs
    // \write18 must opt in explicitly (allowShellEscape or extraLatexmkArgs).
    if (!this.config.allowShellEscape) args.push('-no-shell-escape');
    if (!this.config.allowProjectLatexmkrc) args.push('-norc');
    const engineFlag = ENGINE_ARGS[engine];
    if (!rcPath || !this.config.respectLatexmkrc || options.engineExplicit) {
      args.push(engineFlag);
    }
    if (options.force === true) args.push('-gg');
    for (const extra of this.config.extraLatexmkArgs) {
      if (typeof extra === 'string' && extra !== '' && !extra.includes('\0')) args.push(extra);
    }
    const mainRelative = path.relative(project.rootDir, project.mainFile);
    if (mainRelative.startsWith('..') || path.isAbsolute(mainRelative)) {
      throw new Error(`Main file escapes the project root: ${project.mainFile}`);
    }
    args.push(mainRelative.replace(/\\/g, '/'));

    const startedAt = Date.now();
    // setTimeout overflows above 2^31-1 ms; cap at 24 hours.
    const timeoutMs = Math.min(
      86_400_000,
      Math.max(5_000, Number(options.timeoutMs) || this.config.timeoutMs),
    );
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    let abortReason;
    const timer = setTimeout(() => {
      timedOut = true;
      abortReason = 'timeout';
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => {
      cancelled = true;
      abortReason = 'cancelled';
      controller.abort();
    };
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let spawnError;
    let handle;
    try {
      handle = subprocess.spawn({
        argv: args,
        cwd: project.rootDir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1_048_576, spill: { maxBytes: 32 * 1_048_576 } },
          stderr: { maxBytes: 524_288, spill: { maxBytes: 8 * 1_048_576 } },
        },
        graceMs: 5_000,
        signal: controller.signal,
        env: buildEnv(this.config, {}, toolchain.binDir),
      });
    } catch (error) {
      spawnError = error;
    }

    let outcome;
    let stdoutText = '';
    let stderrText = '';
    if (handle) {
      try {
        outcome = await handle.done;
      } catch (error) {
        spawnError = error;
      }
      try {
        stdoutText = handle.collected.stdout?.readFrom(0).text ?? '';
        stderrText = handle.collected.stderr?.readFrom(0).text ?? '';
      } catch {
        // Output readers are best-effort after settlement.
      }
    }
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', onExternalAbort);
    const durationMs = Date.now() - startedAt;

    if (spawnError) {
      return {
        status: 'failure',
        exitCode: null,
        durationMs,
        engine,
        args,
        error: `Failed to start latexmk: ${errorMessage(spawnError)}`,
        diagnostics: { errors: [], warnings: [], counts: { errors: 0, warnings: 0 } },
        stdoutTail: tailText(stdoutText, 8000),
        stderrTail: tailText(stderrText, 8000),
        paths,
        startedAt,
        finishedAt: Date.now(),
        logPath: undefined,
      };
    }

    const logText = await this.#readOptional(paths.logPath);
    const parsed = parseLatexLog({
      logText,
      stdout: `${stdoutText}\n${stderrText}`,
      rootDir: project.rootDir,
      mainFile: project.mainFile,
    });
    // BibTeX/Biber diagnostics living beside the .log.
    const bibLogText = await this.#readOptional(
      path.join(paths.buildDirAbs, `${paths.stem}.blg`),
    );
    if (bibLogText) {
      const bib = parseBibLog(bibLogText, project.rootDir);
      for (const entry of bib.errors) {
        parsed.errors.push({ ...entry, file: undefined, line: undefined });
      }
      for (const entry of bib.warnings) parsed.warnings.push({ ...entry, file: undefined });
      parsed.counts.errors = parsed.errors.length;
      parsed.counts.warnings = parsed.warnings.length;
    }

    const pdfFound = await this.#findOutputPdf(paths);
    const pdfStat = pdfFound ? await stat(pdfFound).catch(() => undefined) : undefined;
    const combinedOutput = `${stdoutText}\n${stderrText}`;
    // A project .latexmkrc without `$pdf_mode` makes latexmk fall back to DVI
    // mode: it exits 0 and may leave an UNRELATED older PDF in the build
    // directory. Require evidence that this run produced the PDF (or that
    // latexmk explicitly declared the existing targets up to date).
    const upToDate =
      /all targets .*are up-to-date/i.test(combinedOutput) ||
      /nothing to do/i.test(combinedOutput);
    const pdfFresh = Boolean(pdfStat && pdfStat.mtimeMs >= startedAt - 2_000);
    const pdfOutput = Boolean(parsed.outputFile && /\.pdf"?\s*$/i.test(parsed.outputFile.trim()));
    const freshEvidence = upToDate || pdfFresh || pdfOutput;
    let status;
    let statusError;
    if (cancelled) {
      status = 'cancelled';
    } else if (timedOut) {
      status = 'timeout';
    } else if (outcome?.exitCode === 0 && pdfFound && parsed.counts.errors === 0) {
      if (freshEvidence) {
        status = 'success';
      } else {
        status = 'failure';
        statusError = rcPath
          ? 'latexmk exited 0 but produced no fresh PDF. The project .latexmkrc may not select PDF mode (missing $pdf_mode); pass an engine explicitly or fix the rc file.'
          : 'latexmk exited 0 but the log contains no fresh PDF output; the build produced no usable document.';
      }
    } else {
      status = 'failure';
      if (outcome?.exitCode === 0 && !pdfFound) {
        statusError = rcPath
          ? 'latexmk exited 0 but no PDF was produced. The project .latexmkrc may select DVI mode; pass an engine explicitly or fix the rc file.'
          : 'latexmk exited 0 but no PDF was produced.';
      }
    }

    let version;
    let previewPath;
    if (status === 'success' && this.config.preserveLastGood) {
      await atomicCopy(pdfFound, paths.previewPath);
      version = Date.now();
      previewPath = paths.previewPath;
      await atomicWriteText(
        paths.metaPath,
        JSON.stringify(
          {
            schema: 1,
            version,
            builtAt: new Date().toISOString(),
            mainFile: project.mainFile,
            engine,
            pdfPath: pdfFound,
            pages: parsed.pages,
            durationMs,
          },
          null,
          2,
        ),
      );
    } else if (status === 'success') {
      version = Date.now();
      previewPath = pdfFound;
      await atomicWriteText(
        paths.metaPath,
        JSON.stringify(
          {
            schema: 1,
            version,
            builtAt: new Date().toISOString(),
            mainFile: project.mainFile,
            engine,
            pdfPath: pdfFound,
            pages: parsed.pages,
            durationMs,
          },
          null,
          2,
        ),
      );
    }

    return {
      status,
      error: statusError,
      upToDate,
      freshOutput: freshEvidence,
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      durationMs,
      engine,
      args,
      pdfPath: pdfFound,
      previewPath,
      version,
      pages: parsed.pages,
      diagnostics: {
        errors: parsed.errors,
        warnings: parsed.warnings,
        counts: parsed.counts,
        fatal: parsed.fatal,
        source: parsed.source,
      },
      stdoutTail: tailText(stdoutText, 12_000),
      stderrTail: tailText(stderrText, 12_000),
      logPath: logText === undefined ? undefined : paths.logPath,
      logTail: logText === undefined ? undefined : tailText(logText, 64 * 1024),
      startedAt,
      finishedAt: Date.now(),
      timeoutMs,
      rcFile: rcPath,
      abortReason,
    };
  }

  async #findProjectLatexmkrc(rootDir) {
    for (const name of ['.latexmkrc', 'latexmkrc']) {
      const candidate = path.join(rootDir, name);
      if (await stat(candidate).catch(() => undefined)) return candidate;
    }
    return undefined;
  }

  /**
   * Create the build-tree subdirectories required by `\include{dir/name}`.
   * Only directories are created; no file is touched. The scan is bounded and
   * skips the build directory, hidden directories and node_modules.
   * @param {{ rootDir: string, paths: object }} project
   */
  async #prepareIncludeDirectories(project) {
    const includeDirs = new Set();
    const skip = new Set(['node_modules', '.git', '.hg', '.svn', '.dsh-latex']);
    const queue = [{ dir: project.rootDir, depth: 0 }];
    let scanned = 0;
    while (queue.length > 0 && scanned < 2000 && includeDirs.size < 200) {
      const current = queue.shift();
      let entries;
      try {
        entries = await readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth >= 8) continue;
          const lower = entry.name.toLowerCase();
          if (lower.startsWith('.') || skip.has(lower)) continue;
          if (isInside(project.paths.buildDirAbs, absolute) || absolute === project.paths.buildDirAbs) continue;
          queue.push({ dir: absolute, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tex')) continue;
        scanned += 1;
        let text;
        try {
          const info = await stat(absolute);
          if (info.size > 2 * 1024 * 1024) continue;
          text = await readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        const stripped = text.replace(/(?<!\\)%[^\n]*/g, '');
        for (const match of stripped.matchAll(/\\include\s*\{([^{}]+)\}/g)) {
          const reference = match[1].trim().replace(/\\/g, '/');
          if (reference === '' || reference.startsWith('/') || reference.includes('..')) continue;
          const dirname = path.posix.dirname(reference);
          if (dirname === '.' || dirname === '') continue;
          includeDirs.add(dirname);
        }
      }
    }
    for (const dirname of includeDirs) {
      const target = path.resolve(project.paths.buildDirAbs, dirname);
      if (!isInside(project.paths.buildDirAbs, target)) continue;
      await mkdir(target, { recursive: true }).catch(() => {});
    }
  }

  async #readOptional(file) {
    try {
      const info = await stat(file);
      if (!info.isFile()) return undefined;
      if (info.size > 32 * 1_048_576) return undefined;
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Find the produced PDF, tolerating a project that changes its jobname. */
  async #findOutputPdf(paths) {
    const direct = await stat(paths.pdfPath).catch(() => undefined);
    if (direct?.isFile()) return paths.pdfPath;
    let entries;
    try {
      entries = await readdir(paths.buildDirAbs, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const pdfs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
      const absolute = path.join(paths.buildDirAbs, entry.name);
      const info = await stat(absolute).catch(() => undefined);
      if (info?.isFile()) pdfs.push({ file: absolute, mtime: info.mtimeMs });
    }
    if (pdfs.length === 0) return undefined;
    pdfs.sort((a, b) => b.mtime - a.mtime);
    // A project is expected to produce one document; when several PDFs exist,
    // only a uniquely newest one is trusted.
    if (pdfs.length > 1 && pdfs[0].mtime - pdfs[1].mtime < 50) return undefined;
    return pdfs[0].file;
  }

  /**
   * Remove only recognised auxiliary files from the build directory.
   * Recurses into build subdirectories because `\include{sections/a}` puts its
   * `.aux` there; only files with an allowlisted auxiliary suffix are deleted.
   * @param {{ paths: object }} project
   * @param {{ includePdf?: boolean, includePreview?: boolean }} options
   */
  async clean(project, options = {}) {
    const removed = [];
    const kept = [];
    const queue = [{ dir: project.paths.buildDirAbs, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      let entries = [];
      try {
        entries = await readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absolute = path.join(current.dir, entry.name);
        if (!isInside(project.paths.buildDirAbs, absolute)) continue;
        if (entry.isDirectory()) {
          if (current.depth >= 6) continue;
          if (entry.name === '.dsh-latex') continue;
          queue.push({ dir: absolute, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const suffix = suffixOf(entry.name);
        const known = AUX_EXTENSIONS.has(suffix) || entry.name === '.latexmkrc';
        const isPdf = suffix === '.pdf';
        if (!known && !(isPdf && options.includePdf === true)) {
          kept.push(absolute);
          continue;
        }
        if (isPdf && options.includePdf !== true) {
          kept.push(absolute);
          continue;
        }
        try {
          await unlink(absolute);
          removed.push(absolute);
        } catch {
          kept.push(absolute);
        }
      }
    }
    if (options.includePreview === true) {
      for (const file of [project.paths.previewPath, project.paths.metaPath]) {
        try {
          await unlink(file);
          removed.push(file);
        } catch {
          // Missing preview is fine.
        }
      }
    }
    return { removed, kept, buildDir: project.paths.buildDirAbs };
  }
}
