import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const seen = new Set();
const notices = ['Kobo Book Manager — third-party software notices\n\nThe app uses kepubify v4.0.4 by Patrick Gaskin (MIT). Its Go/WASM runtime and library notices are included below. Calibre and send2ereader were research references; their source code is not bundled in this app.\n'];
async function collect(name, parent = root) {
  let directory = parent;
  let location;
  while (true) {
    const candidate = path.join(directory, 'node_modules', name);
    try { await fs.access(path.join(candidate, 'package.json')); location = candidate; break; } catch {}
    const up = path.dirname(directory); if (up === directory) throw new Error('Dependency not found: ' + name); directory = up;
  }
  if (seen.has(location)) return;
  seen.add(location);
  const meta = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
  notices.push(`\n\n===== ${meta.name} ${meta.version} (${meta.license ?? 'see package'}) =====\n`);
  const files = (await fs.readdir(location)).filter(x => /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(x));
  for (const file of files) notices.push(await fs.readFile(path.join(location, file), 'utf8'));
  for (const dependency of Object.keys(meta.dependencies ?? {})) await collect(dependency, location);
}
for (const name of Object.keys(pkg.dependencies)) await collect(name);
const licenseDirectory = path.join(root, 'public/vendor/licenses');
for (const file of await fs.readdir(licenseDirectory)) notices.push(`\n\n===== ${file} =====\n` + await fs.readFile(path.join(licenseDirectory, file), 'utf8'));
await fs.writeFile(path.join(root, 'public/vendor/THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
