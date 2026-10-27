// @vitest-environment node
import { expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { ocrFigures, trimOcrFigureHeader } from '../src/pdf-ocr-figures';

const box = { x0: 20, y0: 30, x1: 160, y1: 190 };
it.each([9, 10, 11, 'FLOWING_IMAGE', 'HEADING_IMAGE', 'PULLOUT_IMAGE'])('recognizes image block type %s without interpreting text blocks as pictures', type => {
  expect(ocrFigures({ blocks: [{ blocktype: type, text: '', bbox: box }, { blocktype: 1, text: 'A paragraph', bbox: box }] }, 400, 600)).toEqual([{ bbox: box }]);
});

it('recovers photos present only in HOCR, accepts attribute order and deduplicates JSON regions', () => {
  const hocr = `<div title="bbox 20 30 160 190" class='ocr_carea ocr_photo'></div><div class="ocr_image" title="bbox 200 10 350 180; x_wconf 90"></div>`;
  expect(ocrFigures({ hocr, blocks: [{ blocktype: 9, bbox: box }] }, 400, 600)).toEqual([{ bbox: box }, { bbox: { x0: 200, y0: 10, x1: 350, y1: 180 } }]);
});

it('ignores malformed coordinates and unrelated HTML, clamps legitimate partially cropped bounds', () => {
  const hocr = `<script>fetch('https://example.invalid')</script><div class="ocr_photo" title="bbox NaN 0 200 300"></div><div class="ocr_photo" title="bbox 30 50 20 80"></div><div class="ocr_photo" title="bbox -10 -20 500 700"></div><div class="ocr_line" title="bbox 0 0 20 20"></div>`;
  expect(ocrFigures({ hocr }, 400, 600)).toEqual([{ bbox: { x0: 0, y0: 0, x1: 400, y1: 600 } }]);
  expect(ocrFigures({ blocks: [{ blocktype: 9, bbox: { ...box, x0: Infinity } }] }, 400, 600)).toEqual([]);
});

it('keeps distinct nested image regions instead of suppressing the complete illustration', () => {
  const small = { x0: 40, y0: 50, x1: 60, y1: 70 };
  expect(ocrFigures({ blocks: [{ blocktype: 9, bbox: small }], hocr: '<div class="ocr_photo" title="bbox 20 30 160 190"></div>' }, 400, 600)).toEqual([{ bbox: small }, { bbox: box }]);
});

function photo(options: { connectedHeader?: boolean; tallHeader?: boolean; noGap?: boolean } = {}) {
  const canvas = createCanvas(600, 1000), context = canvas.getContext('2d');
  context.fillStyle = '#bcaa96'; context.fillRect(0, 0, 600, 1000); context.fillStyle = '#202020';
  if (options.connectedHeader) context.fillRect(110, 14, 350, 20);
  else for (let i = 0; i < 8; i++) context.fillRect(110 + i * 46, 14, 12, options.tallHeader ? 100 : 20);
  context.fillRect(160, options.noGap ? 30 : 200, 260, options.noGap ? 570 : 400);
  return { canvas: canvas as unknown as HTMLCanvasElement, original: canvas, bbox: { x0: 100, y0: 10, x1: 500, y1: 610 } };
}

it('trims only the isolated thin printed header while retaining a margin and every illustration pixel', () => {
  const { canvas, original, bbox } = photo(), before = original.encodeSync('png'), trimmed = trimOcrFigureHeader(canvas, bbox);
  expect(trimmed.y0).toBeGreaterThan(34); expect(trimmed.y0).toBeLessThan(200);
  expect(trimmed).toMatchObject({ x0: 100, x1: 500, y1: 610 });
  expect(original.encodeSync('png')).toEqual(before);
});

it.each([{ connectedHeader: true }, { tallHeader: true }, { noGap: true }])('preserves continuous or substantial artwork rather than treating it as a thin header: %j', options => {
  const { canvas, bbox } = photo(options); expect(trimOcrFigureHeader(canvas, bbox)).toEqual(bbox);
});

it('never trims a figure outside the page header area', () => {
  const { canvas, bbox } = photo(); const lower = { ...bbox, y0: 200, y1: 800 };
  expect(trimOcrFigureHeader(canvas, lower)).toEqual(lower);
});
