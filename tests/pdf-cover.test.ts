// @vitest-environment node
import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { withPdfCover } from '../src/pdf-cover';
import { coverMime, readCover } from '../src/cover';
import { coverDataURL, coverFixture } from './cover-fixture';
import { pdfFixture } from './pdf-fixture';

it.each(['image/png', 'image/jpeg'])('adds the chosen %s cover before all original PDF pages without mutating the source', async mime => {
  const source = pdfFixture(), before = source.slice();
  const output = await withPdfCover(source, coverFixture(mime));
  expect(source).toEqual(before);
  const task = getDocument({ data: output.slice() });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(2);
    expect((await (await pdf.getPage(1)).getTextContent()).items).toHaveLength(0);
    const text = (await (await pdf.getPage(2)).getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join(' ');
    expect(text).toContain('Title & <notes>');
    expect(text).toContain('and its continuation.');
    const cover = await pdf.getPage(1);
    const viewport = cover.getViewport({ scale: 0.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await cover.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise;
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.75), 1, 1).data;
    expect(pixel[0]).toBeLessThan(35); expect(pixel[1]).toBeGreaterThan(110); expect(pixel[2]).toBeGreaterThan(125);
  } finally { await task.destroy(); }
});

it('preserves embedded multilingual fonts, Unicode and the PDF catalogue when adding a cover', async () => {
  const source = new Uint8Array(await readFile('tests/fixtures/mixed-scripts.pdf'));
  const original = await PDFDocument.load(source);
  original.setTitle('Original document title');
  original.getPage(0).node.set(PDFName.of('TestAnnotation'), PDFString.of('keep me'));
  const output = await withPdfCover(await original.save(), coverFixture());
  const saved = await PDFDocument.load(output);
  expect(saved.getTitle()).toBe('Original document title');
  expect(saved.getPage(1).node.lookup(PDFName.of('TestAnnotation'), PDFString).decodeText()).toBe('keep me');
  const task = getDocument({ data: output.slice() });
  let rendered: Uint8Array | undefined;
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(2);
    const text = (await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('').replace(/\s/g, '');
    for (const sample of ['中文', '日本語ひらがなカタカナ', '한국어안녕하세요', 'ภาษาไทยสวัสดี']) expect(text).toContain(sample);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise;
    rendered = new Uint8Array(canvas.encodeSync('png'));
  } finally { await task.destroy(); }
  const before = getDocument({ data: source.slice() });
  try {
    const page = await (await before.promise).getPage(1);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise;
    // Adding a cover must not alter the rendered glyphs or layout of body pages.
    expect(rendered).toEqual(new Uint8Array(canvas.encodeSync('png')));
  } finally { await before.destroy(); }
});

it('replaces its own previous cover when an exported PDF is reimported, without stacking cover pages', async () => {
  const first = await withPdfCover(pdfFixture(), coverFixture());
  const second = await withPdfCover(first, coverFixture('image/jpeg'));
  expect((await PDFDocument.load(second)).getPageCount()).toBe(2);
});

it('rejects malformed PDF/cover input instead of silently returning a PDF without the chosen cover', async () => {
  await expect(withPdfCover(new TextEncoder().encode('%PDF-1.7 broken'), coverFixture())).rejects.toThrow('pdfCoverFailed');
  await expect(withPdfCover(pdfFixture(), { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' })).rejects.toThrow('coverInvalid');
});

it('detects cover image types from bytes and rejects a misleading data URL MIME', () => {
  const png = coverFixture();
  expect(coverMime(png.bytes)).toBe('image/png');
  expect(readCover(coverDataURL(png))).toEqual(png);
  expect(() => readCover(coverDataURL(png).replace('image/png', 'image/jpeg'))).toThrow('coverInvalid');
  expect(readCover(undefined)).toBeUndefined();
});
