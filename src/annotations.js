/**
 * Durable PDF annotations created from the preview's text selection.
 *
 * Annotations are project state, not build output: they live next to the
 * published preview in `<buildDir>/.dsh-latex/` and survive a Host restart.
 * Each item remembers the preview version it was anchored against, so a later
 * rebuild can either re-anchor it by its quote or mark it stale — a silently
 * mis-positioned highlight is worse than an honest "stale" label.
 *
 * Writes are serialized per file and atomic; reads are bounded by
 * `annotationsMaxBytes`.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, open, readFile, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteText, delay, isInside } from './util.js';

const SCHEMA = 1;
const MAX_QUOTE = 4000;
const MAX_COMMENT = 4000;
const MAX_RECTS = 20;
const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_MAX_BYTES = 256 * 1024;
const IMAGE_NAME_RE = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/;

/** Directory holding screenshot files for one project. */
export function annotationImageDir(project) {
  return path.join(project.paths.stateDir, 'annotation-images');
}

/** Resolve a stored image filename inside the project's annotation directory. */
export function annotationImagePath(project, filename) {
  if (typeof filename !== 'string' || !IMAGE_NAME_RE.test(filename)) return undefined;
  const target = path.join(annotationImageDir(project), filename);
  return isInside(project.paths.stateDir, target) ? target : undefined;
}

export class AnnotationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AnnotationError';
    this.code = code;
    this.status = status;
  }
}

function clampText(value, max, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AnnotationError('BAD_INPUT', `${name} must be a string`);
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length > max) {
    throw new AnnotationError('BAD_INPUT', `${name} is too long (max ${max} characters)`);
  }
  return trimmed;
}

function normalizeRects(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AnnotationError('BAD_INPUT', 'rects must be an array');
  if (value.length > MAX_RECTS) throw new AnnotationError('BAD_INPUT', `rects is limited to ${MAX_RECTS} rectangles`);
  const rects = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const x = Number(entry.x);
    const y = Number(entry.y);
    const w = Number(entry.w);
    const h = Number(entry.h);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (x < 0 || y < 0 || x > 1 || y > 1) continue;
    rects.push({
      x: Math.min(1, x),
      y: Math.min(1, y),
      w: Math.max(0, Math.min(1 - x, w)),
      h: Math.max(0, Math.min(1 - y, h)),
    });
  }
  return rects;
}

function annotationId() {
  return `a${randomBytes(6).toString('hex')}`;
}

function isSafeId(value) {
  return typeof value === 'string' && /^a[0-9a-f]{12}$/.test(value);
}

export class AnnotationStore {
  constructor(config = {}) {
    this.maxItems = Math.max(1, Math.min(2000, Number(config.annotationsMaxItems) || DEFAULT_MAX_ITEMS));
    this.maxBytes = Math.max(
      16 * 1024,
      Math.min(8 * 1024 * 1024, Number(config.annotationsMaxBytes) || DEFAULT_MAX_BYTES),
    );
    this.lockWaitMs = Math.max(200, Math.min(60_000, Number(config.annotationsLockWaitMs) || 5_000));
    this.lockStaleMs = Math.max(1_000, Math.min(300_000, Number(config.annotationsLockStaleMs) || 15_000));
    /** Serialize read-modify-write cycles per annotations file. */
    this.queues = new Map();
  }

  /** Absolute path of one project's annotation file. */
  fileFor(project) {
    if (!project?.paths?.stateDir) throw new AnnotationError('BAD_PROJECT', 'project has no state directory', 500);
    const fingerprint = String(project.paths.fingerprint ?? project.id ?? 'default');
    return path.join(project.paths.stateDir, `annotations-${fingerprint}.json`);
  }

  async #withLock(file, task) {
    const previous = this.queues.get(file) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slot = previous.then(() => gate);
    this.queues.set(file, slot);
    await previous.catch(() => {});
    let releaseFile = async () => {};
    try {
      releaseFile = await this.#acquireFileLock(file);
      return await task();
    } finally {
      await releaseFile();
      release();
      if (this.queues.get(file) === slot) this.queues.delete(file);
    }
  }

  /**
   * Cross-process advisory lock for one annotations file.
   *
   * Two DSH processes (desktop + a web server) can point at the same project.
   * The in-process queue is not enough there: O_EXCL creation serializes the
   * read-modify-write cycle, a stale lock left by a crashed process is reclaimed
   * after `lockStaleMs`, and a waiter gives up with a retryable 503 instead of
   * corrupting the file.
   */
  async #acquireFileLock(file) {
    const lock = `${file}.lock`;
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(lock, 'wx');
        await handle.writeFile(`${process.pid} ${Date.now()}`, 'utf8');
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await handle.close().catch(() => {});
          await unlink(lock).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const info = await stat(lock).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > this.lockStaleMs) {
          await unlink(lock).catch(() => {});
          continue;
        }
        if (Date.now() - started > this.lockWaitMs) {
          throw new AnnotationError(
            'ANNOTATIONS_BUSY',
            'another process is writing this project’s annotations; retry in a moment',
            503,
          );
        }
        await delay(40);
      }
    }
  }

  /** Read the store; a missing/corrupt file is an empty store, never a crash. */
  async read(project) {
    const file = this.fileFor(project);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      return { schema: SCHEMA, mainFile: project?.mainFile, items: [], file };
    }
    if (info.size > this.maxBytes) {
      throw new AnnotationError(
        'ANNOTATIONS_TOO_LARGE',
        `annotations file is ${info.size} bytes (limit ${this.maxBytes}); clear resolved annotations first`,
        413,
      );
    }
    const raw = await readFile(file, 'utf8').catch(() => '');
    if (raw.trim() === '') return { schema: SCHEMA, mainFile: project?.mainFile, items: [], file };
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items.filter((item) => item && typeof item === 'object') : [];
      return {
        schema: SCHEMA,
        mainFile: typeof parsed?.mainFile === 'string' ? parsed.mainFile : project?.mainFile,
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
        items: items.slice(0, this.maxItems),
        file,
      };
    } catch {
      // A corrupt file must not make the preview unusable. Keep a sibling copy
      // for inspection before returning an empty store.
      const backup = `${file}.corrupt-${Date.now()}`;
      await copyFile(file, backup).catch(() => {});
      return { schema: SCHEMA, mainFile: project?.mainFile, items: [], file, corrupt: true, backup };
    }
  }

  async #write(project, store) {
    const file = this.fileFor(project);
    const items = store.items.slice(0, this.maxItems);
    const payload = JSON.stringify(
      {
        schema: SCHEMA,
        mainFile: project?.mainFile,
        updatedAt: new Date().toISOString(),
        items,
      },
      null,
      2,
    );
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) {
      throw new AnnotationError(
        'ANNOTATIONS_TOO_LARGE',
        `annotations would exceed ${this.maxBytes} bytes; clear resolved annotations first`,
        413,
      );
    }
    await atomicWriteText(file, `${payload}\n`);
    return { ...store, items, file };
  }

  /**
   * List annotations, optionally re-anchoring items whose build version is old.
   *
   * @param {object} project
   * @param {{ buildVersion?: number, reanchor?: (input: { quote: string, page: number }) => Promise<{ page?: number, box?: object } | undefined> }} [options]
   */
  async list(project, options = {}) {
    const store = await this.read(project);
    const buildVersion = Number(options.buildVersion) || 0;
    let changed = Boolean(store.corrupt);
    for (const item of store.items) {
      const itemVersion = Number(item.buildVersion) || 0;
      if (item.status === 'resolved') continue;
      if (buildVersion <= 0 || itemVersion === buildVersion) continue;
      // A screenshot-only annotation has no text to anchor against; keep its
      // normalized page rectangle and be explicit that the position is
      // best-effort rather than silently moving or expiring it.
      if (item.anchor === 'image' && !item.quote) {
        item.buildVersion = buildVersion;
        item.reanchorNote = 'screenshot annotation: position is best-effort after a rebuild';
        item.reanchoredAt = new Date().toISOString();
        changed = true;
        continue;
      }
      item.reanchoredFrom = item.page;
      let located;
      try {
        located = options.reanchor
          ? await options.reanchor({ quote: String(item.quote ?? ''), page: Number(item.page) || 1 })
          : undefined;
      } catch {
        located = undefined;
      }
      if (located?.page) item.page = Number(located.page);
      if (Array.isArray(located?.rects) && located.rects.length > 0) {
        item.rects = normalizeRects(located.rects);
        item.anchor = 'text';
      }
      item.buildVersion = buildVersion;
      item.status = located ? 'open' : 'stale';
      item.staleReason = located
        ? undefined
        : 'the quote was not found after the rebuild; re-check or delete this annotation';
      item.reanchoredAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await this.#withLock(this.fileFor(project), () => this.#write(project, store));
    return this.#present(project, store, buildVersion);
  }

  async create(project, input = {}) {
    const page = Math.round(Number(input.page));
    if (!Number.isFinite(page) || page < 1) throw new AnnotationError('BAD_INPUT', 'page must be a positive integer');
    const quote = clampText(input.quote, MAX_QUOTE, 'quote');
    const image =
      typeof input.image === 'string' && IMAGE_NAME_RE.test(input.image) ? input.image : undefined;
    if (quote.length < 1 && !image) {
      throw new AnnotationError('BAD_INPUT', 'quote is required unless a screenshot is attached');
    }
    if (input.image !== undefined && image === undefined) {
      throw new AnnotationError('BAD_INPUT', 'image must be a server-generated .png/.jpg/.webp filename');
    }
    const comment = clampText(input.comment, MAX_COMMENT, 'comment');
    const ocrText = clampText(input.ocrText, MAX_QUOTE, 'ocrText');
    const rects = normalizeRects(input.rects);
    return this.#withLock(this.fileFor(project), async () => {
      const store = await this.read(project);
      if (store.items.length >= this.maxItems) {
        throw new AnnotationError(
          'ANNOTATIONS_LIMIT',
          `this project already has ${this.maxItems} annotations; resolve and clear some first`,
          413,
        );
      }
      const item = {
        id: annotationId(),
        page: Math.min(100_000, page),
        quote,
        comment,
        ocrText: ocrText || undefined,
        image,
        rects,
        anchor: image ? (quote ? 'text+image' : 'image') : rects.length > 0 ? 'rect' : 'text',
        status: 'open',
        buildVersion: Number(project.previewVersion) || 0,
        createdAt: new Date().toISOString(),
      };
      store.items.push(item);
      await this.#write(project, store);
      return item;
    });
  }

  async update(project, input = {}) {
    const id = input.id;
    if (!isSafeId(id)) throw new AnnotationError('BAD_INPUT', 'id is invalid');
    const status = input.status;
    if (status !== undefined && status !== 'open' && status !== 'resolved') {
      throw new AnnotationError('BAD_INPUT', "status must be 'open' or 'resolved'");
    }
    const comment = input.comment === undefined ? undefined : clampText(input.comment, MAX_COMMENT, 'comment');
    return this.#withLock(this.fileFor(project), async () => {
      const store = await this.read(project);
      const item = store.items.find((entry) => entry.id === id);
      if (!item) throw new AnnotationError('NOT_FOUND', `annotation ${id} was not found`, 404);
      if (status !== undefined) {
        item.status = status;
        item.resolvedAt = status === 'resolved' ? new Date().toISOString() : undefined;
        if (status === 'open') item.staleReason = undefined;
      }
      if (comment !== undefined) item.comment = comment;
      item.updatedAt = new Date().toISOString();
      await this.#write(project, store);
      return item;
    });
  }

  /**
   * Remove resolved annotations (default) or every annotation (`all: true`).
   * @returns {Promise<{ removed: number, remaining: number }>}
   */
  /** Remove one annotation and its screenshot file. */
  async remove(project, id) {
    if (!isSafeId(id)) throw new AnnotationError('BAD_INPUT', 'id is invalid');
    return this.#withLock(this.fileFor(project), async () => {
      const store = await this.read(project);
      const index = store.items.findIndex((entry) => entry.id === id);
      if (index < 0) throw new AnnotationError('NOT_FOUND', `annotation ${id} was not found`, 404);
      const [item] = store.items.splice(index, 1);
      await this.#write(project, store);
      await this.#removeImages(project, [item]);
      return { removed: 1, remaining: store.items.length };
    });
  }

  /** Remove screenshot files referenced by annotations that are being dropped. */
  async #removeImages(project, items) {
    for (const item of items ?? []) {
      const target = annotationImagePath(project, item?.image);
      if (target) await rm(target, { force: true }).catch(() => {});
    }
  }

  async clear(project, options = {}) {
    return this.#withLock(this.fileFor(project), async () => {
      const store = await this.read(project);
      const before = store.items.length;
      if (options.all === true) {
        const removed = store.items;
        store.items = [];
        await this.#write(project, store);
        await rm(this.fileFor(project), { force: true }).catch(() => {});
        await this.#removeImages(project, removed);
        return { removed: before, remaining: 0 };
      }
      const removed = store.items.filter((item) => item.status === 'resolved');
      store.items = store.items.filter((item) => item.status !== 'resolved');
      await this.#write(project, store);
      await this.#removeImages(project, removed);
      return { removed: removed.length, remaining: store.items.length };
    });
  }

  async count(project) {
    try {
      const store = await this.read(project);
      return {
        total: store.items.length,
        open: store.items.filter((item) => item.status === 'open').length,
        stale: store.items.filter((item) => item.status === 'stale').length,
      };
    } catch {
      return { total: 0, open: 0, stale: 0 };
    }
  }

  #present(project, store, buildVersion) {
    const items = store.items;
    return {
      ok: true,
      projectId: project.id,
      mainFile: project.mainFile,
      buildVersion,
      file: store.file,
      corrupt: Boolean(store.corrupt),
      counts: {
        total: items.length,
        open: items.filter((item) => item.status === 'open').length,
        resolved: items.filter((item) => item.status === 'resolved').length,
        stale: items.filter((item) => item.status === 'stale').length,
      },
      items,
    };
  }
}

/** Public bounds, re-exported for tool descriptions and docs. */
export const ANNOTATION_LIMITS = Object.freeze({
  quote: MAX_QUOTE,
  comment: MAX_COMMENT,
  rects: MAX_RECTS,
  defaultMaxItems: DEFAULT_MAX_ITEMS,
  defaultMaxBytes: DEFAULT_MAX_BYTES,
});
