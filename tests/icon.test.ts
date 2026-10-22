// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';

async function decodePNG(file: string) {
  const bytes = await readFile(file);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render();
}

it('preserves pixel-art shading in the themed alpha mask and colours in the default icon', async () => {
  const rendered = await decodePNG('android/app/src/main/res/drawable-nodpi/ic_kobo_monochrome.png');
  const pixels = rendered.pixels;
  const levels = new Set<number>();
  for (let index = 0; index < pixels.length; index += 4) {
    levels.add(pixels[index + 3]);
    // Only transparency carries details; the launcher supplies the actual colour.
    expect(pixels[index]).toBe(pixels[index + 1]);
    expect(pixels[index]).toBe(pixels[index + 2]);
  }
  expect(pixels[3]).toBe(0);
  expect(levels.size).toBeGreaterThan(100); // A flat silhouette loses the artwork.
  const coloured = (await decodePNG('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png')).pixels;
  let colourPixels = 0;
  for (let index = 0; index < coloured.length; index += 4) {
    if (coloured[index + 3] > 128 && Math.max(...coloured.subarray(index, index + 3)) - Math.min(...coloured.subarray(index, index + 3)) > 30) colourPixels++;
  }
  expect(colourPixels).toBeGreaterThan(1000);
  for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const launcher = await readFile('android/app/src/main/res/mipmap-anydpi-v26/' + file, 'utf8');
    expect(launcher).toContain('<foreground android:drawable="@mipmap/ic_launcher_foreground"');
    expect(launcher).toContain('<monochrome android:drawable="@drawable/ic_kobo_monochrome"');
  }
});
