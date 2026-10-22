import fs from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// Regenerate platform sizes from the approved pixel-art master. No network calls.
const root = path.resolve(import.meta.dirname, '..');
const master = await fs.readFile(path.join(root, 'resources/icon.png'));
const width = master.readUInt32BE(16), height = master.readUInt32BE(20);
const uri = `data:image/png;base64,${master.toString('base64')}`;
const image = `<image width="${width}" height="${height}" href="${uri}"/>`;
const decode = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${image}</svg>`, { font: { loadSystemFonts: false } }).render();
const pixels = decode.pixels;
let left = width, top = height, right = 0, bottom = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if (pixels[(y * width + x) * 4 + 3] < 8) continue;
  left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
}
if (left >= right || top >= bottom) throw new Error('Icon has no visible artwork');
const artWidth = right - left, artHeight = bottom - top;
// A 56dp bounding box keeps the entire bookshelf inside circular adaptive masks.
const compose = (shape = '', extent = 56, monochrome = false) => {
  const scale = extent / Math.max(artWidth, artHeight);
  const x = (108 - artWidth * scale) / 2 - left * scale;
  const y = (108 - artHeight * scale) / 2 - top * scale;
  // Android ignores a themed icon's RGB and uses its alpha as the tint mask.
  // Encode the original pixel art's shading in alpha instead of flattening it.
  const filter = monochrome ? '<defs><filter id="detail" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.28701 0.96552 0.09747 0 -0.10" result="tone"/><feComposite in="tone" in2="SourceGraphic" operator="in"/></filter></defs>' : '';
  const artwork = `<g transform="translate(${x} ${y}) scale(${scale})">${image}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">${filter}${shape}${monochrome ? `<g filter="url(#detail)">${artwork}</g>` : artwork}</svg>`;
};
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size }, imageRendering: 1, font: { loadSystemFonts: false } }).render().asPng();
const res = path.join(root, 'android/app/src/main/res');
for (const [density, factor] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  const folder = path.join(res, `mipmap-${density}`);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'ic_launcher.png'), render(compose('<rect width="108" height="108" rx="22" fill="#2D4539"/>', 78), 48 * factor));
  await fs.writeFile(path.join(folder, 'ic_launcher_round.png'), render(compose('<circle cx="54" cy="54" r="54" fill="#2D4539"/>', 78), 48 * factor));
  await fs.writeFile(path.join(folder, 'ic_launcher_foreground.png'), render(compose(), 108 * factor));
}
const drawables = path.join(res, 'drawable-nodpi');
await fs.mkdir(drawables, { recursive: true });
await fs.writeFile(path.join(drawables, 'ic_kobo_splash.png'), render(compose(), 432));
await fs.writeFile(path.join(drawables, 'ic_kobo_monochrome.png'), render(compose('', 56, true), 432));
await fs.writeFile(path.join(root, 'public/icon.png'), render(compose('<rect width="108" height="108" rx="22" fill="#2D4539"/>', 78), 512));
console.log(`Generated launcher, themed, splash and web icons. Master bounds: ${artWidth}x${artHeight}; corner alpha: ${pixels[3]}.`);
