import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'public/vendor/ocr');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const runtime = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js', '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js', 'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js', 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js', '861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3'],
];
// Pin the trained data as well as the JS package. Only this build step downloads
// model files; installed applications read the bundled copies without a CDN.
const languages = {
  eng: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  jpn: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88',
  chi_sim: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
  chi_tra: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743',
  kor: '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126',
  tha: '4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74',
  rus: 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a',
  por: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c',
  spa: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb',
};

for (const name of ['tesseract.js', 'tesseract.js-core']) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (metadata.version !== '7.0.0') throw new Error(`OCR assets require ${name} 7.0.0; found ${metadata.version}.`);
}
for (const [source, target, expected] of runtime) {
  const bytes = await fs.readFile(path.join(root, 'node_modules', source));
  if (sha256(bytes) !== expected) throw new Error(`OCR runtime integrity check failed: ${source}`);
  const output = path.join(destination, target);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes);
}
await fs.mkdir(path.join(destination, 'langs'), { recursive: true });
const modelCache = path.join(root, 'node_modules/.cache/kobo-ocr-models');
await fs.mkdir(modelCache, { recursive: true });
const modelManifest = {};
for (const [language, expected] of Object.entries(languages)) {
  const cached = path.join(modelCache, `${language}.traineddata.gz`);
  const previousPublicGzip = path.join(destination, 'langs', `${language}.traineddata.gz`);
  let bytes;
  // Migrate previously prepared gzip assets into a non-public build cache. AAPT
  // expands .gz and strips its suffix, so serving that name from an APK fails.
  for (const candidate of [cached, previousPublicGzip]) {
    try { const value = await fs.readFile(candidate); if (sha256(value) === expected) { bytes = value; break; } } catch { /* Cache not prepared yet. */ }
  }
  if (!bytes) {
    const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}@1.0.0/4.0.0_best_int/${language}.traineddata.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download pinned OCR model ${language}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error(`OCR model integrity check failed: ${language}`);
  }
  await fs.writeFile(cached, bytes);
  const raw = gunzipSync(bytes), rawHash = sha256(raw);
  const output = path.join(destination, 'langs', `${language}.traineddata`);
  let matches = false;
  try { matches = sha256(await fs.readFile(output)) === rawHash; } catch { /* First raw asset build. */ }
  if (!matches) await fs.writeFile(output, raw);
  modelManifest[language] = { bytes: raw.length, sha256: rawHash };
  // Remove only these known generated files, avoiding duplicate AAPT outputs.
  await fs.unlink(previousPublicGzip).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ version: '7.0.0', gzip: false, models: modelManifest }, null, 2));
await fs.copyFile(path.join(root, 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt'), path.join(destination, 'worker.min.js.LICENSE.txt'));
const licenceDirectory = path.join(root, 'public/vendor/licenses');
await fs.mkdir(licenceDirectory, { recursive: true });
const licence = await fs.readFile(path.join(root, 'node_modules/tesseract.js-core/LICENSE'), 'utf8');
await fs.writeFile(path.join(licenceDirectory, 'tesseract-traineddata-Apache-2.0.txt'), 'Tesseract language trained data bundled for offline OCR.\nModels: @tesseract.js-data/{eng,jpn,chi_sim,chi_tra,kor,tha,rus,por,spa} 1.0.0, 4.0.0_best_int.\nSources: https://github.com/naptha/tessdata and https://github.com/tesseract-ocr/tessdata_best\n\n' + licence.trimEnd() + '\n');
