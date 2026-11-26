import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultOcrInstallDir, parseRunnerOutput } from '../src/rapidocr.js';

test('parseRunnerOutput reads one RapidOCR JSON result', () => {
  const parsed = parseRunnerOutput(
    [
      'downloading model...',
      JSON.stringify({ ok: true, text: '你好\nHello', lines: [{ text: '你好' }, { text: 'Hello' }] }),
    ].join('\n'),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, '你好\nHello');
  assert.equal(parsed.lines.length, 2);
});

test('parseRunnerOutput returns data for an OCR error and ignores noise', () => {
  const failed = parseRunnerOutput(`${JSON.stringify({ ok: false, error: 'model missing' })}\n`);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /model missing/);
  assert.equal(parseRunnerOutput('no json here').ok, false);
});

test('defaultOcrInstallDir follows config and falls back to the user directory', () => {
  assert.equal(defaultOcrInstallDir({ ocrInstallDir: 'D:/dsh-tmp/ocr-test' }), path.resolve('D:/dsh-tmp/ocr-test'));
  const fallback = defaultOcrInstallDir({});
  assert.ok(fallback.endsWith(path.join('.dsh-latex', 'ocr')));
});
