import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerLatexRoutes } from '../src/routes.js';
import { readSourceFile, writeSourceFile } from '../src/file-io.js';

let handler;
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(definition) {
          handler = definition.handler;
          return () => {};
        },
      };
    }
    if (name === 'connection') return { admit: () => ({ peer: {} }) };
    return undefined;
  },
  logger() {
    return { info() {}, warn() {}, error() {} };
  },
};

const service = {
  readSourceFile: (target) => readSourceFile(target),
  writeSourceFile: (target, content, revision) =>
    writeSourceFile(target, content, { expectedRevision: revision }),
  compilePath: async ({ path: target }) => ({
    project: {
      id: 'p_test',
      paths: { previewPath: path.join(path.dirname(target), 'preview.pdf') },
      previewVersion: 42,
      previewPages: 1,
    },
    result: {
      status: 'success',
      projectId: 'p_test',
      engine: 'xelatex',
      durationMs: 10,
      durationText: '10 ms',
      exitCode: 0,
      pages: 1,
      previewVersion: 42,
      pdfPath: path.join(path.dirname(target), 'main.pdf'),
      previewPath: path.join(path.dirname(target), 'preview.pdf'),
      diagnostics: { counts: { errors: 0, warnings: 0 }, errors: [], warnings: [] },
    },
  }),
  snapshot: () => ({ projects: [] }),
  getProject: () => undefined,
  health: async () => ({ ok: true }),
};
registerLatexRoutes(ctx, service, {});

class Request extends EventEmitter {
  constructor(method, url, headers = {}, body = undefined) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }
}

function invoke(request) {
  return new Promise((resolve) => {
    const response = {
      status: 0,
      headers: {},
      payload: '',
      destroyed: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(payload) {
        this.payload = payload ?? '';
        this.writableEnded = true;
        resolve(this);
      },
    };
    const started = handler(request, response);
    if (request.body !== undefined) {
      setImmediate(() => {
        request.emit('data', Buffer.from(request.body));
        request.emit('end');
      });
    }
    Promise.resolve(started).catch((error) => {
      response.status = 500;
      response.payload = String(error);
      resolve(response);
    });
  });
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-latex-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('file routes read, save, and report revision conflicts', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'main.tex');
  await writeFile(file, '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n');

  const read = await invoke(new Request('GET', `/latex/file?path=${encodeURIComponent(file)}`));
  assert.equal(read.status, 200);
  const first = JSON.parse(read.payload).file;
  assert.equal(first.content.includes('A'), true);

  const body = JSON.stringify({
    path: file,
    content: '\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n',
    expectedRevision: first.revision,
  });
  const saved = await invoke(
    new Request('POST', '/latex/file', { 'content-type': 'application/json' }, body),
  );
  assert.equal(saved.status, 200);
  assert.equal((await readFile(file, 'utf8')).includes('B'), true);

  const stale = JSON.stringify({
    path: file,
    content: 'stale',
    expectedRevision: first.revision,
  });
  const conflict = await invoke(
    new Request('POST', '/latex/file', { 'content-type': 'application/json' }, stale),
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.payload, /changed on disk/);
});

test('compile-file resolves by path and returns a compact result', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'main.tex');
  await writeFile(file, '\\documentclass{article}\n');
  const body = JSON.stringify({ action: 'compile-file', path: file });
  const response = await invoke(
    new Request('POST', '/latex/action', { 'content-type': 'application/json' }, body),
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.payload);
  assert.equal(payload.ok, true);
  assert.equal(payload.projectId, 'p_test');
  assert.equal(payload.result.status, 'success');
});

test('file routes reject non-.tex paths and missing files', async (t) => {
  const dir = await tempDir(t);
  const text = path.join(dir, 'notes.txt');
  await writeFile(text, 'not tex');
  const nonTex = await invoke(new Request('GET', `/latex/file?path=${encodeURIComponent(text)}`));
  assert.equal(nonTex.status, 400);
  const missing = await invoke(
    new Request('GET', `/latex/file?path=${encodeURIComponent(path.join(dir, 'missing.tex'))}`),
  );
  assert.equal(missing.status, 404);
});
