import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientLoadId, readClientLoadId } from '../scripts/client-id.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('readClientLoadId reads the id of the root load call', () => {
  const source = [
    '/** bundle */',
    'window.__ModuleLoader__.load({',
    "  id: '@acme/dsh-thing',",
    '  factory(require) { return {}; },',
    '});',
  ].join('\n');
  assert.equal(readClientLoadId(source), '@acme/dsh-thing');
  assert.equal(
    readClientLoadId('window.__ModuleLoader__.load({ id: "dsh-thing", factory() {} });'),
    'dsh-thing',
  );
});

test('readClientLoadId returns undefined without a module loader call', () => {
  assert.equal(readClientLoadId('export default 1;'), undefined);
  assert.equal(readClientLoadId('window.__ModuleLoader__.register({ id: "x" });'), undefined);
});

test('checkClientLoadId accepts a bundle that registers under the package name', () => {
  const result = checkClientLoadId({
    packageName: '@acme/dsh-thing',
    source: "window.__ModuleLoader__.load({ id: '@acme/dsh-thing', factory() {} });",
  });
  assert.deepEqual(result, { ok: true, expected: '@acme/dsh-thing', actual: '@acme/dsh-thing' });
});

test('checkClientLoadId rejects an unscoped id for a scoped package', () => {
  // The exact regression this guard exists for: the id looked fine locally but
  // the module graph keys entries by the full package name.
  const result = checkClientLoadId({
    packageName: '@yaohualiu/dsh-latex',
    source: "window.__ModuleLoader__.load({ id: 'dsh-latex', factory() {} });",
  });
  assert.equal(result.ok, false);
  assert.equal(result.actual, 'dsh-latex');
  assert.equal(result.expected, '@yaohualiu/dsh-latex');
  assert.match(result.reason, /duplicate-factory/);
});

test('checkClientLoadId rejects a bundle without a registration call', () => {
  const result = checkClientLoadId({ packageName: 'dsh-thing', source: '/* empty */' });
  assert.equal(result.ok, false);
  assert.equal(result.actual, undefined);
  assert.match(result.reason, /does not call window\.__ModuleLoader__\.load/);
});

test('the shipped client half registers under the packaged name', () => {
  const { name } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.deepEqual(checkClientLoadId({ packageName: name, source }), {
    ok: true,
    expected: name,
    actual: name,
  });
});
