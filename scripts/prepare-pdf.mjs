import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// PDF.js must work offline inside the APK, including CJK fonts and image decoders.
const destination = path.join(root, 'public/vendor/pdfjs');
await mkdir(destination, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(path.join(root, 'node_modules/pdfjs-dist', directory), path.join(destination, directory), { recursive: true });
}
