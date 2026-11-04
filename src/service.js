/**
 * The Host-side LaTeX service: project registry, build queue, source watcher,
 * state snapshots and the event fan-out used by the Web panel.
 *
 * The service is deliberately unaware of HTTP and tools. Those adapters call
 * the same methods, so a button in the panel and a model tool share one
 * implementation (see references/user-actions.md in the plugin skill).
 */
import { watch } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { publicConfig } from './config.js';
import { projectIdOf } from './util.js';
import {
  readSourceFile as readSourceFileIo,
  writeSourceFile as writeSourceFileIo,
} from './file-io.js';
import {
  abortError,
  clockText,
  delay,
  errorMessage,
  formatDuration,
  isAbortError,
  isInside,
  isUncPath,
  tailText,
} from './util.js';

/**
 * Decode synctex.exe output. The Windows binary writes paths in the system ANSI
 * code page (CP936 on this machine); ASCII works either way. Try strict UTF-8
 * first, then GBK, then a lossy UTF-8 decode.
 */
function decodeSyncTeXOutput(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Fall through to the ANSI code page.
  }
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

const WATCH_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.bst',
  '.sty',
  '.cls',
  '.cbx',
  '.bbx',
  '.lbx',
  '.def',
  '.cfg',
  '.clo',
  '.ltx',
  '.tikz',
  '.pgf',
  '.lua',
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.eps',
  '.svg',
  '.gif',
  '.webp',
  '.bmp',
]);

const MAX_PROJECTS = 32;
const MAX_STATE_ERRORS = 80;
const MAX_STATE_WARNINGS = 80;

function emptyDiagnostics() {
  return { errors: [], warnings: [], counts: { errors: 0, warnings: 0 }, fatal: false };
}

function summarizeDiagnostics(diagnostics) {
  const errors = (diagnostics?.errors ?? []).slice(0, MAX_STATE_ERRORS);
  const warnings = (diagnostics?.warnings ?? []).slice(0, MAX_STATE_WARNINGS);
  return {
    errors,
    warnings,
    counts: {
      errors: diagnostics?.counts?.errors ?? errors.length,
      warnings: diagnostics?.counts?.warnings ?? warnings.length,
      overfull: diagnostics?.counts?.overfull ?? 0,
    },
    fatal: diagnostics?.fatal === true,
    source: diagnostics?.source,
    truncated:
      (diagnostics?.counts?.errors ?? 0) > errors.length ||
      (diagnostics?.counts?.warnings ?? 0) > warnings.length,
  };
}

export class LatexService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {ReturnType<typeof import('./config.js').normalizeConfig>} config
   * @param {import('./build.js').LatexBuilder} builder
   * @param {import('./project.js').ProjectResolver} resolver
   * @param {{ info: Function, warn: Function, error: Function }} logger
   */
  constructor(ctx, config, builder, resolver, logger) {
    this.ctx = ctx;
    this.config = config;
    this.builder = builder;
    this.resolver = resolver;
    this.logger = logger;
    this.projects = new Map();
    this.listeners = new Set();
    this.listenersSse = new Set();
    this.previewSeq = 0;
    this.lastPreviewRequest = undefined;
    this.broadcastTimer = undefined;
    this.disposed = false;
    this.startedAt = Date.now();
    this.buildsStarted = 0;
    this.buildsFinished = 0;
    this.semaphore = new (class {
      constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiters = [];
      }
      async acquire(signal) {
        if (signal?.aborted) throw abortError();
        if (this.active < this.limit) {
          this.active += 1;
          return this.#release();
        }
        await new Promise((resolve, reject) => {
          const waiter = {
            grant: () => {
              signal?.removeEventListener?.('abort', onAbort);
              resolve();
            },
            reject,
          };
          const onAbort = () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(abortError());
          };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          this.waiters.push(waiter);
        });
        this.active += 1;
        return this.#release();
      }
      #release() {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          const next = this.waiters.shift();
          if (next) next.grant();
        };
      }
    })(config.maxConcurrentBuilds);
  }

  /** Probe the toolchain lazily; never rejects. */
  async init() {
    try {
      await this.builder.checkToolchain({ refresh: true });
      this.logger.info('LaTeX toolchain: %o', this.builder.toolchain);
    } catch (error) {
      this.logger.warn('LaTeX toolchain probe failed: %s', errorMessage(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Project registry                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve and register a project.
   * @param {{ file?: string, project?: string, mainFile?: string, cwd?: string }} input
   * @param {{ sessionId?: string }} context
   */
  async ensureProject(input, context = {}) {
    const resolution = await this.resolver.resolve({
      file: input.file,
      project: input.project,
      mainFile: input.mainFile,
      cwd: input.cwd,
    });
    const id = projectIdOf(resolution.rootDir, resolution.mainFile);
    const activeEngine =
      (resolution.engineHint && ['xelatex', 'pdflatex', 'lualatex'].includes(resolution.engineHint)
        ? resolution.engineHint
        : undefined) ?? this.config.engine;
    let project = this.projects.get(id);
    if (!project) {
      const paths = this.builder.projectPaths(resolution);
      project = {
        id,
        rootDir: resolution.rootDir,
        mainFile: resolution.mainFile,
        source: resolution.source,
        engine: activeEngine,
        paths,
        sessionIds: new Set(),
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: 'idle',
        building: false,
        queued: 0,
        runs: 0,
        autoBuild: this.config.autoBuild,
        watchHandle: undefined,
        watchActive: false,
        watchError: undefined,
        watchTimer: undefined,
        autoRequested: false,
        suppressAutoUntil: 0,
        queue: [],
        pumping: false,
        abortController: undefined,
        cancelReason: undefined,
        previewVersion: 0,
        previewPages: undefined,
        previewUpdatedAt: undefined,
        lastSuccess: undefined,
        lastBuild: undefined,
        diagnostics: emptyDiagnostics(),
        stale: false,
        lastError: undefined,
      };
      this.projects.set(id, project);
      this.logger.info('LaTeX project registered: %s (main: %s)', project.rootDir, project.mainFile);
      this.#evictProjects();
    } else {
      project.lastUsedAt = Date.now();
      project.mainFile = resolution.mainFile;
      if (resolution.engineHint) project.engine = resolution.engineHint;
      project.paths = this.builder.projectPaths(resolution);
      project.rootDir = resolution.rootDir;
    }
    if (context.sessionId) project.sessionIds.add(String(context.sessionId));
    await this.#restorePublishedState(project);
    if (project.autoBuild) this.startWatch(project);
    this.#broadcast();
    return project;
  }

  /** Recover the preview version written by an earlier Host process. */
  async #restorePublishedState(project) {
    if (project.previewVersion > 0) return;
    try {
      const raw = await readFile(project.paths.metaPath, 'utf8');
      const meta = JSON.parse(raw);
      if (typeof meta?.version === 'number') {
        project.previewVersion = meta.version;
        project.previewPages = meta.pages;
        project.previewUpdatedAt = Date.parse(meta.builtAt) || Date.now();
        project.lastSuccess = {
          version: meta.version,
          pages: meta.pages,
          at: project.previewUpdatedAt,
          durationMs: meta.durationMs,
          engine: meta.engine,
        };
        // A published PDF survives the Host process; report it as the last
        // known build so the panel does not claim the project was never built.
        project.status = 'success';
        project.lastBuild = {
          status: 'success',
          reason: 'restored',
          engine: meta.engine,
          startedAt: project.previewUpdatedAt - (Number(meta.durationMs) || 0),
          finishedAt: project.previewUpdatedAt,
          clock: clockText(new Date(project.previewUpdatedAt)),
          durationMs: Number(meta.durationMs) || 0,
          exitCode: 0,
          errors: 0,
          warnings: 0,
          pages: meta.pages,
          logPath: undefined,
          error: undefined,
        };
      }
    } catch {
      // No earlier successful build.
    }
  }

  #evictProjects() {
    if (this.projects.size <= MAX_PROJECTS) return;
    const candidates = [...this.projects.values()]
      .filter((project) => !project.building && project.queued === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.projects.size > MAX_PROJECTS && candidates.length > 0) {
      const victim = candidates.shift();
      this.disposeProject(victim);
      this.projects.delete(victim.id);
    }
  }

  disposeProject(project) {
    if (!project) return;
    if (project.watchHandle) {
      try {
        project.watchHandle.close();
      } catch {
        // Already closed.
      }
      project.watchHandle = undefined;
    }
    project.watchActive = false;
    if (project.watchTimer) {
      clearTimeout(project.watchTimer);
      project.watchTimer = undefined;
    }
    project.abortController?.abort();
  }

  getProject(id) {
    return typeof id === 'string' ? this.projects.get(id) : undefined;
  }

  findProjectForSession(sessionId) {
    if (!sessionId) return undefined;
    return [...this.projects.values()].find((project) => project.sessionIds.has(String(sessionId)));
  }

  /* ------------------------------------------------------------------ */
  /* Source watcher / automatic builds                                   */
  /* ------------------------------------------------------------------ */

  startWatch(project) {
    if (this.disposed || project.watchHandle) return;
    try {
      const handle = watch(project.rootDir, { recursive: true }, (eventType, filename) => {
        try {
          this.#onFsEvent(project, filename);
        } catch (error) {
          this.logger.warn('LaTeX watcher callback failed: %s', errorMessage(error));
        }
      });
      handle.on('error', (error) => {
        project.watchError = errorMessage(error);
        project.watchActive = false;
        this.logger.warn('LaTeX watcher stopped for %s: %s', project.rootDir, errorMessage(error));
        this.#broadcast();
      });
      project.watchHandle = handle;
      project.watchActive = true;
      project.watchError = undefined;
      this.logger.info('Watching LaTeX project sources: %s', project.rootDir);
    } catch (error) {
      project.watchError = errorMessage(error);
      project.watchActive = false;
      this.logger.warn('Unable to watch LaTeX project %s: %s', project.rootDir, errorMessage(error));
    }
    this.#broadcast();
  }

  stopWatch(project) {
    if (project.watchTimer) {
      clearTimeout(project.watchTimer);
      project.watchTimer = undefined;
    }
    if (project.watchHandle) {
      try {
        project.watchHandle.close();
      } catch {
        // Already closed.
      }
      project.watchHandle = undefined;
    }
    project.watchActive = false;
    project.autoRequested = false;
    this.#broadcast();
  }

  setAutoBuild(project, enabled) {
    project.autoBuild = Boolean(enabled);
    if (project.autoBuild) this.startWatch(project);
    else this.stopWatch(project);
    this.#broadcast();
    return project.autoBuild;
  }

  #onFsEvent(project, filename) {
    if (!filename) return;
    const relative = String(filename).replace(/\\/g, '/');
    // Ignore the build directory and our own state: latexmk rewrites those on
    // every run and a rebuild loop must be impossible.
    const absolute = path.resolve(project.rootDir, relative);
    if (isInside(project.paths.buildDirAbs, absolute)) return;
    const lower = relative.toLowerCase();
    if (/(^|\/)(node_modules|\.git|\.hg|\.svn|\.dsh-latex)(\/|$)/.test(lower)) return;
    const suffix = path.extname(lower);
    if (!WATCH_EXTENSIONS.has(suffix) && !this.config.watchExtraExtensions.includes(suffix)) return;
    if (suffix === '.tex') this.resolver.invalidate(absolute);
    if (!project.autoBuild) return;
    // An editor save runs its own build immediately; ignore the watcher echo
    // for that write so one Ctrl+S never queues two compiles.
    if (Date.now() < (project.suppressAutoUntil ?? 0)) return;
    project.autoRequested = true;
    if (project.watchTimer) clearTimeout(project.watchTimer);
    project.watchTimer = setTimeout(() => {
      project.watchTimer = undefined;
      this.#scheduleAutoBuild(project);
    }, this.config.debounceMs);
    project.watchTimer.unref?.();
  }

  #scheduleAutoBuild(project) {
    if (this.disposed || !project.autoBuild || !project.autoRequested) return;
    if (project.building || project.queued > 0 || project.pumping) {
      // A build is already running; its completion re-checks the flag, so a
      // burst of saves coalesces into exactly one follow-up build.
      return;
    }
    project.autoRequested = false;
    this.enqueueBuild(project, {
      reason: 'auto',
      signal: undefined,
      timeoutMs: this.config.timeoutMs,
      silent: true,
    }).catch((error) => {
      if (!isAbortError(error)) {
        this.logger.warn('Automatic LaTeX build failed: %s', errorMessage(error));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Build queue                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Queue one build for the project and resolve with its result.
   * @param {object} project
   * @param {{ reason?: string, force?: boolean, engine?: string, engineExplicit?: boolean, timeoutMs?: number, signal?: AbortSignal, open?: boolean, sessionId?: string }} options
   * @returns {Promise<object>}
   */
  enqueueBuild(project, options = {}) {
    if (this.disposed) return Promise.reject(new Error('The LaTeX plugin is unloading.'));
    if (options.engine && ['xelatex', 'pdflatex', 'lualatex'].includes(options.engine)) {
      project.engine = options.engine;
      project.engineExplicit = true;
    }
    return new Promise((resolve, reject) => {
      project.queue.push({ options, resolve, reject });
      project.queued = project.queue.length;
      this.#broadcast();
      this.#pump(project);
    });
  }

  async #pump(project) {
    if (project.pumping) return;
    project.pumping = true;
    try {
      while (project.queue.length > 0) {
        // Automatic rebuilds are idempotent: keep only the newest one that
        // accumulated while the previous build ran. Manual/UI/preview jobs are
        // never dropped — every enqueued promise must settle.
        if (project.queue.length > 1) {
          const lastAutoIndex = project.queue.map((job) => job.options.reason).lastIndexOf('auto');
          if (lastAutoIndex > 0) {
            const kept = [];
            for (let index = 0; index < project.queue.length; index += 1) {
              const job = project.queue[index];
              if (job.options.reason === 'auto' && index !== lastAutoIndex) {
                job.resolve({ status: 'coalesced', reason: 'auto' });
                continue;
              }
              kept.push(job);
            }
            project.queue = kept;
          }
        }
        const job = project.queue.shift();
        project.queued = project.queue.length;
        const result = await this.#runOne(project, job.options);
        job.resolve(result);
        if (project.autoRequested && project.autoBuild) {
          project.autoRequested = false;
          // The file changed while we were building: one more run, debounced.
          await delay(Math.min(this.config.debounceMs, 1500));
          if (project.autoBuild) {
            project.queue.push({
              options: { reason: 'auto', timeoutMs: this.config.timeoutMs, silent: true },
              resolve: () => {},
              reject: () => {},
            });
            project.queued = project.queue.length;
          }
        }
        this.#broadcast();
      }
    } finally {
      project.pumping = false;
      this.#broadcast();
    }
  }

  async #runOne(project, options) {
    const reason = options.reason ?? 'manual';
    const startedAt = Date.now();
    this.buildsStarted += 1;
    project.building = true;
    project.status = 'queued';
    project.lastError = undefined;
    this.#broadcast();
    const controller = new AbortController();
    project.abortController = controller;
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    let release = () => {};
    let result;
    try {
      release = await this.semaphore.acquire(controller.signal);
      if (controller.signal.aborted) throw abortError();
      project.status = 'running';
      project.statusChangedAt = Date.now();
      this.#broadcast();
      const buildResult = await this.builder.build(
        {
          rootDir: project.rootDir,
          mainFile: project.mainFile,
          engine: project.engine,
          paths: project.paths,
        },
        {
          reason,
          force: options.force === true,
          engineExplicit: Boolean(options.engine),
          signal: controller.signal,
          timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        },
      );
      const status = buildResult.status;
      project.status = status;
      project.runs += 1;
      project.diagnostics = buildResult.diagnostics ?? emptyDiagnostics();
      if (status === 'success') {
        project.previewVersion = buildResult.version ?? Date.now();
        project.previewPages = buildResult.pages;
        project.previewUpdatedAt = Date.now();
        project.stale = false;
        project.lastSuccess = {
          version: project.previewVersion,
          pages: buildResult.pages,
          at: Date.now(),
          durationMs: buildResult.durationMs,
          engine: buildResult.engine,
        };
      } else if (project.previewVersion > 0) {
        project.stale = true;
      }
      const summary = {
        status,
        reason,
        engine: buildResult.engine,
        startedAt,
        finishedAt: Date.now(),
        clock: clockText(new Date()),
        durationMs: buildResult.durationMs,
        exitCode: buildResult.exitCode,
        errors: buildResult.diagnostics?.counts?.errors ?? 0,
        warnings: buildResult.diagnostics?.counts?.warnings ?? 0,
        pages: buildResult.pages,
        logPath: buildResult.logPath,
        timeoutMs: buildResult.timeoutMs,
        rcFile: buildResult.rcFile,
      };
      project.lastBuild = { ...summary, summary };
      project.lastBuildResult = {
        ...buildResult,
        diagnostics: summarizeDiagnostics(buildResult.diagnostics),
      };
      if (status !== 'success') {
        project.lastError =
          buildResult.error ??
          (buildResult.diagnostics?.errors?.[0]?.message
            ? `${buildResult.diagnostics.errors[0].message}${
                buildResult.diagnostics.errors[0].line
                  ? ` (line ${buildResult.diagnostics.errors[0].line})`
                  : ''
              }`
            : `latexmk exited with ${buildResult.exitCode}`);
      }
      result = {
        status,
        projectId: project.id,
        mainFile: project.mainFile,
        rootDir: project.rootDir,
        engine: buildResult.engine,
        durationMs: buildResult.durationMs,
        durationText: formatDuration(buildResult.durationMs),
        exitCode: buildResult.exitCode,
        pdfPath: buildResult.pdfPath,
        previewPath: buildResult.previewPath,
        previewVersion: project.previewVersion,
        pages: buildResult.pages,
        diagnostics: buildResult.diagnostics,
        logPath: buildResult.logPath,
        logTail: buildResult.logTail,
        stdoutTail: buildResult.stdoutTail,
        stderrTail: buildResult.stderrTail,
        error: buildResult.error,
        reason,
        startedAt,
        finishedAt: Date.now(),
        timeoutMs: buildResult.timeoutMs,
        rcFile: buildResult.rcFile,
      };
    } catch (error) {
      const aborted = controller.signal.aborted || isAbortError(error);
      const status = aborted ? 'cancelled' : 'failure';
      project.status = status;
      project.runs += 1;
      project.lastError = aborted ? 'build cancelled' : errorMessage(error);
      if (project.previewVersion > 0) project.stale = true;
      const summary = {
        status,
        reason,
        engine: project.engine,
        startedAt,
        finishedAt: Date.now(),
        clock: clockText(new Date()),
        durationMs: Date.now() - startedAt,
        exitCode: null,
        errors: aborted ? 0 : 1,
        warnings: 0,
        pages: undefined,
        logPath: undefined,
        error: project.lastError,
      };
      project.lastBuild = { ...summary, summary };
      result = {
        status,
        projectId: project.id,
        mainFile: project.mainFile,
        rootDir: project.rootDir,
        engine: project.engine,
        durationMs: summary.durationMs,
        durationText: formatDuration(summary.durationMs),
        exitCode: null,
        diagnostics: { errors: [], warnings: [], counts: { errors: 0, warnings: 0 } },
        previewVersion: project.previewVersion,
        error: project.lastError,
        reason,
      };
      if (aborted && options.reason === 'manual') {
        // Manual callers see cancellation as a status, not a thrown error.
      }
    } finally {
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
      project.abortController = undefined;
      project.building = false;
      release();
      this.buildsFinished += 1;
      project.lastUsedAt = Date.now();
      this.#broadcast();
    }
    if (options.open === true && result.status === 'success') {
      this.requestPreview(project, {
        page: project.previewPage,
        sessionId: options.sessionId,
        reason: 'build',
      });
    }
    return result;
  }

  /** Cancel queued and running work for one project. */
  cancel(project) {
    const cancelledQueued = project.queue.length;
    for (const job of project.queue) {
      job.resolve({
        status: 'cancelled',
        projectId: project.id,
        mainFile: project.mainFile,
        rootDir: project.rootDir,
        engine: project.engine,
        durationMs: 0,
        diagnostics: { errors: [], warnings: [], counts: { errors: 0, warnings: 0 } },
        previewVersion: project.previewVersion,
        error: 'cancelled before the build started',
      });
    }
    project.queue = [];
    project.queued = 0;
    project.autoRequested = false;
    const running = project.building;
    project.abortController?.abort();
    if (running || cancelledQueued > 0) project.status = running ? 'cancelling' : 'cancelled';
    this.#broadcast();
    return { cancelled: running || cancelledQueued > 0, running, queued: cancelledQueued };
  }

  /* ------------------------------------------------------------------ */
  /* Preview and clean                                                   */
  /* ------------------------------------------------------------------ */

  /** Ask every connected panel to open/focus the preview tab. */
  requestPreview(project, { page, sessionId, reason, surface } = {}) {
    this.previewSeq += 1;
    project.previewPage = page;
    this.lastPreviewRequest = {
      seq: this.previewSeq,
      projectId: project.id,
      sessionId: sessionId ? String(sessionId) : undefined,
      page,
      at: Date.now(),
      reason: reason ?? 'manual',
      surface: surface === 'document' ? 'document' : 'native',
    };
    this.#broadcast(true);
    return this.lastPreviewRequest;
  }

  async clean(project, options = {}) {
    if (project.building || project.queued > 0 || project.pumping) {
      throw new Error(
        'A LaTeX build is running or queued for this project; cancel it or wait before cleaning.',
      );
    }
    const result = await this.builder.clean(project, {
      includePdf: options.includePdf === true,
      includePreview: options.includePreview === true,
    });
    if (options.includePreview === true) {
      project.previewVersion = 0;
      project.previewPages = undefined;
      project.lastSuccess = undefined;
      project.stale = false;
      await unlink(project.paths.metaPath).catch(() => {});
    }
    this.#broadcast();
    return result;
  }

  /**
   * Read one existing `.tex` source file for the in-app editor. Path safety,
   * the size cap and the UTF-8 check live in file-io.js.
   * @param {string} target absolute path
   */
  async readSourceFile(target) {
    return readSourceFileIo(target, { resolver: this.resolver });
  }

  /**
   * Atomically save one `.tex` source file. The revision is a compare-and-swap
   * guard against external edits; the resolver is invalidated so the next
   * compile re-detects a possibly changed root document.
   * @param {string} target absolute path
   * @param {string} content
   * @param {string} [expectedRevision]
   */
  async writeSourceFile(target, content, expectedRevision) {
    const result = await writeSourceFileIo(target, content, {
      resolver: this.resolver,
      expectedRevision,
    });
    this.resolver.invalidate(result.path);
    return result;
  }

  /**
   * Suppress the source watcher's automatic build for a moment, so an explicit
   * editor build is not immediately followed by a redundant one. The watcher
   * still invalidates the resolver and keeps watching afterwards.
   */
  suppressAutoBuild(project, ms = 2500) {
    project.suppressAutoUntil = Date.now() + Math.max(0, ms);
    project.autoRequested = false;
    if (project.watchTimer) {
      clearTimeout(project.watchTimer);
      project.watchTimer = undefined;
    }
  }

  /**
   * Resolve a `.tex` path to its real project and build it. Used by the editor
   * Save button and the `compile-file` HTTP action.
   * @param {{ path: string, cwd?: string, sessionId?: string, force?: boolean }} input
   */
  async compilePath(input) {
    const project = await this.ensureProject(
      { file: input.path, cwd: input.cwd },
      { sessionId: input.sessionId },
    );
    this.suppressAutoBuild(project, 3000);
    const result = await this.enqueueBuild(project, {
      reason: 'editor',
      force: input.force === true,
      timeoutMs: this.config.timeoutMs,
      silent: true,
    });
    return { project, result };
  }

  async readLog(project, maxBytes = 512 * 1024) {
    const candidates = [project.paths.logPath, project.lastBuildResult?.logPath];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const info = await stat(candidate).catch(() => undefined);
      if (!info?.isFile()) continue;
      const raw = await readFile(candidate, 'utf8').catch(() => undefined);
      if (raw !== undefined) {
        return { path: candidate, text: tailText(raw, maxBytes), size: info.size };
      }
    }
    const fallback = project.lastBuildResult?.logTail;
    if (fallback) return { path: project.paths.logPath, text: fallback, size: fallback.length };
    return undefined;
  }

  /* ------------------------------------------------------------------ */
  /* State snapshots                                                     */
  /* ------------------------------------------------------------------ */

  snapshot() {
    const toolchain = this.builder.toolchain;
    return {
      schema: 1,
      now: Date.now(),
      startedAt: this.startedAt,
      config: publicConfig(this.config),
      toolchain: toolchain
        ? {
            ok: toolchain.ok,
            binDir: toolchain.binDir,
            latexmk: toolchain.latexmk,
            missing: toolchain.missing,
            checkedAt: toolchain.checkedAt,
          }
        : undefined,
      previewRequest: this.lastPreviewRequest,
      builds: { started: this.buildsStarted, finished: this.buildsFinished },
      projects: [...this.projects.values()].map((project) => this.#projectSummary(project)),
    };
  }

  #projectSummary(project) {
    return {
      id: project.id,
      rootDir: project.rootDir,
      mainFile: project.mainFile,
      mainRelative: path.relative(project.rootDir, project.mainFile).replace(/\\/g, '/'),
      engine: project.engine,
      status: project.status,
      building: project.building,
      queued: project.queued,
      autoBuild: project.autoBuild,
      watchActive: project.watchActive,
      watchError: project.watchError,
      buildDir: project.paths.buildDirAbs,
      pdfPath: project.paths.pdfPath,
      previewPath: project.paths.previewPath,
      previewVersion: project.previewVersion,
      previewPages: project.previewPages,
      previewUpdatedAt: project.previewUpdatedAt,
      stale: project.stale,
      lastError: project.lastError,
      lastSuccess: project.lastSuccess,
      lastBuild: project.lastBuild
        ? {
            status: project.lastBuild.status,
            reason: project.lastBuild.reason,
            startedAt: project.lastBuild.startedAt,
            finishedAt: project.lastBuild.finishedAt,
            durationMs: project.lastBuild.durationMs,
            exitCode: project.lastBuild.exitCode,
            errors: project.lastBuild.errors,
            warnings: project.lastBuild.warnings,
            pages: project.lastBuild.pages,
            logPath: project.lastBuild.logPath,
            error: project.lastBuild.error,
            rcFile: project.lastBuild.rcFile,
            clock: clockText(new Date(project.lastBuild.finishedAt || Date.now())),
          }
        : undefined,
      diagnostics: summarizeDiagnostics(project.diagnostics),
      sessionIds: [...project.sessionIds],
      lastUsedAt: project.lastUsedAt,
      runs: project.runs,
    };
  }

  /** Subscribe to snapshots (HTTP/SSE or in-process consumers). */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #broadcast(immediate = false) {
    if (this.disposed) return;
    if (immediate) {
      if (this.broadcastTimer) {
        clearTimeout(this.broadcastTimer);
        this.broadcastTimer = undefined;
      }
      this.#emit();
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.#emit();
    }, 60);
    this.broadcastTimer.unref?.();
  }

  #emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn('LaTeX state listener failed: %s', errorMessage(error));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* SyncTeX                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Structured Forward (source -> PDF) or inverse (PDF -> source) lookup.
   * Returning fields instead of a human-readable sentence keeps the browser
   * free of fragile regex parsing (paths with spaces and CJK included).
   *
   * @returns {Promise<{ ok: boolean, direction: string, message?: string, file?: string, relativeFile?: string, line?: number, column?: number, page?: number, x?: number, y?: number, raw?: string, stale?: boolean }>}
   */
  async syncTeXResult(project, args = {}, signal) {
    const direction = args.direction === 'inverse' ? 'inverse' : 'forward';
    const toolchain = await this.builder.checkToolchain();
    const synctex = toolchain.tools?.synctex?.path;
    if (!synctex || toolchain.tools.synctex.exists !== true) {
      return { ok: false, direction, message: `SyncTeX is unavailable: synctex.exe was not found in ${this.config.texBinDir}.` };
    }
    const pdf = project.paths.pdfPath;
    const info = await stat(pdf).catch(() => undefined);
    if (!info?.isFile()) {
      return { ok: false, direction, message: `SyncTeX needs a built PDF first: ${pdf} does not exist. Run latex_compile.` };
    }
    let argv;
    let expected = {};
    if (direction === 'inverse') {
      const page = Math.max(1, Math.round(Number(args.page) || 1));
      const x = Number.isFinite(Number(args.x)) ? Number(args.x) : 0;
      const y = Number.isFinite(Number(args.y)) ? Number(args.y) : 0;
      argv = [synctex, 'edit', '-o', `${page}:${x}:${y}:${pdf}`];
      expected = { page, x, y };
    } else {
      if (args.file !== undefined) {
        const candidate = path.resolve(project.rootDir, String(args.file));
        if (isUncPath(String(args.file)) || !isInside(project.rootDir, candidate)) {
          return {
            ok: false,
            direction,
            message: 'SyncTeX forward lookup only accepts source files inside the project root.',
          };
        }
      }
      const file = args.file
        ? path.resolve(project.rootDir, String(args.file))
        : project.mainFile;
      const line = Math.max(1, Math.round(Number(args.line) || 1));
      const column = Math.max(1, Math.round(Number(args.column) || 1));
      argv = [synctex, 'view', '-i', `${line}:${column}:${file}`, '-o', pdf];
    }
    const subprocess = await this.builder.subprocessService();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    let rawBuffer = Buffer.alloc(0);
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: project.rootDir,
        stdio: {
          stdin: 'ignore',
          // Keep the raw bytes: synctex.exe writes its paths in the Windows
          // ANSI code page (CP936 here), not UTF-8.
          stdout: 'pipe',
          stderr: 'pipe',
        },
        graceMs: 2_000,
        signal: controller.signal,
        env: { PATH: [this.config.texBinDir, process.env.PATH ?? ''].filter(Boolean).join(';') },
      });
      const readBounded = async (stream) => {
        if (!stream) return Buffer.alloc(0);
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (size >= 512 * 1024) continue;
          chunks.push(buffer.subarray(0, 512 * 1024 - size));
          size += buffer.byteLength;
        }
        return Buffer.concat(chunks);
      };
      const [stdout, stderr] = await Promise.all([
        readBounded(handle.stdout),
        readBounded(handle.stderr),
        handle.done.catch(() => undefined),
      ]);
      rawBuffer = Buffer.concat([stdout, Buffer.from('\n'), stderr]);
    } catch (error) {
      return { ok: false, direction, message: `SyncTeX failed to run: ${errorMessage(error)}` };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    const text = decodeSyncTeXOutput(rawBuffer);
    const raw = tailText(text, 12_000);
    if (!/SyncTeX result begin/i.test(raw)) {
      return {
        ok: false,
        direction,
        message:
          'SyncTeX produced no result. The .synctex.gz may be missing, the page may be out of range, or the PDF was built without -synctex=1.',
        raw,
        ...expected,
      };
    }
    if (direction === 'inverse') {
      const input = /Input:([^\r\n]+)/.exec(raw)?.[1]?.trim();
      const lineText = /Line:(\d+)/.exec(raw)?.[1];
      const columnText = /Column:(-?\d+)/.exec(raw)?.[1];
      const column = columnText !== undefined && Number(columnText) >= 0 ? Number(columnText) : undefined;
      if (!input) {
        return { ok: false, direction, message: 'SyncTeX inverse lookup found no source location.', raw, ...expected };
      }
      const absolute = path.resolve(project.rootDir, input);
      const inside = isInside(project.rootDir, absolute);
      const relative = path.relative(project.rootDir, absolute).replace(/\\/g, '/');
      return {
        ok: true,
        direction,
        file: absolute,
        relativeFile: inside ? relative : undefined,
        line: lineText !== undefined ? Number(lineText) : undefined,
        column,
        stale: !inside,
        message: inside
          ? undefined
          : `SyncTeX data points outside this project (${absolute}); the project may have been moved or renamed. Rebuild to refresh the synctex file.`,
        raw,
        ...expected,
      };
    }
    const pageText = /Page:(\d+)/.exec(raw)?.[1];
    const xText = /x:([-\d.]+)/.exec(raw)?.[1];
    const yText = /y:([-\d.]+)/.exec(raw)?.[1];
    if (!pageText) {
      return { ok: false, direction, message: 'SyncTeX forward lookup found no PDF location.', raw };
    }
    return {
      ok: true,
      direction,
      page: Number(pageText),
      x: xText !== undefined ? Number(xText) : undefined,
      y: yText !== undefined ? Number(yText) : undefined,
      raw,
    };
  }

  /** Human-readable form used by the model tool. */
  async syncTeX(project, args, signal) {
    const result = await this.syncTeXResult(project, args, signal);
    if (!result.ok) {
      return result.message ? `${result.message}${result.raw ? `\n${result.raw}` : ''}` : 'SyncTeX failed.';
    }
    if (result.direction === 'inverse') {
      const target = result.relativeFile ?? result.file;
      return `SyncTeX inverse: ${target}${result.line ? `:${result.line}` : ''}${
        result.column !== undefined ? ` (column ${result.column})` : ''
      }${result.stale ? ' [STALE synctex: rebuild the project]' : ''}`;
    }
    return `SyncTeX forward: page ${result.page}${
      result.x !== undefined && result.y !== undefined ? ` at (${result.x}, ${result.y})` : ''
    }`;
  }

  async health() {
    const toolchain = await this.builder.checkToolchain().catch((error) => ({
      ok: false,
      error: errorMessage(error),
    }));
    return {
      ok: true,
      name: 'dsh-latex',
      version: '0.2.0',
      pid: process.pid,
      startedAt: this.startedAt,
      projects: this.projects.size,
      toolchain,
    };
  }

  dispose() {
    this.disposed = true;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    for (const project of this.projects.values()) this.disposeProject(project);
    this.projects.clear();
    this.listeners.clear();
  }
}
