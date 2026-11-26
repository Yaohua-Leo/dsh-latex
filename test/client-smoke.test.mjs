import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A React stand-in: only the members the client half touches at load time. */
function fakeReact() {
  const hooks = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    memo: (component) => component,
  };
  return { ...hooks, useEffect: hooks.useEffect, default: hooks };
}

test('client.js evaluates and hands the loader a factory', () => {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  const records = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (record) => records.push(record),
      },
    },
    document: { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'client.js' }).runInContext(context);

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.id, '@yaohualiu/dsh-latex');
  assert.equal(typeof record.factory, 'function');
  const exported = record.factory((spec) => {
    if (spec === 'react') return fakeReact();
    throw new Error(`unexpected module request: ${spec}`);
  });
  assert.ok(exported);
  assert.ok(Array.isArray(exported.inject));
  assert.equal(typeof exported.apply, 'function');
});
