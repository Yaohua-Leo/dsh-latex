import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResult } from '../src/tools.js';

function result(overrides = {}) {
  return {
    status: 'success',
    rootDir: 'D:/project',
    mainFile: 'D:/project/main.tex',
    engine: 'xelatex',
    durationText: '1.2 s',
    exitCode: 0,
    pdfPath: 'D:/project/build/main.pdf',
    previewPath: 'D:/project/build/.dsh-latex/preview.pdf',
    previewVersion: 42,
    diagnostics: { counts: { errors: 0, warnings: 0 }, errors: [], warnings: [] },
    ...overrides,
  };
}

test('success output keeps the pdf and preview lines', () => {
  const text = formatResult(result());
  assert.match(text, /^pdf: D:\/project\/build\/main\.pdf/m);
  assert.match(text, /^preview: /m);
});

for (const status of ['failure', 'timeout', 'cancelled']) {
  test(`${status} output never prints a stale pdf line`, () => {
    const text = formatResult(result({ status, pdfPath: 'D:/project/build/main.pdf' }));
    assert.equal(text.includes('pdf:'), false);
    assert.match(text, /^diagnostics: /m);
  });
}
