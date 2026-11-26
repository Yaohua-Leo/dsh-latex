import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientLoadId } from './client-id.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index.js', 'client.js'];
for (const name of readdirSync(path.join(root, 'src'))) {
  if (name.endsWith('.js')) files.push(path.join('src', name));
}

let failed = false;
for (const file of files) {
  process.stdout.write(`check ${file}\n`);
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

// The client half must register under the npm package name, or the Harness
// client module graph never marks the entry as arrived (see scripts/client-id.mjs).
process.stdout.write('check client.js registration id === package name\n');
const { name: packageName } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const clientSource = readFileSync(path.join(root, 'client.js'), 'utf8');
const id = checkClientLoadId({ packageName, source: clientSource });
if (id.ok) {
  process.stdout.write(`  ok: ${id.actual}\n`);
} else {
  process.stderr.write(`  fail: ${id.reason}\n`);
  failed = true;
}

process.exit(failed ? 1 : 0);
