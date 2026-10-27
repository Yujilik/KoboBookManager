// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PdfOcrResult, PdfOcrWord } from '../src/pdf-ocr';
import { originalInitialWords } from '../src/pdf-ocr-initials';

const word = (text: string, x: number, y: number, width: number): PdfOcrWord => ({ text, confidence: 90, bbox: { x0: x, y0: y, x1: x + width, y1: y + 25 } });
const makeCanvas = (width = 1, height = 1) => {
  const canvas = createCanvas(width, height);
  return Object.assign(canvas, { toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array(canvas.encodeSync('png'))], { type: 'image/png' })) });
};
beforeEach(() => vi.stubGlobal('document', { createElement: () => makeCanvas() }));
afterEach(() => vi.unstubAllGlobals());

function fixture(thin = false, ink = true) {
  const canvas = makeCanvas(500, 500), context = canvas.getContext('2d');
  context.fillStyle = '#a58b69'; context.fillRect(0, 0, 500, 500);
  if (ink) {
    context.fillStyle = '#111111'; context.fillRect(50, 195, 7, 97);
    if (!thin) { context.fillRect(122, 195, 7, 97); context.fillRect(50, 237, 79, 7); }
    context.fillRect(thin ? 70 : 140, 210, 10, 20); context.fillRect(thin ? 81 : 160, 210, 10, 20);
    // A second source line must not end up in the inline first-word picture.
    context.fillRect(140, 267, 50, 20);
  }
  const suffix = word(thin ? 'n' : 'arry', thin ? 70 : 140, 205, thin ? 22 : 40);
  const data: PdfOcrResult = { text: 'sample', confidence: 90, lines: [
    { text: 'A CHAPTER HEADING', confidence: 90, bbox: { x0: 50, y0: 30, x1: 300, y1: 60 }, words: [word('CHAPTER', 50, 30, 130)], baseline: { x0: 50, y0: 55, x1: 300, y1: 55 }, height: 30 },
    { text: suffix.text + ' read stories', confidence: 90, bbox: { x0: suffix.bbox.x0, y0: 205, x1: 430, y1: 230 }, words: [suffix, word('read', 210, 205, 60), word('stories', 290, 205, 100)], baseline: { x0: suffix.bbox.x0, y0: 230, x1: 430, y1: 230 }, height: 30 },
    { text: 'the next source line', confidence: 90, bbox: { x0: 140, y0: 265, x1: 430, y1: 290 }, words: [word('the', 140, 265, 40), word('next', 200, 265, 60), word('line', 280, 265, 80)], baseline: { x0: 140, y0: 290, x1: 430, y1: 290 }, height: 30 },
    { text: 'A regular body line', confidence: 90, bbox: { x0: 50, y0: 325, x1: 430, y1: 350 }, words: [word('regular', 50, 325, 80), word('body', 150, 325, 80), word('text', 250, 325, 80)], baseline: { x0: 50, y0: 350, x1: 430, y1: 350 }, height: 30 },
    { text: 'Another normal body line', confidence: 90, bbox: { x0: 50, y0: 385, x1: 430, y1: 410 }, words: [word('normal', 50, 385, 80), word('body', 150, 385, 80), word('text', 250, 385, 80)], baseline: { x0: 50, y0: 410, x1: 430, y1: 410 }, height: 30 },
  ] };
  return { canvas: canvas as unknown as HTMLCanvasElement, data, suffix };
}

it.each([false, true])('preserves an omitted %s-width initial from actual pixels with a transparent paper background', async thin => {
  const { canvas, data, suffix } = fixture(thin);
  const originalSecondLine = data.lines[2].words.map(word => word.text);
  const figures = await originalInitialWords(canvas, data);
  expect(figures).toHaveLength(1);
  expect(figures[0].anchor).toBe(suffix);
  expect(suffix.text).toBe('\ufffc');
  expect(data.lines[2].words.map(word => word.text)).toEqual(originalSecondLine);
  const image = await loadImage(figures[0].bytes), output = makeCanvas(image.width, image.height), context = output.getContext('2d'); context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, output.width, output.height).data;
  let transparent = 0, opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) { if (!pixels[i + 3]) transparent++; else { opaque++; expect(pixels[i] + pixels[i + 1] + pixels[i + 2]).toBe(0); } }
  expect(transparent).toBeGreaterThan(opaque);
  expect(opaque).toBeGreaterThan(30);
  expect(figures[0].height).toBe(36);
});

it('does not invent a character image when no large letter ink is present', async () => {
  const { canvas, data, suffix } = fixture(false, false);
  expect(await originalInitialWords(canvas, data)).toEqual([]);
  expect(suffix.text).toBe('arry');
});

it('keeps visible suffix letters even when OCR missed the first part of that word bbox', async () => {
  const { canvas, data, suffix } = fixture(true);
  suffix.bbox.x0 = 95; suffix.bbox.x1 = 115;
  const figures = await originalInitialWords(canvas, data);
  expect(figures).toHaveLength(1);
  expect(figures[0].anchor).toBe(suffix);
});

it('ignores stray prefix punctuation and attaches the graphic to the first source row, not its hanging continuation', async () => {
  const { canvas, data, suffix } = fixture();
  data.lines[1].words.unshift(word(';', 20, 205, 3)); data.lines[1].text = '; ' + data.lines[1].text;
  data.lines[2].baseline = { x0: 140, y0: 275, x1: 430, y1: 275 };
  for (const value of data.lines[2].words) { value.bbox.y0 = 250; value.bbox.y1 = 275; }
  const continuation = data.lines[2].words.map(value => value.text);
  const figures = await originalInitialWords(canvas, data);
  expect(figures).toHaveLength(1);
  expect(figures[0].anchor).toBe(suffix);
  expect(data.lines[1].words.some(value => value.text === ';')).toBe(false);
  expect(data.lines[2].words.map(value => value.text)).toEqual(continuation);
});
