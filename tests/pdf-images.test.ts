// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument, ImageKind, OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageImages, hasOcrTextLayer } from '../src/pdf-images';

beforeAll(() => {
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    return Object.assign(canvas, { toBlob: (callback: (blob: Blob) => void, mime = 'image/png') => callback(new Blob([new Uint8Array(mime === 'image/jpeg' ? canvas.encodeSync('jpeg', 94) : canvas.encodeSync('png'))], { type: mime })) });
  } });
});
afterAll(() => vi.unstubAllGlobals());

type OperatorList = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>;
const operators = (values: [number, unknown[]][]) => ({ fnArray: values.map(([fn]) => fn), argsArray: values.map(([, args]) => args), lastChunk: true, separateAnnots: null } as OperatorList);
function fakePage(objects: Record<string, unknown>, common: Record<string, unknown> = {}, view = [0, 0, 100, 200]) {
  const get = (values: Record<string, unknown>) => vi.fn((id: string, callback: (value: unknown) => void) => { queueMicrotask(() => callback(values[id])); });
  return { objs: { get: get(objects) }, commonObjs: { get: get(common) }, view } as unknown as PDFPageProxy;
}
async function pixels(bytes: Uint8Array) {
  const image = await loadImage(bytes); const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: [...context.getImageData(0, 0, image.width, image.height).data] };
}

describe('separate PDF figure extraction', () => {
  it('extracts the embedded picture from an actual text-and-image PDF without rasterizing its text', async () => {
    const source = createCanvas(2, 2), context = source.getContext('2d');
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 2);
    context.fillStyle = '#0000ff'; context.fillRect(1, 0, 1, 2);
    const pdf = await PDFDocument.create(); const page = pdf.addPage([400, 600]);
    const image = await pdf.embedPng(source.encodeSync('png')); const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('This text must remain reflowable.', { x: 30, y: 550, size: 16, font });
    page.drawImage(image, { x: 30, y: 300, width: 160, height: 160 });
    const task = getDocument({ data: await pdf.save() });
    try {
      const document = await task.promise, realPage = await document.getPage(1);
      const figures = await extractPageImages(realPage, await realPage.getOperatorList());
      expect(figures).toHaveLength(1); expect(figures[0]).toMatchObject({ width: 2, height: 2, mime: 'image/png' });
      const decoded = await pixels(figures[0].bytes);
      expect(decoded.data).toEqual([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
      expect((await realPage.getTextContent()).items.map(item => 'str' in item ? item.str : '').join('')).toContain('This text must remain reflowable.');
    } finally { await task.destroy(); }
  });

  it('keeps operator order, resolves global/shared images and deduplicates repeated image objects', async () => {
    const page = fakePage({ local: { width: 1, height: 1, kind: ImageKind.RGB_24BPP, data: new Uint8Array([255, 0, 0]) } },
      { g_shared: { width: 1, height: 1, kind: ImageKind.RGB_24BPP, data: new Uint8Array([0, 0, 255]) } });
    const figures = await extractPageImages(page, operators([
      [OPS.paintImageXObject, ['g_shared']], [OPS.paintImageXObjectRepeat, ['g_shared', 10, 10, [0, 0, 10, 10]]], [OPS.paintImageXObject, ['local']],
    ]));
    expect(figures).toHaveLength(2);
    expect((await pixels(figures[0].bytes)).data).toEqual([0, 0, 255, 255]);
    expect((await pixels(figures[1].bytes)).data).toEqual([255, 0, 0, 255]);
    expect(page.commonObjs.get).toHaveBeenCalledOnce(); expect(page.objs.get).toHaveBeenCalledOnce();
  });

  it('preserves transparent RGBA inline images and odd-width packed monochrome rows', async () => {
    const rgba = { width: 2, height: 1, kind: ImageKind.RGBA_32BPP, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) };
    const gray = { width: 9, height: 2, kind: ImageKind.GRAYSCALE_1BPP, data: new Uint8Array([0b10101010, 0b10000000, 0b01010101, 0]) };
    const result = await extractPageImages(fakePage({}), operators([[OPS.paintInlineImageXObject, [rgba]], [OPS.paintInlineImageXObject, [gray]]]));
    expect((await pixels(result[0].bytes)).data).toEqual([...rgba.data]);
    const monochrome = (await pixels(result[1].bytes)).data;
    for (let index = 0; index < 18; index++) {
      const expected = index % 2 === 0 ? 255 : 0;
      expect(monochrome.slice(index * 4, index * 4 + 4)).toEqual([expected, expected, expected, 255]);
    }
  });

  it('exports actual bitmap images while ignoring unrelated vector drawing operations', async () => {
    const bitmap = createCanvas(3, 2); const ctx = bitmap.getContext('2d'); ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 3, 2);
    const page = fakePage({ photo: { width: 3, height: 2, bitmap } });
    expect(await extractPageImages(page, operators([[OPS.constructPath, [OPS.fill, [], [0, 0, 100, 100]]], [OPS.shadingFill, ['shade']]]))).toEqual([]);
    const [result] = await extractPageImages(page, operators([[OPS.paintImageXObject, ['photo']]]));
    expect(result).toMatchObject({ width: 3, height: 2 });
    expect((await pixels(result.bytes)).data.slice(0, 4)).toEqual([0, 255, 0, 255]);
  });

  it('honours stencil transparency and fill colour for picture masks, omitting tiny glyph masks', async () => {
    const mask = { width: 24, height: 1, data: new Uint8Array([0, 255, 0]) };
    const tiny = { width: 1, height: 1, data: new Uint8Array([0]) };
    const result = await extractPageImages(fakePage({}), operators([
      [OPS.setFillRGBColor, ['#ff0000']], [OPS.paintImageMaskXObject, [mask]], [OPS.paintImageMaskXObject, [tiny]],
    ]));
    expect(result).toHaveLength(1); const data = (await pixels(result[0].bytes)).data;
    expect(data.slice(0, 4)).toEqual([255, 0, 0, 255]); expect(data.slice(8 * 4, 9 * 4)).toEqual([0, 0, 0, 0]);
  });

  it('rejects a missing or malformed image rather than silently losing a figure', async () => {
    await expect(extractPageImages(fakePage({}), operators([[OPS.paintImageXObject, ['missing']]]))).rejects.toThrow('conversionFailed');
    await expect(extractPageImages(fakePage({ bad: { width: 10, height: 10, kind: ImageKind.RGB_24BPP, data: new Uint8Array(2) } }), operators([[OPS.paintImageXObject, ['bad']]]))).rejects.toThrow('conversionFailed');
    await expect(extractPageImages(fakePage({ big: { width: 10000, height: 10000 } }), operators([[OPS.paintImageXObject, ['big']]]))).rejects.toThrow('pdfConversionTooLarge');
  });

  it('downscales an oversized packed image while keeping its content visible and aspect ratio', async () => {
    const image = { width: 4096, height: 4096, kind: ImageKind.GRAYSCALE_1BPP, data: new Uint8Array(4096 * 512).fill(255) };
    const [result] = await extractPageImages(fakePage({}), operators([[OPS.paintInlineImageXObject, [image]]]));
    expect(result.width).toBeLessThan(4096); expect(result.width).toBe(result.height);
    expect(result.width * result.height).toBeLessThanOrEqual(12_000_000);
    const decoded = await loadImage(result.bytes); const small = createCanvas(1, 1); const context = small.getContext('2d');
    context.drawImage(decoded, 0, 0, 1, 1); expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it('uses a compact JPEG for larger opaque RGB figures while retaining their dimensions and colours', async () => {
    const data = new Uint8Array(128 * 96 * 3);
    for (let index = 0; index < data.length; index += 3) { data[index] = 200; data[index + 1] = 100; data[index + 2] = 50; }
    const [result] = await extractPageImages(fakePage({}), operators([[OPS.paintInlineImageXObject, [{ width: 128, height: 96, kind: ImageKind.RGB_24BPP, data }]]]));
    expect(result).toMatchObject({ width: 128, height: 96, mime: 'image/jpeg' });
    expect([...result.bytes.subarray(0, 2)]).toEqual([255, 216]);
    const decoded = await pixels(result.bytes);
    for (const [index, expected] of [200, 100, 50].entries()) expect(Math.abs(decoded.data[index] - expected)).toBeLessThanOrEqual(2);
  });

  it('detects transparency in browser bitmap payloads that no longer carry an ImageKind', async () => {
    const bitmap = createCanvas(128, 96), ctx = bitmap.getContext('2d');
    ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 128, 96);
    const page = fakePage({ opaque: { width: 128, height: 96, bitmap } });
    expect((await extractPageImages(page, operators([[OPS.paintImageXObject, ['opaque']]])))[0].mime).toBe('image/jpeg');
    ctx.clearRect(10, 10, 5, 5);
    const [transparent] = await extractPageImages(page, operators([[OPS.paintImageXObject, ['opaque']]]));
    expect(transparent.mime).toBe('image/png');
    expect((await pixels(transparent.bytes)).data.slice((10 * 128 + 10) * 4, (10 * 128 + 10) * 4 + 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('searchable scans and page background omission', () => {
  const glyphs = (text: string) => [...text].map(unicode => ({ unicode }));
  const red = { width: 1, height: 1, kind: ImageKind.RGB_24BPP, data: new Uint8Array([255, 0, 0]) };
  const green = { width: 1, height: 1, kind: ImageKind.RGB_24BPP, data: new Uint8Array([0, 255, 0]) };

  it('recognizes a predominantly invisible OCR layer rather than any hidden word', () => {
    expect(hasOcrTextLayer(operators([[OPS.setTextRenderingMode, [3]], [OPS.showText, [glyphs('Searchable OCR text over the scanned page.')]]]))).toBe(true);
    expect(hasOcrTextLayer(operators([[OPS.showText, [glyphs('Normal visible body text.')]]]))).toBe(false);
    expect(hasOcrTextLayer(operators([[OPS.showText, [glyphs('Normal visible body text is much longer than the hidden word.')]], [OPS.setTextRenderingMode, [3]], [OPS.showText, [glyphs('footnote')]]]))).toBe(false);
    expect(hasOcrTextLayer(operators([[OPS.setTextRenderingMode, [3]], [OPS.showText, [glyphs('1')]]]))).toBe(false);
    expect(hasOcrTextLayer(operators([[OPS.setTextRenderingMode, [7]], [OPS.showText, [glyphs('Text used to clip a decorative image.')]]]))).toBe(false);
  });

  it('restores text visibility across saved graphics states and form XObjects', () => {
    const hidden = glyphs('Some invisible words.'), visible = glyphs('The visible paragraph is deliberately longer than the invisible layer.');
    expect(hasOcrTextLayer(operators([[OPS.save, []], [OPS.setTextRenderingMode, [3]], [OPS.showText, [hidden]], [OPS.restore, []], [OPS.showText, [visible]]]))).toBe(false);
    expect(hasOcrTextLayer(operators([[OPS.paintFormXObjectBegin, [null, null]], [OPS.setTextRenderingMode, [3]], [OPS.showText, [hidden]], [OPS.paintFormXObjectEnd, []], [OPS.showText, [visible]]]))).toBe(false);
    expect(hasOcrTextLayer(operators([[OPS.setTextRenderingMode, [3]], [OPS.showSpacedText, [[{ unicode: 'OCR' }, -250, { unicode: ' text' }, 200, { unicode: ' stays searchable' }]]]]))).toBe(true);
  });

  it('omits both full-page scan layers only when requested, preserving a smaller illustration', async () => {
    const foreground = { width: 1, height: 1, kind: ImageKind.RGBA_32BPP, data: new Uint8Array([0, 0, 255, 128]) };
    const page = fakePage({ background: red, foreground, picture: green });
    const list = operators([
      [OPS.save, []], [OPS.transform, [100, 0, 0, 200, 0, 0]], [OPS.paintImageXObject, ['background']], [OPS.paintImageXObject, ['foreground']], [OPS.restore, []],
      [OPS.save, []], [OPS.transform, [20, 0, 0, 20, 10, 80]], [OPS.paintImageXObject, ['picture']], [OPS.restore, []],
    ]);
    const all = await extractPageImages(page, list);
    expect(all).toHaveLength(3);
    vi.mocked(page.objs.get).mockClear();
    const reflowed = await extractPageImages(page, list, { omitPageBackground: true });
    expect(reflowed).toHaveLength(1);
    expect((await pixels(reflowed[0].bytes)).data).toEqual([0, 255, 0, 255]);
    expect(page.objs.get).toHaveBeenCalledOnce();
  });

  it('uses the cropped page and composed rotation matrix, without deduplicating a later small use of the same image', async () => {
    const page = fakePage({ reused: red }, {}, [10, 20, 110, 220]);
    const list = operators([
      [OPS.save, []], [OPS.transform, [1, 0, 0, 1, 10, 20]], [OPS.transform, [0, 200, -100, 0, 100, 0]], [OPS.paintImageXObject, ['reused']], [OPS.restore, []],
      [OPS.transform, [20, 0, 0, 20, 50, 50]], [OPS.paintImageXObject, ['reused']],
    ]);
    const figures = await extractPageImages(page, list, { omitPageBackground: true });
    expect(figures).toHaveLength(1); expect(page.objs.get).toHaveBeenCalledOnce();
    expect((await pixels(figures[0].bytes)).data).toEqual([255, 0, 0, 255]);
  });

  it('requires at least eighty percent actual page coverage, retaining smaller and rotated diamond illustrations', async () => {
    const page = fakePage({ image: red });
    const large = operators([[OPS.transform, [100, 0, 0, 160, 0, 0]], [OPS.paintImageXObject, ['image']]]);
    expect(await extractPageImages(page, large, { omitPageBackground: true })).toHaveLength(0);
    const small = operators([[OPS.transform, [100, 0, 0, 159, 0, 0]], [OPS.paintImageXObject, ['image']]]);
    expect(await extractPageImages(page, small, { omitPageBackground: true })).toHaveLength(1);
    const diamond = operators([[OPS.transform, [50, 100, -50, 100, 50, 0]], [OPS.paintImageXObject, ['image']]]);
    expect(await extractPageImages(page, diamond, { omitPageBackground: true })).toHaveLength(1);
  });

  it('tracks form XObject transforms and restores them after the form ends', async () => {
    const page = fakePage({ scan: red, picture: green });
    const list = operators([
      [OPS.paintFormXObjectBegin, [[100, 0, 0, 200, 0, 0], [0, 0, 1, 1]]], [OPS.paintImageXObject, ['scan']], [OPS.paintFormXObjectEnd, []],
      [OPS.transform, [10, 0, 0, 10, 20, 40]], [OPS.paintImageXObject, ['picture']],
    ]);
    const figures = await extractPageImages(page, list, { omitPageBackground: true });
    expect(figures).toHaveLength(1); expect((await pixels(figures[0].bytes)).data).toEqual([0, 255, 0, 255]);
  });
});
