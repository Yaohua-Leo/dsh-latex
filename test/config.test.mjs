import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('editor auto-save defaults are on and bounded', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.editorAutoSave, true);
  assert.equal(defaults.editorAutoSaveDelayMs, 900);
  assert.equal(defaults.texBinDir, '');

  const disabled = normalizeConfig({ editorAutoSave: false, editorAutoSaveDelayMs: 1 });
  assert.equal(disabled.editorAutoSave, false);
  assert.equal(disabled.editorAutoSaveDelayMs, 300);

  const slow = normalizeConfig({ editorAutoSaveDelayMs: 60_000 });
  assert.equal(slow.editorAutoSaveDelayMs, 10_000);
});
