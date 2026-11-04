import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSourceFile, writeSourceFile } from '../src/file-io.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-latex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('reads and atomically writes .tex while preserving BOM and CRLF', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'main.tex');
  const original = '\uFEFF\\documentclass{article}\r\n\\begin{document}\r\nOld\r\n\\end{document}\r\n';
  await writeFile(file, original, 'utf8');

  const read = await readSourceFile(file);
  assert.equal(read.eol, 'crlf');
  assert.equal(read.bom, true);
  assert.equal(read.content.includes('Old'), true);
  assert.match(read.revision, /^[a-f0-9]{64}$/);

  const written = await writeSourceFile(
    file,
    read.content.replace('Old', 'New'),
    { expectedRevision: read.revision },
  );
  assert.equal(written.eol, 'crlf');
  assert.equal(written.bom, true);
  const raw = await readFile(file);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(raw.toString('utf8').includes('\r\n'), true);
  assert.equal((await readFile(file, 'utf8')).includes('New'), true);
});

test('rejects a stale revision instead of overwriting an external edit', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'main.tex');
  await writeFile(file, '\\documentclass{article}\n');
  const read = await readSourceFile(file);
  await writeFile(file, '\\documentclass{article}\n% external\n');
  await assert.rejects(
    () => writeSourceFile(file, 'replacement', { expectedRevision: read.revision }),
    (error) => error.status === 409,
  );
  assert.equal((await readFile(file, 'utf8')).includes('% external'), true);
});

test('only existing .tex files are editable', async (t) => {
  const dir = await tempDir(t);
  const missing = path.join(dir, 'missing.tex');
  const text = path.join(dir, 'notes.txt');
  await writeFile(text, 'not tex');
  await assert.rejects(() => readSourceFile(missing), (error) => error.status === 404);
  await assert.rejects(() => readSourceFile(text), (error) => error.status === 400);
  await assert.rejects(() => readSourceFile('relative.tex'), (error) => error.status === 400);
  await assert.rejects(
    () => readSourceFile('\\\\server\\share\\main.tex'),
    (error) => error.status === 400,
  );
});
