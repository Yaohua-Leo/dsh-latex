import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
process.exit(failed ? 1 : 0);
