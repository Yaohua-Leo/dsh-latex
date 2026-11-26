/**
 * Client-half registration guard.
 *
 * The Harness client module graph keys every plugin entry by the npm package it
 * resolves to (`ClientModuleRegistry` → `graphRow(packageName, …)`), while the
 * bundle itself announces its identity through
 * `window.__ModuleLoader__.load({ id, factory })`. When the two disagree the
 * entry never counts as arrived: the loader falls back to the one-resource
 * `/plugins/<pkg>/client.js` URL, executes the bundle a second time, and
 * `register()` throws `duplicate factory registration`. The whole entry then
 * fails to activate — the browser half silently disappears while the Host half
 * keeps working, which is expensive to diagnose from the outside.
 *
 * Keeping the two values in lockstep is therefore a build-time invariant, not a
 * style preference. `scripts/check.mjs` enforces it and
 * `test/client-registration.test.mjs` covers both the passing and the failing
 * shapes.
 */

/**
 * Whitespace and comments allowed between `load({` and the `id` property, so a
 * commented registration (the shape this repo uses) still reads cleanly. Only
 * trivia is permitted, so a bundle that forgot its root `id` cannot be rescued
 * by an unrelated nested `id:` further down.
 */
const GAP = String.raw`(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*`;

/** Matches the `id` of the root `window.__ModuleLoader__.load({ … })` call. */
const CLIENT_LOAD_ID = new RegExp(
  String.raw`__ModuleLoader__\s*\.\s*load\s*\(\s*\{` + GAP + String.raw`id\s*:\s*(['"])([^'"]+)\1`,
);

/**
 * Read the registration id declared by a client bundle.
 *
 * @param {string} source - `client.js` contents.
 * @returns {string | undefined} the declared id, or undefined when the bundle
 *   does not open with a `window.__ModuleLoader__.load({ id, … })` call.
 */
export function readClientLoadId(source) {
  return CLIENT_LOAD_ID.exec(source)?.[2];
}

/**
 * Compare a client bundle's registration id against its package name.
 *
 * @param {{ packageName: string, source: string }} input
 * @returns {{ ok: boolean, expected: string, actual: string | undefined, reason?: string }}
 */
export function checkClientLoadId({ packageName, source }) {
  const actual = readClientLoadId(source);
  const expected = packageName;
  if (actual === undefined) {
    return {
      ok: false,
      expected,
      actual,
      reason:
        'client.js does not call window.__ModuleLoader__.load({ id, factory }) at the top level',
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      expected,
      actual,
      reason:
        `client.js registers as "${actual}" but the package is "${expected}"; ` +
        'the entry will never arrive, the bundle will execute twice and the ' +
        'duplicate-factory guard will kill the whole client half',
    };
  }
  return { ok: true, expected, actual };
}
