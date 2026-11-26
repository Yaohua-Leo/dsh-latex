/**
 * The Host-side LaTeX service: project registry, build queue, source watcher,
 * state snapshots and the event fan-out used by the Web panel.
 *
 * The service is deliberately unaware of HTTP and tools. Those adapters call
 * the same methods, so a button in the panel and a model tool share one
 * implementation (see references/user-actions.md in the plugin skill).
 */
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publicConfig } from './config.js';
import { projectIdOf } from './util.js';
import { AnnotationStore, annotationImageDir, annotationImagePath } from './annotations.js';
import { composeSideBySide, decodePng, diffPngs, encodePng } from './png.js';
import { bibLint, citeAudit, layoutAudit, parseBibTeX } from './paper-checks.js';
import { ocrImage, probeOcr, withTemporaryImage } from './ocr.js';
import { createToolchainInstaller } from './toolchain-install.js';
import {
  clearRapidOcrProbe,
  defaultOcrInstallDir,
  installRapidOcr,
  ocrWithRapidOcr,
  probeRapidOcr,
} from './rapidocr.js';
import {
  clampDpi,
  clampPage,
  locateQuote,
  listLookCaches,
  lookCacheDir,
  lookPagePath,
  parsePdfInfo,
  pdfPageCount,
  previousLookPage,
  probeRenderTools,
  pruneLookCaches,
  renderCapability,
  renderPageRange,
  renderPageToPng,
  runTool,
  sha256File,
  validPoint,
} from './render.js';
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

/** An error whose HTTP status the route layer can use verbatim. */
function serviceError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Normalize a browser image payload (`data:image/png;base64,...` or bare
 * base64) into canonical bytes. Returns undefined instead of throwing so the
 * caller can report a precise validation error.
 */
function decodeImagePayload(value, maxBytes) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let mediaType = 'image/png';
  let data = value.trim();
  if (data.startsWith('data:')) {
    const comma = data.indexOf('base64,');
    if (comma < 0) return undefined;
    const header = data.slice(5, comma);
    const declared = header.split(';')[0].trim().toLowerCase();
    if (IMAGE_MEDIA_TYPES.has(declared)) mediaType = declared;
    data = data.slice(comma + 7);
  }
  data = data.replace(/\s+/g, '');
  if (data === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return undefined;
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) return undefined;
  const isPng = buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isWebp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) return undefined;
  if (mediaType === 'image/png' && !isPng) mediaType = isJpeg ? 'image/jpeg' : 'image/webp';
  return { buffer, mediaType, base64: data };
}

/** Official TinyTeX asset for the current platform. */
function defaultTinyTexUrl() {
  const base = 'https://github.com/rstudio/tinytex-releases/releases/download/daily';
  if (process.platform === 'win32') return `${base}/TinyTeX-1-windows.exe`;
  if (process.platform === 'darwin') return `${base}/TinyTeX-1-darwin.tar.xz`;
  return `${base}/TinyTeX-1-linux-x86_64.tar.xz`;
}

/** A point near the first line of a quote box, for SyncTeX inverse. */
function firstLinePoint(box) {
  if (!box) return undefined;
  const width = Math.max(1, Math.min(Number(box.w) || 0, 120));
  const height = Math.max(1, Math.min(Number(box.h) || 0, 16));
  return { x: Number(box.x) + width / 2, y: Number(box.y) + height / 2 };
}

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
    this.annotations = new AnnotationStore(config);
    this.toolchainInstaller = createToolchainInstaller({ config, logger });
    this.ocrState = {
      checkedAt: 0,
      available: false,
      engine: 'unknown',
      installable: true,
      installDir: defaultOcrInstallDir(config),
    };
    this.ocrInstall = { state: 'idle', phase: undefined, percent: 0, error: undefined };
    this.ocrAbort = undefined;
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
    await this.refreshOcr().catch((error) => {
      this.logger.warn('LaTeX OCR probe failed: %s', errorMessage(error));
    });
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
      // Annotations are anchored to the preview they were drawn on; removing
      // the preview without removing them would leave permanently stale items.
      await this.annotations.clear(project, { all: true }).catch(() => {});
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
      ocr: this.ocrSnapshot(),
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
      auditProgress: project.auditProgress,
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
  /* Page rendering (latex_look) and annotations                        */
  /* ------------------------------------------------------------------ */

  /** Probe the PDF renderer, reusing the TeX toolchain's bin directory. */
  async #renderTools() {
    const toolchain = await this.builder.checkToolchain().catch(() => undefined);
    const extraDirs = [];
    if (toolchain?.binDir) extraDirs.push(toolchain.binDir);
    if (toolchain?.latexmk && path.isAbsolute(toolchain.latexmk)) {
      extraDirs.push(path.dirname(toolchain.latexmk));
    }
    return probeRenderTools(this.config, { extraDirs });
  }

  /** Honour a forced `renderEngine`; `auto` keeps every available backend. */
  #renderToolsForEngine(tools) {
    const engine = this.config.renderEngine;
    if (!tools || engine === 'auto') return tools;
    const key = engine === 'ghostscript' ? 'gs' : engine;
    if (!tools[key]) return { checkedAt: tools.checkedAt };
    return { [key]: tools[key], checkedAt: tools.checkedAt };
  }

  /** The PDF the agent should look at: the published preview, then the build PDF. */
  async #lookPdf(project) {
    const preview = await stat(project.paths.previewPath).catch(() => undefined);
    if (preview?.isFile() && preview.size > 0) return project.paths.previewPath;
    const built = await stat(project.paths.pdfPath).catch(() => undefined);
    if (built?.isFile() && built.size > 0) return project.paths.pdfPath;
    return undefined;
  }

  async #pdfPageSize(tools, pdfPath) {
    if (!tools?.pdfinfo) return undefined;
    const result = await runTool([tools.pdfinfo, pdfPath], { timeoutMs: 15_000 });
    if (result.code !== 0) return undefined;
    const info = parsePdfInfo(result.stdout);
    return info.width && info.height ? { width: info.width, height: info.height } : undefined;
  }

  /**
   * Re-anchor provider for annotations whose build version is old.
   * Returns undefined when text extraction is unavailable, which the store
   * reports honestly as stale instead of silently keeping a wrong position.
   */
  async #reanchorProvider(project) {
    const pdfPath = await this.#lookPdf(project);
    if (!pdfPath) return undefined;
    const tools = await this.#renderTools().catch(() => undefined);
    if (!tools?.pdftotext) return undefined;
    const pageSize = await this.#pdfPageSize(tools, pdfPath);
    return async ({ quote, page }) => {
      const located = await locateQuote(tools, pdfPath, quote, {
        pageHint: page,
        maxPages: 300,
      });
      if (!located.ok) return undefined;
      const result = { page: located.page };
      if (located.box && pageSize) {
        const x = Math.min(1, Math.max(0, located.box.x / pageSize.width));
        const y = Math.min(1, Math.max(0, located.box.y / pageSize.height));
        const w = Math.min(1 - x, Math.max(0, located.box.w / pageSize.width));
        const h = Math.min(1 - y, Math.max(0, located.box.h / pageSize.height));
        if (w > 0 && h > 0) result.rects = [{ x, y, w, h }];
      }
      return result;
    };
  }

  /**
   * Render one page for the model, optionally anchoring a quote and diffing
   * against the previous build. Returns data only; the tool attaches the image.
   *
   * @param {object} project
   * @param {{ page?: number, text?: string, point?: { x: number, y: number }, dpi?: number, crop?: object, compare?: boolean }} args
   * @param {AbortSignal} [signal]
   */
  async look(project, args = {}, signal) {
    const pdfPath = await this.#lookPdf(project);
    if (!pdfPath) {
      return {
        ok: false,
        code: 'NO_PDF',
        message: 'No successfully built PDF exists yet. Run latex_compile first, then call latex_look.',
      };
    }
    const tools = await this.#renderTools();
    const capability = renderCapability(tools);
    const renderTools = this.#renderToolsForEngine(tools);
    if (!renderCapability(renderTools).canRender) {
      return {
        ok: false,
        code: 'NO_RENDERER',
        message:
          'No PDF renderer is available. TeX Live ships pdftoppm; alternatively install Ghostscript or muPDF, then retry.',
        capability,
      };
    }

    let page = Number.isFinite(Number(args.page)) ? clampPage(args.page) : undefined;
    const quote = typeof args.text === 'string' ? args.text.trim() : '';
    let textInfo;
    if (quote !== '') {
      const located = await locateQuote(tools, pdfPath, quote, { pageHint: page, signal });
      if (located.ok) {
        page = located.page;
        textInfo = { found: true, page: located.page, box: located.box, checked: located.checked };
      } else if (page === undefined) {
        return {
          ok: false,
          code: 'TEXT_NOT_FOUND',
          message: located.message ?? `Text was not found in this PDF: ${quote.slice(0, 80)}`,
          capability,
        };
      } else {
        textInfo = { found: false, message: located.message };
      }
    }
    const pages = await pdfPageCount(tools, pdfPath);
    if (page === undefined) page = 1;
    if (pages && page > pages) {
      return {
        ok: false,
        code: 'PAGE_OUT_OF_RANGE',
        message: `Page ${page} is outside this ${pages}-page PDF.`,
        pages,
      };
    }

    const dpi = clampDpi(args.dpi, this.config.renderDpi);
    const pageSize = await this.#pdfPageSize(tools, pdfPath);
    let crop;
    let cropDropped = false;
    if (args.crop && typeof args.crop === 'object') {
      const nx = Number(args.crop.x);
      const ny = Number(args.crop.y);
      const nw = Number(args.crop.w);
      const nh = Number(args.crop.h);
      if ([nx, ny, nw, nh].every(Number.isFinite) && nw > 0 && nh > 0) {
        if (pageSize) {
          const scale = dpi / 72;
          crop = {
            x: Math.round(Math.min(1, Math.max(0, nx)) * pageSize.width * scale),
            y: Math.round(Math.min(1, Math.max(0, ny)) * pageSize.height * scale),
            w: Math.round(Math.min(1, nw) * pageSize.width * scale),
            h: Math.round(Math.min(1, nh) * pageSize.height * scale),
          };
          if (crop.w <= 0 || crop.h <= 0) crop = undefined;
        } else {
          cropDropped = true;
        }
      }
    }

    const hash = await sha256File(pdfPath);
    if (!hash) {
      return { ok: false, code: 'HASH_FAILED', message: `Could not read the built PDF: ${pdfPath}` };
    }
    const cacheDir = lookCacheDir(project.paths.stateDir, hash);
    const renderPath = lookPagePath(cacheDir, page, dpi, crop);
    const existing = await stat(renderPath).catch(() => undefined);
    let cached = Boolean(existing?.isFile() && existing.size > 0);
    let engine = 'cache';
    let bytes = existing?.size;
    if (!cached) {
      await mkdir(cacheDir, { recursive: true });
      const rendered = await renderPageToPng(renderTools, {
        pdfPath,
        outPath: renderPath,
        page,
        dpi,
        crop,
        signal,
        timeoutMs: this.config.renderTimeoutMs,
      });
      if (!rendered.ok) {
        return {
          ok: false,
          code: rendered.code,
          message: rendered.message,
          engine: rendered.engine,
          capability,
        };
      }
      engine = rendered.engine;
      bytes = rendered.bytes;
      cached = false;
    }

    let diff;
    if (args.compare !== false) {
      const previous = await previousLookPage(project.paths.stateDir, cacheDir, page, dpi, crop);
      if (previous) {
        const [before, after] = await Promise.all([
          readFile(previous).catch(() => undefined),
          readFile(renderPath).catch(() => undefined),
        ]);
        if (before && after) {
          diff = diffPngs(before, after, { maxPixels: this.config.lookMaxPixels });
        }
      }
    }
    await pruneLookCaches(project.paths.stateDir, this.config.lookCacheKeep);

    let point = args.point ? validPoint(args.point) : undefined;
    let approximate = false;
    if (!point && textInfo?.box) {
      point = firstLinePoint(textInfo.box);
    }
    if (!point && pageSize) {
      point = { x: pageSize.width / 2, y: pageSize.height / 2 };
      approximate = true;
    }
    let source;
    if (point) {
      source = await this.syncTeXResult(
        project,
        { direction: 'inverse', page, x: point.x, y: point.y },
        signal,
      ).catch((error) => ({ ok: false, direction: 'inverse', message: errorMessage(error) }));
      if (source && source.ok) source.approximate = approximate;
    }

    return {
      ok: true,
      projectId: project.id,
      mainFile: project.mainFile,
      rootDir: project.rootDir,
      page,
      pages,
      dpi,
      engine,
      cached,
      pngPath: renderPath,
      bytes,
      text: textInfo,
      diff,
      source,
      cropApplied: Boolean(crop),
      cropDropped,
      capability,
      pdfPath,
    };
  }

  /** SyncTeX inverse for one point, shaped for message/source fields. */
  async #inverseSource(project, page, point, signal, { approximate = false } = {}) {
    if (!point || !page) return undefined;
    const result = await this.syncTeXResult(
      project,
      { direction: 'inverse', page, x: point.x, y: point.y },
      signal,
    ).catch(() => undefined);
    if (!result?.ok || !result.file) return undefined;
    return {
      file: result.file,
      line: result.line,
      column: result.column,
      approximate: approximate || result.approximate === true,
    };
  }

  /**
   * Compare every page of the published preview against the retained previous
   * build and return changed-page summaries with cropped side-by-side images.
   *
   * The audit is intentionally budgeted: it renders at most `maxPages` pages
   * and returns at most `maxImages` composites, because every returned image
   * becomes model context. Both bounds are configurable.
   */
  async audit(project, args = {}, signal) {
    const pdfPath = await this.#lookPdf(project);
    if (!pdfPath) {
      return {
        ok: false,
        code: 'NO_PDF',
        message: 'No successfully built PDF exists yet. Run latex_compile first, then call latex_audit.',
      };
    }
    const tools = await this.#renderTools();
    const capability = renderCapability(tools);
    const renderTools = this.#renderToolsForEngine(tools);
    if (!renderCapability(renderTools).canRender) {
      return {
        ok: false,
        code: 'NO_RENDERER',
        message: 'No PDF renderer is available. TeX Live ships pdftoppm; alternatively install Ghostscript or muPDF.',
        capability,
      };
    }
    const pages = await pdfPageCount(tools, pdfPath);
    if (!pages) {
      return { ok: false, code: 'PAGE_COUNT_UNKNOWN', message: 'pdfinfo could not report the page count.' };
    }
    const baseline = await this.#resolveAuditBaseline(project, args.against);
    const previousPath = baseline?.pdfPath;
    const hasPrevious = Boolean(previousPath);
    const requestedMaxPages = Number.isFinite(Number(args.maxPages))
      ? Number(args.maxPages)
      : this.config.auditMaxPages;
    const maxPages = Math.max(1, Math.min(60, requestedMaxPages));
    const requestedMaxImages = Number.isFinite(Number(args.maxImages))
      ? Number(args.maxImages)
      : this.config.auditMaxImages;
    const maxImages = Math.max(0, Math.min(5, requestedMaxImages));
    const dpi = clampDpi(args.dpi, this.config.auditDpi);
    const from = clampPage(args.from ?? 1);
    if (from > pages) {
      return { ok: false, code: 'PAGE_OUT_OF_RANGE', message: `Page ${from} is outside this ${pages}-page PDF.`, pages };
    }
    const requestedTo = args.to === undefined ? pages : Math.min(pages, clampPage(args.to));
    const to = Math.min(requestedTo, from + maxPages - 1);
    const truncated = to < requestedTo;
    if (!hasPrevious) {
      return {
        ok: true,
        previous: false,
        pages,
        from,
        to,
        dpi,
        truncated,
        changed: [],
        added: [],
        removed: [],
        failed: [],
        images: [],
        capability,
        baseline: undefined,
        message:
          baseline === undefined
            ? 'No previous build is available; build twice (or edit and rebuild) before auditing.'
            : baseline.message ?? 'No usable baseline build is available.',
      };
    }
    const previousPages = await pdfPageCount(tools, previousPath);
    if (!previousPages) {
      return {
        ok: false,
        code: 'PREVIOUS_PAGE_COUNT_UNKNOWN',
        message: 'pdfinfo could not report the previous build’s page count.',
      };
    }
    const [newHash, previousHash] = await Promise.all([sha256File(pdfPath), sha256File(previousPath)]);
    if (!newHash || !previousHash) {
      return { ok: false, code: 'HASH_FAILED', message: 'Could not hash the built PDFs for the audit cache.' };
    }
    if (newHash === previousHash) {
      return {
        ok: true,
        previous: true,
        identical: true,
        pages,
        previousPages,
        from,
        to,
        dpi,
        truncated,
        changed: [],
        added: [],
        removed: [],
        failed: [],
        images: [],
        capability,
        baseline,
        message: 'The previous build is byte-identical; nothing changed.',
      };
    }
    const newCache = lookCacheDir(project.paths.stateDir, newHash);
    const previousCache = lookCacheDir(project.paths.stateDir, previousHash);
    await mkdir(newCache, { recursive: true });
    await mkdir(previousCache, { recursive: true });

    // Render missing pages in two pdftoppm range calls (new PDF + baseline
    // PDF) instead of one process per page. Single-page fallback below covers
    // missing outputs and non-Poppler renderers.
    const missingNew = [];
    for (let page = from; page <= to; page += 1) {
      if (!(await stat(lookPagePath(newCache, page, dpi)).catch(() => undefined))?.isFile()) {
        missingNew.push(page);
      }
    }
    const missingPrevious = [];
    for (let page = from; page <= Math.min(to, previousPages); page += 1) {
      if (!(await stat(lookPagePath(previousCache, page, dpi)).catch(() => undefined))?.isFile()) {
        missingPrevious.push(page);
      }
    }
    if (renderTools?.pdftoppm && missingNew.length > 1) {
      const range = await renderPageRange(renderTools, {
        pdfPath,
        from: Math.min(...missingNew),
        to: Math.max(...missingNew),
        dpi,
        outDir: newCache,
        signal,
        timeoutMs: this.config.renderTimeoutMs,
      }).catch(() => ({ ok: false }));
      if (range.ok) {
        for (const [page, file] of range.files) {
          await rename(file, lookPagePath(newCache, page, dpi)).catch(() => {});
        }
      }
    }
    if (renderTools?.pdftoppm && missingPrevious.length > 1) {
      const range = await renderPageRange(renderTools, {
        pdfPath: previousPath,
        from: Math.min(...missingPrevious),
        to: Math.max(...missingPrevious),
        dpi,
        outDir: previousCache,
        signal,
        timeoutMs: this.config.renderTimeoutMs,
      }).catch(() => ({ ok: false }));
      if (range.ok) {
        for (const [page, file] of range.files) {
          await rename(file, lookPagePath(previousCache, page, dpi)).catch(() => {});
        }
      }
    }

    const changed = [];
    const added = [];
    const failed = [];
    project.auditProgress = {
      running: true,
      from,
      to,
      page: from,
      startedAt: Date.now(),
    };
    this.#broadcast();
    try {
    for (let page = from; page <= to; page += 1) {
      project.auditProgress.page = page;
      this.#broadcast();
      const newPath = lookPagePath(newCache, page, dpi);
      const newInfo = await stat(newPath).catch(() => undefined);
      if (!newInfo?.isFile()) {
        const rendered = await renderPageToPng(renderTools, {
          pdfPath,
          outPath: newPath,
          page,
          dpi,
          signal,
          timeoutMs: this.config.renderTimeoutMs,
        });
        if (!rendered.ok) {
          failed.push({ page, code: rendered.code, message: rendered.message });
          continue;
        }
      }
      if (page > previousPages) {
        added.push({ page, status: 'added', newPath });
        continue;
      }
      const previousPagePath = lookPagePath(previousCache, page, dpi);
      const previousFile = await stat(previousPagePath).catch(() => undefined);
      if (!previousFile?.isFile()) {
        const rendered = await renderPageToPng(renderTools, {
          pdfPath: previousPath,
          outPath: previousPagePath,
          page,
          dpi,
          signal,
          timeoutMs: this.config.renderTimeoutMs,
        });
        if (!rendered.ok) {
          failed.push({ page, code: rendered.code, message: rendered.message });
          continue;
        }
      }
      const [beforeBuffer, afterBuffer] = await Promise.all([
        readFile(previousPagePath).catch(() => undefined),
        readFile(newPath).catch(() => undefined),
      ]);
      if (!beforeBuffer || !afterBuffer) {
        failed.push({ page, code: 'READ_FAILED', message: 'Could not read one of the rendered pages.' });
        continue;
      }
      const diff = diffPngs(beforeBuffer, afterBuffer, { maxPixels: this.config.lookMaxPixels });
      if (!diff.comparable) {
        changed.push({
          page,
          status: 'changed',
          reason: diff.reason,
          previousPath: previousPagePath,
          newPath,
        });
        continue;
      }
      if (diff.changed > 0) {
        changed.push({
          page,
          status: 'changed',
          changed: diff.changed,
          ratio: diff.ratio,
          box: diff.box,
          previousPath: previousPagePath,
          newPath,
        });
      }
    }

    } finally {
      project.auditProgress = undefined;
      this.#broadcast();
    }
    const removed = [];
    if (previousPages > pages) {
      for (let page = pages + 1; page <= previousPages && removed.length < 20; page += 1) {
        removed.push({ page, status: 'removed' });
      }
    }
    // Source lines for changed/added pages, using the first line of the change
    // box; a page-centre fallback is labelled approximate.
    const forSource = [...changed, ...added];
    for (const entry of forSource) {
      let point = entry.box ? firstLinePoint(entry.box) : undefined;
      let approximate = false;
      if (!point) {
        const size = await this.#pdfPageSize(tools, pdfPath);
        if (size) {
          point = { x: size.width / 2, y: size.height / 2 };
          approximate = true;
        }
      }
      const source = await this.#inverseSource(project, entry.page, point, signal, { approximate });
      if (source) entry.source = source;
    }
    // Side-by-side composites, bounded by maxImages.
    const images = [];
    const candidates = [...changed, ...added].slice(0, Math.max(0, maxImages));
    for (const entry of candidates) {
      try {
        if (entry.status === 'added') {
          const afterBuffer = await readFile(entry.newPath).catch(() => undefined);
          if (!afterBuffer) continue;
          const composed = composeSideBySide(null, decodePng(afterBuffer), { box: null, margin: 0, gutter: 10 });
          if (!composed.ok) continue;
          const file = path.join(newCache, `audit-side-${entry.page}-d${dpi}.png`);
          await writeFile(file, encodePng(composed));
          images.push({ page: entry.page, path: file, bytes: composed.width * composed.height * 3 });
          entry.imagePath = file;
          continue;
        }
        if (!entry.previousPath) continue;
        const [beforeBuffer, afterBuffer] = await Promise.all([
          readFile(entry.previousPath).catch(() => undefined),
          readFile(entry.newPath).catch(() => undefined),
        ]);
        if (!beforeBuffer || !afterBuffer) continue;
        // A paper-size change has no pixel diff box; still show both full
        // pages side by side (padded to the larger canvas), because "the page
        // became A4" is exactly the kind of change a user needs to see.
        const composed = composeSideBySide(decodePng(beforeBuffer), decodePng(afterBuffer), {
          box: entry.box,
          margin: 20,
          gutter: 10,
          allowSizeChange: entry.reason === 'size-changed',
        });
        if (!composed.ok) continue;
        const file = path.join(newCache, `audit-side-${entry.page}-d${dpi}.png`);
        await writeFile(file, encodePng(composed));
        images.push({ page: entry.page, path: file, bytes: composed.width * composed.height * 3 });
        entry.imagePath = file;
      } catch {
        // A composite is an enhancement; the textual summary still stands.
      }
    }
    await pruneLookCaches(project.paths.stateDir, this.config.lookCacheKeep);
    return {
      ok: true,
      previous: true,
      identical: false,
      pages,
      previousPages,
      from,
      to,
      dpi,
      truncated,
      changed,
      added,
      removed,
      failed,
      images,
      capability,
      baseline,
      message:
        changed.length + added.length + removed.length === 0
          ? 'No visible page changes between this build and the previous one.'
          : undefined,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Annotation images, OCR and screenshot questions                     */
  /* ------------------------------------------------------------------ */

  /** Save a validated screenshot under the project's annotation image dir. */
  async #saveAnnotationImage(project, decoded) {
    const dir = annotationImageDir(project);
    await mkdir(dir, { recursive: true });
    const filename = `${randomUUID()}.${IMAGE_EXTENSIONS[decoded.mediaType] ?? 'png'}`;
    const target = annotationImagePath(project, filename);
    if (!target) throw serviceError(500, 'could not allocate an annotation image path', 'IMAGE_PATH');
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, decoded.buffer);
    await rename(temp, target).catch(async (error) => {
      await unlink(temp).catch(() => {});
      throw error;
    });
    return filename;
  }

  /** Merge probe + install state for the snapshot/route. */
  ocrSnapshot() {
    return {
      ...this.ocrState,
      install: this.ocrInstall,
    };
  }

  async #ocrProbes() {
    const rapid = await probeRapidOcr(this.config);
    const toolchain = await this.builder.checkToolchain().catch(() => undefined);
    const extraDirs = [];
    if (toolchain?.binDir) extraDirs.push(toolchain.binDir);
    if (toolchain?.latexmk && path.isAbsolute(toolchain.latexmk)) {
      extraDirs.push(path.dirname(toolchain.latexmk));
    }
    const tesseract = await probeOcr(this.config, { extraDirs });
    return { rapid, tesseract };
  }

  /** Probe/select the OCR engine and publish the state through the snapshot. */
  async refreshOcr() {
    const { rapid, tesseract } = await this.#ocrProbes();
    let engine;
    if (this.config.ocrEnabled === 'off' || this.config.ocrEngine === 'off') {
      engine = 'off';
    } else if (this.config.ocrEngine === 'rapidocr') {
      engine = rapid.ok ? 'rapidocr' : 'missing';
    } else if (this.config.ocrEngine === 'tesseract') {
      engine = tesseract.path ? 'tesseract' : 'missing';
    } else {
      engine = rapid.ok ? 'rapidocr' : tesseract.path ? 'tesseract' : 'missing';
    }
    this.ocrState = {
      checkedAt: Date.now(),
      available: engine === 'rapidocr' || engine === 'tesseract',
      engine,
      rapidocr: { ok: rapid.ok, version: rapid.version, python: rapid.python },
      tesseract: { ok: Boolean(tesseract.path), path: tesseract.path },
      installable: true,
      installDir: defaultOcrInstallDir(this.config),
    };
    this.#broadcast();
    return this.ocrSnapshot();
  }

  async ocrStatus() {
    if (!this.ocrState.checkedAt) return this.refreshOcr();
    return this.ocrSnapshot();
  }

  /** Start the managed RapidOCR install (venv + pip + model warmup). */
  startOcrInstall() {
    if (this.ocrInstall.state === 'installing') {
      return {
        ok: false,
        code: 'BUSY',
        message: 'a local OCR install is already running',
        status: this.ocrSnapshot(),
      };
    }
    this.ocrAbort = new AbortController();
    this.ocrInstall = { state: 'installing', phase: 'venv', percent: 0, error: undefined };
    this.#broadcast();
    this.#runOcrInstall(this.ocrAbort.signal).catch((error) => {
      this.logger.warn('Local OCR install failed: %s', errorMessage(error));
    });
    return { ok: true, status: this.ocrSnapshot() };
  }

  async #runOcrInstall(signal) {
    try {
      const result = await installRapidOcr({
        config: this.config,
        signal,
        timeoutMs: this.config.ocrInstallTimeoutMs,
        logger: this.logger,
        onProgress: (progress) => {
          this.ocrInstall = {
            state: 'installing',
            phase: progress.phase,
            percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
            message: progress.message,
            error: undefined,
          };
          this.#broadcast();
        },
      });
      if (result.ok) {
        clearRapidOcrProbe();
        this.ocrInstall = { state: 'done', phase: 'done', percent: 100, error: undefined };
        await this.refreshOcr().catch(() => {});
      } else {
        this.ocrInstall = {
          state: result.code === 'CANCELLED' ? 'cancelled' : 'failed',
          phase: undefined,
          percent: 0,
          error: {
            code: result.code ?? 'INSTALL_FAILED',
            message: result.message ?? 'OCR install failed',
          },
        };
        this.#broadcast();
      }
    } finally {
      this.ocrAbort = undefined;
    }
  }

  cancelOcrInstall() {
    if (!this.ocrAbort) return { ok: true, cancelled: false };
    this.ocrAbort.abort();
    this.ocrInstall = { state: 'cancelled', phase: undefined, percent: 0, error: undefined };
    this.#broadcast();
    return { ok: true, cancelled: true };
  }

  /** Run OCR for one in-memory image with the configured engine. */
  async #ocrBuffer(buffer, extension, signal) {
    if (this.config.ocrEnabled === 'off' || this.config.ocrEngine === 'off') {
      return { ok: false, text: '', message: 'OCR is disabled.' };
    }
    try {
      if (this.config.ocrEngine !== 'tesseract') {
        const rapid = await probeRapidOcr(this.config);
        if (rapid.ok) {
          return await withTemporaryImage(buffer, extension, (file) =>
            ocrWithRapidOcr(file, {
              config: this.config,
              timeoutMs: this.config.ocrTimeoutMs,
              signal,
            }),
          );
        }
      }
      if (this.config.ocrEngine !== 'rapidocr') {
        const { tesseract } = await this.#ocrProbes();
        if (tesseract.path) {
          return await withTemporaryImage(buffer, extension, (file) =>
            ocrImage(file, {
              tesseract: tesseract.path,
              languages: this.config.ocrLanguages,
              timeoutMs: this.config.ocrTimeoutMs,
              signal,
            }),
          );
        }
      }
    } catch (error) {
      return { ok: false, text: '', message: errorMessage(error) };
    }
    return {
      ok: false,
      text: '',
      message: 'No local OCR engine is installed. Install RapidOCR from the preview prompt.',
    };
  }

  /** Run optional OCR for one stored annotation image. */
  async #ocrForImage(project, filename) {
    if (this.config.ocrEnabled === 'off' || this.config.ocrEngine === 'off') {
      return { ok: false, text: '', message: 'OCR is disabled.' };
    }
    const imagePath = annotationImagePath(project, filename);
    if (!imagePath) return { ok: false, text: '', message: 'annotation image path is invalid.' };
    const buffer = await readFile(imagePath).catch(() => undefined);
    if (!buffer) return { ok: false, text: '', message: 'annotation image is missing.' };
    const lower = filename.toLowerCase();
    const extension = lower.endsWith('.webp') ? 'webp' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpg' : 'png';
    return this.#ocrBuffer(buffer, extension);
  }

  async annotationImage(project, id) {
    const store = await this.annotations.read(project);
    const item = store.items.find((entry) => entry.id === id);
    if (!item?.image) throw serviceError(404, 'annotation image not found', 'NOT_FOUND');
    const target = annotationImagePath(project, item.image);
    if (!target) throw serviceError(404, 'annotation image path is invalid', 'NOT_FOUND');
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile()) throw serviceError(404, 'annotation image file is missing', 'NOT_FOUND');
    const mediaType = item.image.endsWith('.jpg') || item.image.endsWith('.jpeg')
      ? 'image/jpeg'
      : item.image.endsWith('.webp')
        ? 'image/webp'
        : 'image/png';
    return { path: target, mediaType, bytes: info.size };
  }

  async removeAnnotation(project, id) {
    return this.annotations.remove(project, id);
  }

  /**
   * Send a cropped screenshot plus a question into one session.
   * OCR text, when available, is appended to the text part as a hint.
   */
  async askImage(input = {}, signal) {
    const sessionId = String(input.sessionId ?? '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) {
      throw serviceError(400, 'sessionId is invalid', 'BAD_SESSION');
    }
    const decoded = decodeImagePayload(input.image, this.config.askImageMaxBytes);
    if (!decoded) {
      throw serviceError(
        400,
        `image must be a PNG/JPEG/WebP base64 payload no larger than ${this.config.askImageMaxBytes} bytes`,
        'BAD_IMAGE',
      );
    }
    const question = String(input.question ?? '').trim().slice(0, 4000);
    const page = Math.max(1, Math.round(Number(input.page) || 1));
    let ocr = '';
    if (this.config.ocrEnabled !== 'off' && this.config.ocrEngine !== 'off') {
      const extension = IMAGE_EXTENSIONS[decoded.mediaType] ?? 'png';
      ocr = await this.#ocrBuffer(decoded.buffer, extension, signal)
        .then((result) => (result?.ok ? result.text : ''))
        .catch(() => '');
    }
    const project = input.project;
    const lines = [`【LaTeX PDF 选区截图】第 ${page} 页`];
    if (project?.rootDir) lines.push(`项目：${project.rootDir}`);
    if (project?.mainFile) {
      const relative = path.relative(project.rootDir ?? '', project.mainFile).replace(/\\/g, '/');
      lines.push(`主文档：${relative && !relative.startsWith('..') ? relative : project.mainFile}`);
    }
    lines.push('');
    lines.push(question || '请阅读这张 PDF 截图，解释内容并指出需要修改的地方。');
    if (ocr) {
      lines.push('');
      lines.push('OCR 文本（可能不准确，仅作线索）：');
      lines.push(ocr.slice(0, 3000));
    }
    const text = lines.join('\n');
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.prompt !== 'function') {
      throw serviceError(
        503,
        'This Host has no session controller, so screenshot questions cannot be sent. Copy the question instead.',
        'NO_SESSION_SERVICE',
      );
    }
    if (typeof controller.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId).catch(() => undefined);
      if (resolved && resolved.error) {
        throw serviceError(404, `Session ${sessionId} is not available in this Host.`, 'SESSION_UNAVAILABLE');
      }
    }
    const requestId = randomUUID();
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 120_000);
    timer.unref?.();
    const onAbort = () => cancellation.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await controller.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [
            { type: 'text', text },
            {
              type: 'image',
              mediaType: decoded.mediaType,
              data: decoded.base64,
              name: `latex-selection-${page}.${IMAGE_EXTENSIONS[decoded.mediaType] ?? 'png'}`,
            },
          ],
        },
        cancellation.signal,
      );
    } catch (error) {
      if (cancellation.signal.aborted) {
        throw serviceError(504, 'The session did not accept the screenshot within 120 seconds.', 'ASK_TIMEOUT');
      }
      throw serviceError(502, `The session rejected the screenshot: ${errorMessage(error)}`, 'ASK_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    return { ok: true, requestId, sessionId, page, ocr: ocr ? ocr.slice(0, 2000) : undefined };
  }


  /** Build history written by the builder; missing/corrupt history is empty. */
  async history(project) {
    try {
      const raw = await readFile(project.paths.historyIndexPath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return {
        ok: true,
        currentVersion: project.previewVersion,
        entries: entries.map((entry) => ({
          ...entry,
          current: Number(entry.version) === Number(project.previewVersion),
        })),
      };
    } catch {
      return { ok: true, currentVersion: project.previewVersion, entries: [] };
    }
  }

  /**
   * Choose the PDF audit should compare against.
   *
   * default (auto): the newest manual/editor build, falling back to the one
   * retained previous build. `previous` forces the retained preview, a numeric
   * version selects a history entry. Auto-builds are never the default baseline
   * because a watcher rebuild can otherwise consume the change being audited.
   */
  async #resolveAuditBaseline(project, against) {
    const history = await this.history(project);
    const entries = history.entries.filter(
      (entry) => Number(entry.version) !== Number(project.previewVersion),
    );
    const resolveEntry = (entry) => {
      const pdfPath = path.join(project.paths.historyDir, path.basename(String(entry.pdf ?? '')));
      return {
        pdfPath,
        kind: 'history',
        version: entry.version,
        reason: entry.reason,
        builtAt: entry.builtAt,
        manual: entry.manual === true,
      };
    };
    const exists = async (target) =>
      Boolean((await stat(target).catch(() => undefined))?.isFile());
    if (against === 'previous') {
      const target = project.paths.previousPath;
      if (await exists(target)) {
        return { pdfPath: target, kind: 'previous', version: undefined, reason: 'previous', manual: false };
      }
      return undefined;
    }
    if (typeof against === 'string' && against !== '' && against !== 'last-manual') {
      const entry = entries.find((item) => String(item.version) === against);
      if (!entry) return { message: `Build ${against} is not in this project’s history.` };
      const candidate = resolveEntry(entry);
      if (!(await exists(candidate.pdfPath))) {
        return { message: `Build ${against} is listed but its PDF is missing.` };
      }
      return candidate;
    }
    if (against === 'last-manual') {
      const entry = entries.find((item) => item.manual === true);
      if (!entry) return { message: 'No earlier manual build is available yet.' };
      const candidate = resolveEntry(entry);
      if (!(await exists(candidate.pdfPath))) {
        return { message: 'The last manual build PDF is missing.' };
      }
      return candidate;
    }
    // auto: prefer the last manual build, then the retained previous preview.
    const manual = entries.find((item) => item.manual === true);
    if (manual) {
      const candidate = resolveEntry(manual);
      if (await exists(candidate.pdfPath)) return candidate;
    }
    if (await exists(project.paths.previousPath)) {
      return {
        pdfPath: project.paths.previousPath,
        kind: 'previous',
        version: undefined,
        reason: 'previous',
        manual: false,
      };
    }
    const newest = entries[0];
    if (newest) {
      const candidate = resolveEntry(newest);
      if (await exists(candidate.pdfPath)) return candidate;
    }
    return undefined;
  }

  /** Serve one audit composite from the project state directory. */
  async auditImage(project, name) {
    if (typeof name !== 'string' || !/^audit-side-\d+-d\d+\.png$/.test(name)) {
      throw serviceError(400, 'audit image name is invalid', 'BAD_IMAGE');
    }
    const target = path.join(project.paths.stateDir, 'look');
    const caches = await listLookCaches(project.paths.stateDir);
    for (const cache of caches) {
      const candidate = path.join(cache.dir, name);
      if (!isInside(target, candidate)) continue;
      const info = await stat(candidate).catch(() => undefined);
      if (info?.isFile()) return { path: candidate, bytes: info.size, mediaType: 'image/png' };
    }
    throw serviceError(404, 'audit image not found', 'NOT_FOUND');
  }

  /* ------------------------------------------------------------------ */
  /* Optional TinyTeX bootstrap                                          */
  /* ------------------------------------------------------------------ */

  toolchainStatus() {
    return {
      ok: true,
      ...this.toolchainInstaller.status(),
      defaultUrl: this.config.toolchainUrl || defaultTinyTexUrl(),
      configuredTexBinDir: this.config.texBinDir,
      platform: process.platform,
      canInstall: process.platform === 'win32',
    };
  }

  /** Start a one-click install in the background; poll toolchainStatus(). */
  startToolchainInstall(options = {}) {
    if (process.platform !== 'win32') {
      return {
        ok: false,
        code: 'UNSUPPORTED_PLATFORM',
        message:
          'One-click TinyTeX install is Windows-only; install TeX Live/TinyTeX manually and set texBinDir.',
        status: this.toolchainStatus(),
      };
    }
    const status = this.toolchainInstaller.status();
    if (status.state === 'downloading' || status.state === 'verifying' || status.state === 'extracting') {
      return { ok: false, code: 'BUSY', message: 'a toolchain install is already running', status: this.toolchainStatus() };
    }
    const url =
      (typeof options.url === 'string' && options.url.trim() !== '' ? options.url.trim() : '') ||
      this.config.toolchainUrl ||
      defaultTinyTexUrl();
    const sha256 =
      (typeof options.sha256 === 'string' && options.sha256.trim() !== '' ? options.sha256.trim() : '') ||
      this.config.toolchainSha256 ||
      undefined;
    this.installToolchain({ url, sha256 }).catch((error) => {
      this.logger.warn('LaTeX toolchain install failed: %s', errorMessage(error));
    });
    return { ok: true, status: this.toolchainStatus() };
  }

  async installToolchain(options = {}) {
    const result = await this.toolchainInstaller.install({
      url: options.url,
      sha256: options.sha256,
      timeoutMs: this.config.toolchainTimeoutMs,
    });
    if (result.ok && result.binDir) {
      // Switch the running builder to the managed TeX tree without touching
      // PATH or the registry; the next probe sees the new tools.
      this.config.texBinDir = result.binDir;
      this.builder.config.texBinDir = result.binDir;
      this.builder.toolchain = undefined;
      this.builder.toolchainCheckedAt = 0;
      await this.builder.checkToolchain({ refresh: true }).catch(() => {});
      this.#broadcast();
      this.logger.info('LaTeX toolchain installed at %s', result.binDir);
    }
    return result;
  }

  cancelToolchainInstall() {
    const cancelled = this.toolchainInstaller.cancel();
    return { ok: true, cancelled };
  }

  /** Collect bounded `.tex`/`.bib` sources for the paper checks. */
  async #paperSources(project) {
    const files = [];
    const bibs = [];
    let totalBytes = 0;
    const skip = new Set([
      'node_modules',
      '.git',
      '.hg',
      '.svn',
      'build',
      '.dsh-latex',
      'dist',
      '__pycache__',
      '.venv',
      'venv',
      'site-packages',
    ]);
    const walk = async (dir, depth) => {
      if (depth > 6 || files.length >= 400) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= 400) break;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith('.tex') && !lower.endsWith('.bib')) continue;
        const info = await stat(full).catch(() => undefined);
        if (!info?.isFile() || info.size > 2 * 1024 * 1024) continue;
        if (totalBytes + info.size > 8 * 1024 * 1024) continue;
        const text = await readFile(full, 'utf8').catch(() => undefined);
        if (typeof text !== 'string') continue;
        totalBytes += info.size;
        if (lower.endsWith('.tex')) files.push({ path: full, text });
        else bibs.push({ path: full, text });
      }
    };
    await walk(project.rootDir, 0);
    return { files, bibs };
  }

  async citationAudit(project) {
    const { files, bibs } = await this.#paperSources(project);
    const bibText = bibs.map((item) => item.text).join('\n');
    const result = citeAudit({ texFiles: files, bibText });
    return {
      ...result,
      texFiles: files.map((item) => path.relative(project.rootDir, item.path).replace(/\\/g, '/')),
      bibFiles: bibs.map((item) => path.relative(project.rootDir, item.path).replace(/\\/g, '/')),
    };
  }

  async bibliographyLint(project) {
    const { bibs } = await this.#paperSources(project);
    const bibText = bibs.map((item) => item.text).join('\n');
    const parsed = parseBibTeX(bibText);
    return {
      ok: parsed.ok,
      errors: parsed.errors,
      entries: parsed.entries,
      issues: bibLint(parsed.entries).issues,
      bibFiles: bibs.map((item) => path.relative(project.rootDir, item.path).replace(/\\/g, '/')),
    };
  }

  async layoutCheck(project) {
    const { bibs } = await this.#paperSources(project);
    const log = await this.readLog(project).catch(() => undefined);
    const auxPath = path.join(project.paths.buildDirAbs, `${project.paths.stem}.aux`);
    const auxText = await readFile(auxPath, 'utf8').catch(() => '');
    const result = layoutAudit({
      auxText,
      logText: log?.text ?? project.lastBuildResult?.logTail ?? '',
      diagnostics: project.lastBuildResult?.diagnostics ?? project.diagnostics,
      pages: project.previewPages,
      customRules: this.config.layoutRules,
    });
    return { ...result, auxPath, logPath: log?.path };
  }

  /** Crossref lookup (no API key) returning fields missing from a bib entry. */
  async crossrefFill(project, input = {}) {
    const doi = String(input.doi ?? '').trim();
    if (doi === '') throw serviceError(400, 'doi is required', 'BAD_DOI');
    if (doi.length > 300) throw serviceError(400, 'doi is too long', 'BAD_DOI');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    timer.unref?.();
    let payload;
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { 'user-agent': 'dsh-latex/0.6 (https://github.com/Yaohua-Leo/dsh-latex)' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      throw serviceError(502, `Crossref lookup failed: ${errorMessage(error)}`, 'CROSSREF_FAILED');
    } finally {
      clearTimeout(timer);
    }
    const message = payload?.message ?? {};
    const authors = Array.isArray(message.author)
      ? message.author
          .map((author) => [author.family, author.given].filter(Boolean).join(', '))
          .filter(Boolean)
          .join(' and ')
      : '';
    const year = message.issued?.['date-parts']?.[0]?.[0];
    const fields = {
      title: Array.isArray(message.title) ? message.title[0] : message.title,
      author: authors || undefined,
      journal: Array.isArray(message['container-title']) ? message['container-title'][0] : undefined,
      year: year !== undefined ? String(year) : undefined,
      volume: message.volume,
      issue: message.issue,
      pages: message.page,
      doi: message.DOI ?? doi,
    };
    const key = String(input.key ?? '').trim();
    const { bibs } = await this.#paperSources(project);
    const parsed = parseBibTeX(bibs.map((item) => item.text).join('\n'));
    const entry = key ? parsed.entries.find((item) => item.key === key) : undefined;
    const missing = {};
    if (entry) {
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === '') continue;
        if (!entry.fields?.[name]) missing[name] = value;
      }
    }
    return {
      ok: true,
      doi,
      key: entry?.key,
      found: Boolean(entry),
      fields,
      missing,
      message: entry
        ? Object.keys(missing).length > 0
          ? 'Proposed values for fields missing from the bib entry (nothing is written automatically).'
          : 'No missing Crossref-backed fields for this entry.'
        : 'No matching bib entry; fields are returned for manual use.',
    };
  }

  async listAnnotations(project) {
    const reanchor = await this.#reanchorProvider(project);
    const result = await this.annotations.list(project, {
      buildVersion: project.previewVersion,
      reanchor,
    });
    return { ...result, reanchorAvailable: Boolean(reanchor) };
  }

  async createAnnotation(project, input = {}) {
    let image;
    let ocrText;
    if (input.image !== undefined) {
      const decoded = decodeImagePayload(input.image, this.config.annotationImageMaxBytes);
      if (!decoded) {
        throw serviceError(
          400,
          `screenshot must be a PNG/JPEG/WebP base64 payload no larger than ${this.config.annotationImageMaxBytes} bytes`,
          'BAD_IMAGE',
        );
      }
      image = await this.#saveAnnotationImage(project, decoded);
      if (this.config.ocrEnabled !== 'off') {
        const ocr = await this.#ocrForImage(project, image).catch(() => undefined);
        if (ocr?.ok && ocr.text) ocrText = ocr.text;
      }
    }
    return this.annotations.create(project, { ...input, image, ocrText });
  }

  async updateAnnotation(project, input) {
    return this.annotations.update(project, input);
  }

  async clearAnnotations(project, options = {}) {
    return this.annotations.clear(project, options);
  }

  async annotationsCount(project) {
    return this.annotations.count(project);
  }

  /**
   * Send a preview selection into one Harness session as a normal user message.
   * The controller is a Host service, so the plugin does not need an npm import.
   *
   * @param {{ sessionId: string, project?: object, page?: number, quote: string, question?: string, source?: object }} input
   * @param {AbortSignal} [signal]
   */
  async askFromSelection(input = {}, signal) {
    const sessionId = String(input.sessionId ?? '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) {
      throw serviceError(400, 'sessionId is invalid', 'BAD_SESSION');
    }
    const quote = String(input.quote ?? '').replace(/\r\n?/g, '\n').trim();
    if (quote === '') throw serviceError(400, 'quote is required', 'BAD_QUOTE');
    if (quote.length > 4000) throw serviceError(400, 'quote is too long (max 4000 characters)', 'BAD_QUOTE');
    const question = String(input.question ?? '').trim().slice(0, 4000);
    let page = Math.max(1, Math.round(Number(input.page) || 1));
    let source = input.source;
    // Prefer the PDF's own text boxes over the browser's approximate point:
    // find the quote, then invert SyncTeX at the first line of its box. This is
    // what makes "\section{An equation}" resolve to line 11, not a nearby
    // theorem at line 16.
    const project = input.project;
    const pdfPath = project ? await this.#lookPdf(project).catch(() => undefined) : undefined;
    if (pdfPath && quote) {
      const tools = await this.#renderTools().catch(() => undefined);
      if (tools?.pdftotext) {
        const located = await locateQuote(tools, pdfPath, quote, {
          pageHint: page,
          maxPages: 300,
        }).catch(() => undefined);
        if (located?.ok) {
          page = located.page;
          const point = firstLinePoint(located.box);
          const computed = await this.#inverseSource(project, page, point, signal);
          if (computed) source = computed;
        }
      }
    }
    if (!source && input.point && project) {
      source = await this.#inverseSource(project, page, validPoint(input.point), signal, {
        approximate: true,
      });
    }
    const controller = this.ctx.get('sessionController');
    if (!controller || typeof controller.prompt !== 'function') {
      throw serviceError(
        503,
        'This Host has no session controller, so preview selections cannot be sent into a chat. Copy the selection instead.',
        'NO_SESSION_SERVICE',
      );
    }
    if (typeof controller.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId).catch(() => undefined);
      if (resolved && resolved.error) {
        throw serviceError(404, `Session ${sessionId} is not available in this Host.`, 'SESSION_UNAVAILABLE');
      }
    }
    const lines = [`【LaTeX PDF 选区】第 ${page} 页`];
    if (input.project?.rootDir) lines.push(`项目：${input.project.rootDir}`);
    if (input.project?.mainFile) {
      const relative = path.relative(input.project.rootDir ?? '', input.project.mainFile).replace(/\\/g, '/');
      lines.push(`主文档：${relative && !relative.startsWith('..') ? relative : input.project.mainFile}`);
    }
    if (source?.file) {
      const absolute = path.isAbsolute(source.file)
        ? source.file
        : path.resolve(input.project?.rootDir ?? '', source.file);
      lines.push(
        `源码位置：${absolute.replace(/\\/g, '/')}${source.line ? `:${source.line}` : ''}${
          source.approximate ? '（近似）' : ''
        }`,
      );
    }
    lines.push('');
    lines.push(quote.split('\n').map((line) => `> ${line}`).join('\n'));
    lines.push('');
    lines.push(question || '请解释这段内容，说明它在全文里的作用，并指出需要改动的源文件位置。');
    const text = lines.join('\n');
    const requestId = randomUUID();
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 120_000);
    timer.unref?.();
    const onAbort = () => cancellation.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await controller.prompt(
        { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        cancellation.signal,
      );
    } catch (error) {
      if (cancellation.signal.aborted) {
        throw serviceError(504, 'The session did not accept the message within 120 seconds.', 'ASK_TIMEOUT');
      }
      throw serviceError(502, `The session rejected the message: ${errorMessage(error)}`, 'ASK_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    return { ok: true, requestId, sessionId, page, chars: text.length };
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
    let render;
    try {
      render = renderCapability(await this.#renderTools());
    } catch (error) {
      render = { canRender: false, canExtractText: false, error: errorMessage(error) };
    }
    return {
      ok: true,
      name: 'dsh-latex',
      version: '0.6.1',
      pid: process.pid,
      startedAt: this.startedAt,
      projects: this.projects.size,
      toolchain,
      render,
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
