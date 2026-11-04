/**
 * HTTP surface of the LaTeX plugin.
 *
 * Everything here is same-origin, loopback-bound JSON/PDF: the panel and the
 * PDF viewer are ordinary browser fetches, exactly like the built-in sidebar
 * tabs. Every route except the harmless health probe goes through the same
 * Connection admission boundary the rest of the Harness uses.
 *
 * Route table (all under /latex):
 *   GET  /health                 toolchain + liveness
 *   GET  /state?session=&cwd=    full project snapshot for the UI
 *   GET  /events?session=        Server-Sent Events with snapshots
 *   GET  /pdf?project=           last successful PDF bytes
 *   GET  /log?project=           raw .log tail
 *   GET  /assets/<name>          the two pinned PDF.js modules
 *   GET  /file?path=             read one .tex source for the editor
 *   POST /file                   atomically save one .tex source (CAS)
 *   POST /action                 compile/cancel/clean/watch/preview/
 *                                compile-file
 *   POST /synctex-inverse        PDF point -> source line
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, isInside, tailText } from './util.js';

const BODY_LIMIT = 64 * 1024;
const FILE_BODY_LIMIT = 8 * 1024 * 1024;
const STREAM_LIMIT = 24;
const HEARTBEAT_MS = 15_000;
const ASSET_NAMES = new Set(['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE-pdfjs.txt']);
const ASSET_DIR = fileURLToPath(new URL('../assets/', import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  let payload;
  try {
    payload = JSON.stringify(body);
  } catch {
    payload = '{"error":"response serialization failed"}';
    status = 500;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'expected application/json');
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(declared?.match(/^\d+$/) ? 413 : 400, 'invalid request body length');
  }
  const chunks = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      try {
        const raw = Buffer.concat(chunks, size).toString('utf8');
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    };
    const onError = () => fail(new HttpError(400, 'request body read failed'));
    const onAborted = () => fail(new HttpError(400, 'request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Read a JSON object body, rejecting arrays, scalars and empty/invalid bodies.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonObject(req, limit = BODY_LIMIT) {
  const body = await readJsonBody(req, limit);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  return body;
}

function admit(ctx, req, res) {
  try {
    const connection = ctx.get('connection');
    if (!connection || typeof connection.admit !== 'function') {
      sendJson(res, 503, { error: 'connection service unavailable' }, { connection: 'close' });
      return false;
    }
    const admission = connection.admit({ headers: req.headers });
    if (admission && 'rejection' in admission) {
      sendJson(res, admission.rejection === 401 ? 401 : 403, { error: 'request refused' }, { connection: 'close' });
      return false;
    }
    if (!admission?.peer) {
      sendJson(res, 403, { error: 'unauthenticated request' }, { connection: 'close' });
      return false;
    }
    return true;
  } catch (error) {
    sendJson(res, 503, { error: `connection admission failed: ${errorMessage(error)}` }, { connection: 'close' });
    return false;
  }
}

function pickProject(service, query) {
  const id = query.get('project');
  if (id) {
    const project = service.getProject(id);
    if (!project) throw new HttpError(404, 'project not found');
    return project;
  }
  const sessionId = query.get('session');
  if (sessionId) {
    const project = service.findProjectForSession(sessionId);
    if (project) return project;
  }
  const cwd = query.get('cwd');
  if (cwd) {
    const resolved = path.resolve(cwd);
    const match = [...service.projects.values()]
      .filter((project) => isInside(project.rootDir, resolved) || isInside(resolved, project.rootDir))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (match) return match;
  }
  throw new HttpError(400, 'project is required');
}

function summaryForClient(service, project) {
  const snapshot = service.snapshot();
  const summary = snapshot.projects.find((entry) => entry.id === project.id);
  return { project: summary, snapshot };
}

function rankForSession(service, { sessionId, cwd }) {
  const projects = [...service.projects.values()];
  if (projects.length === 0) return undefined;
  if (sessionId) {
    const bySession = projects.filter((project) => project.sessionIds.has(String(sessionId)));
    if (bySession.length === 1) return bySession[0];
    if (bySession.length > 1) {
      return bySession.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    }
  }
  if (cwd) {
    const resolved = path.resolve(cwd);
    const ordered = projects
      .map((project) => ({
        project,
        distance: isInside(project.rootDir, resolved)
          ? path.relative(project.rootDir, resolved).split(path.sep).length
          : Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.distance - b.distance || b.project.lastUsedAt - a.project.lastUsedAt);
    if (Number.isFinite(ordered[0].distance)) return ordered[0].project;
  }
  return projects.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
}

function compactBuildResult(result) {
  return {
    status: result.status,
    projectId: result.projectId,
    engine: result.engine,
    durationMs: result.durationMs,
    durationText: result.durationText,
    exitCode: result.exitCode,
    pages: result.pages,
    previewVersion: result.previewVersion,
    pdfPath: result.pdfPath,
    previewPath: result.previewPath,
    error: result.error,
    diagnostics: result.diagnostics
      ? {
          counts: result.diagnostics.counts,
          errors: (result.diagnostics.errors ?? []).slice(0, 40),
          warnings: (result.diagnostics.warnings ?? []).slice(0, 40),
        }
      : undefined,
  };
}

/**
 * Register the HTTP routes with the Host web server.
 * @returns {() => void} disposer (also removes live SSE clients)
 */
export function registerLatexRoutes(ctx, service, config) {
  const webServer = ctx.get('webServer');
  if (!webServer) return () => {};
  const logger = ctx.logger('latex');
  const streams = new Set();

  const disposeRoutes = webServer.register({
    kind: 'prefix',
    path: '/latex',
    async handler(req, res) {
      const url = req.url ?? '';
      if (url.length > 8192) {
        sendJson(res, 414, { error: 'URL too long' }, { connection: 'close' });
        return;
      }
      const parsed = new URL(url, 'http://localhost');
      const pathname = parsed.pathname;
      const method = req.method ?? 'GET';

      // Health is deliberately unauthenticated: it is loopback-only, carries no
      // project data, and lets a human verify the plugin without a browser.
      if (pathname === '/latex/health' && method === 'GET') {
        try {
          sendJson(res, 200, await service.health());
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) });
        }
        return;
      }

      if (!admit(ctx, req, res)) return;

      try {
        if (pathname === '/latex/state' && method === 'GET') {
          const query = parsed.searchParams;
          const sessionId = query.get('session') ?? undefined;
          const cwd = query.get('cwd') ?? undefined;
          const active = rankForSession(service, { sessionId, cwd });
          const snapshot = service.snapshot();
          sendJson(res, 200, {
            ...snapshot,
            activeProjectId: active?.id,
          });
          return;
        }

        if (pathname === '/latex/events' && method === 'GET') {
          if (streams.size >= STREAM_LIMIT) {
            sendJson(res, 429, { error: 'too many event streams' }, { 'retry-after': '15' });
            return;
          }
          const sessionId = parsed.searchParams.get('session') ?? undefined;
          openEventStream(res, service, streams, sessionId);
          return;
        }

        if (pathname === '/latex/pdf' && method === 'GET') {
          const project = pickProject(service, parsed.searchParams);
          const target = project.paths.previewPath;
          const info = await stat(target).catch(() => undefined);
          if (!info?.isFile()) {
            sendJson(res, 404, { error: 'no successful PDF has been built yet' });
            return;
          }
          if (!isInside(project.paths.buildDirAbs, target) || !isInside(project.rootDir, target)) {
            sendJson(res, 500, { error: 'refusing to serve a file outside the project build directory' });
            return;
          }
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': String(info.size),
            'cache-control': 'no-store',
            'content-disposition': 'inline; filename="latex-preview.pdf"',
            'x-content-type-options': 'nosniff',
            'x-latex-version': String(project.previewVersion || 0),
          });
          const stream = createReadStream(target);
          stream.on('error', (error) => {
            logger.warn('LaTeX PDF stream failed: %s', errorMessage(error));
            res.destroy();
          });
          stream.pipe(res);
          return;
        }

        if (pathname === '/latex/log' && method === 'GET') {
          const project = pickProject(service, parsed.searchParams);
          const log = await service.readLog(project, 512 * 1024);
          if (!log) {
            sendJson(res, 404, { error: 'no build log available' });
            return;
          }
          sendText(res, 200, log.text, {
            'x-latex-log-path': encodeURIComponent(log.path),
            'x-latex-log-size': String(log.size ?? log.text.length),
          });
          return;
        }

        if (pathname.startsWith('/latex/assets/') && method === 'GET') {
          const name = pathname.slice('/latex/assets/'.length);
          if (!ASSET_NAMES.has(name)) {
            sendJson(res, 404, { error: 'asset not found' });
            return;
          }
          const target = path.join(ASSET_DIR, name);
          const info = await stat(target).catch(() => undefined);
          if (!info?.isFile()) {
            sendJson(res, 404, { error: 'asset unavailable', name });
            return;
          }
          const etag = `"${Math.round(info.mtimeMs)}-${info.size}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            res.end();
            return;
          }
          res.writeHead(200, {
            'content-type': name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8',
            'content-length': String(info.size),
            'cache-control': 'no-cache',
            etag,
            'x-content-type-options': 'nosniff',
          });
          const stream = createReadStream(target);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }

        if (pathname === '/latex/file' && method === 'GET') {
          const target = parsed.searchParams.get('path') ?? '';
          const file = await service.readSourceFile(target);
          sendJson(res, 200, { ok: true, file });
          return;
        }

        if (pathname === '/latex/file' && method === 'POST') {
          const body = await readJsonObject(req, FILE_BODY_LIMIT);
          if (typeof body.path !== 'string' || body.path.trim() === '') {
            throw new HttpError(400, 'path is required');
          }
          if (typeof body.content !== 'string') {
            throw new HttpError(400, 'content must be a string');
          }
          const expectedRevision =
            typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined;
          const file = await service.writeSourceFile(body.path, body.content, expectedRevision);
          sendJson(res, 200, { ok: true, file });
          return;
        }

        if (pathname === '/latex/action' && method === 'POST') {
          const body = await readJsonObject(req);
          const response = await performAction(ctx, service, config, body, req);
          sendJson(res, 200, response);
          return;
        }

        if (pathname === '/latex/synctex-inverse' && method === 'POST') {
          const body = await readJsonObject(req);
          const project = body.project ? service.getProject(String(body.project)) : undefined;
          if (!project) throw new HttpError(404, 'project not found');
          const result = await service.syncTeXResult(project, {
            direction: 'inverse',
            page: Number(body.page),
            x: Number(body.x),
            y: Number(body.y),
          });
          sendJson(res, 200, { ok: true, synctex: result });
          return;
        }

        if (pathname === '/latex/synctex' && method === 'GET') {
          const project = pickProject(service, parsed.searchParams);
          const result = await service.syncTeXResult(project, {
            direction: 'forward',
            file: parsed.searchParams.get('file') ?? undefined,
            line: Number(parsed.searchParams.get('line')),
            column: Number(parsed.searchParams.get('column')) || 1,
          });
          sendJson(res, 200, { ok: true, synctex: result });
          return;
        }

        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        const status = error instanceof HttpError
          ? error.status
          : Number.isInteger(error?.status)
            ? error.status
            : 500;
        if (status >= 500) logger.warn('LaTeX route failed: %s', errorMessage(error));
        const payload = { error: errorMessage(error) };
        if (error?.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
          Object.assign(payload, error.details);
        }
        sendJson(res, status, payload);
      }
    },
  });

  return () => {
    try {
      disposeRoutes();
    } catch {
      // Already disposed.
    }
    for (const cleanup of [...streams]) {
      try {
        cleanup();
      } catch {
        // Already closed.
      }
    }
    streams.clear();
  };
}

async function performAction(ctx, service, config, body, req) {
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'compile-file') {
    const target = typeof body.path === 'string' ? body.path.trim() : '';
    if (target === '') throw new HttpError(400, 'path is required');
    if (!/\.tex$/i.test(target)) throw new HttpError(400, 'path must be a .tex file');
    let compiled;
    try {
      compiled = await service.compilePath({
        path: target,
        cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined,
        sessionId:
          typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined,
        force: body.force === true,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      throw new HttpError(status, errorMessage(error));
    }
    const { project, result } = compiled;
    return {
      ok: true,
      projectId: project.id,
      result: compactBuildResult(result),
      previewPath: project.paths.previewPath,
      previewVersion: project.previewVersion,
      previewPages: project.previewPages,
      snapshot: service.snapshot(),
    };
  }
  const project = body.project ? service.getProject(String(body.project)) : undefined;
  if (action === 'status') {
    return { ok: true, snapshot: service.snapshot() };
  }
  if (!project) throw new HttpError(404, 'project not found');
  switch (action) {
    case 'compile': {
      const result = await service.enqueueBuild(project, {
        reason: 'ui',
        force: body.force === true,
        engine: typeof body.engine === 'string' ? body.engine : undefined,
        engineExplicit: typeof body.engine === 'string',
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        open: body.open !== false,
      });
      return { ok: true, result: compactBuildResult(result), snapshot: service.snapshot() };
    }
    case 'cancel':
      return { ok: true, result: service.cancel(project), snapshot: service.snapshot() };
    case 'clean': {
      const result = await service.clean(project, {
        includePdf: body.includePdf === true,
        includePreview: body.includePreview === true,
      });
      return { ok: true, result, snapshot: service.snapshot() };
    }
    case 'watch': {
      const enabled = body.enabled !== false;
      const active = service.setAutoBuild(project, enabled);
      return { ok: true, autoBuild: active, snapshot: service.snapshot() };
    }
    case 'preview': {
      const request = service.requestPreview(project, {
        page: typeof body.page === 'number' ? Math.max(1, Math.round(body.page)) : undefined,
        reason: 'ui',
        surface: typeof body.surface === 'string' ? body.surface : undefined,
      });
      return { ok: true, previewRequest: request, snapshot: service.snapshot() };
    }
    case 'renameProject':
      return { ok: false, error: 'not supported' };
    default:
      throw new HttpError(400, `unknown action: ${String(action).slice(0, 80)}`);
  }
}

function openEventStream(res, service, streams, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const writeState = (snapshot) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      cleanup();
    }
  };
  const unsubscribe = service.subscribe(writeState);
  writeState(service.snapshot());
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    streams.delete(cleanup);
    try {
      res.end();
    } catch {
      // Already gone.
    }
  }
  streams.add(cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}
