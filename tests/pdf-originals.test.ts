// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { getDocument, type PDFPageProxy, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { appendOriginalPages, createOriginalPage } from '../src/pdf-originals';
import { pdfFixture } from './pdf-fixture';

const dom = new JSDOM();
let canvases: { width: number; height: number }[];
beforeAll(() => {
  vi.stubGlobal('DOMParser', dom.window.DOMParser); vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1); canvases.push(canvas);
    return Object.assign(canvas, { toBlob: (callback: BlobCallback, mime = 'image/jpeg', quality = .9) => callback(new Blob([new Uint8Array(mime === 'image/png' ? canvas.encodeSync('png') : canvas.encodeSync('jpeg', Math.round(quality * 100)))], { type: mime })) });
  } });
});
beforeEach(() => { canvases = []; });
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });
const parse = (value: string) => new dom.window.DOMParser().parseFromString(value, 'application/xml');
const opf = 'http://www.idpf.org/2007/opf', xhtml = 'http://www.w3.org/1999/xhtml';

function page(width = 400, height = 600) {
  const source = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
    render: vi.fn(({ canvas, canvasContext }: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D }) => {
      canvasContext.fillStyle = '#3388aa'; canvasContext.fillRect(0, 0, canvas.width, canvas.height);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    }), cleanup: vi.fn(),
  };
  return source as unknown as PDFPageProxy & typeof source;
}

function book() {
  const zip = new JSZip();
  zip.file('OEBPS/book.opf', `<?xml version="1.0"?><package xmlns="${opf}" version="3.0"><metadata/><manifest><item id="page-1" href="page-1.xhtml" media-type="application/xhtml+xml"/><item id="page-2" href="page-2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="page-1"/><itemref idref="page-2"/></spine></package>`);
  for (const number of [1, 2]) zip.file(`OEBPS/page-${number}.xhtml`, `<?xml version="1.0"?><html xmlns="${xhtml}"><head><title>Text ${number}</title></head><body id="pdf-page-${number}"><p>Adjustable reading text ${number}.</p></body></html>`);
  return zip;
}

describe('original-page review outside the reflowable reading sequence', () => {
  it('renders actual source artwork as a bounded JPEG and creates a valid review document with a return link', async () => {
    const bytes = pdfFixture(['0.2 0.4 0.6 rg 40 550 300 200 re f']), before = bytes.slice();
    const task = getDocument({ data: bytes.slice() });
    try {
      const pdf = await task.promise, source = await pdf.getPage(1), zip = new JSZip();
      const result = await createOriginalPage(zip, source, 1, { title: 'A & B <notes>', language: 'en-GB' });
      const imageBytes = await zip.file('OEBPS/original-pages/page-1.jpg')!.async('uint8array');
      const documentText = await zip.file('OEBPS/original-pages/page-1.xhtml')!.async('string');
      expect([...imageBytes.subarray(0, 2)]).toEqual([255, 216]);
      const image = await loadImage(imageBytes);
      expect(image.width * image.height).toBeLessThanOrEqual(3_000_000);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2200);
      const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixel = context.getImageData(Math.floor(190 * image.width / 595), Math.floor((842 - 650) * image.height / 842), 1, 1).data;
      for (const [index, value] of [51, 102, 153].entries()) expect(Math.abs(pixel[index] - value)).toBeLessThanOrEqual(3);
      const document = parse(documentText);
      expect(document.querySelector('parsererror')).toBeNull();
      expect(document.querySelector('title')?.textContent).toBe('A & B <notes> — Original page 1');
      expect(document.querySelector('img')?.getAttribute('src')).toBe('page-1.jpg');
      expect([...document.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['../page-1.xhtml#pdf-page-1', '../page-1.xhtml#pdf-page-1']);
      expect(result.bytes).toBe(imageBytes.length + new TextEncoder().encode(documentText).length);
      expect(result.spine).toBe('<itemref idref="original-page-1" linear="no"/>');
      expect(parse(`<manifest xmlns="${opf}">${result.manifest.join('')}</manifest>`).querySelectorAll('item')).toHaveLength(2);
      expect(parse(`<body xmlns="${xhtml}">${result.link}</body>`).querySelector('a')?.getAttribute('href')).toBe('original-pages/page-1.xhtml#original-page-1');
      expect(bytes).toEqual(before); expect(canvases.every(value => !value.width && !value.height)).toBe(true);
    } finally { await task.destroy(); }
  });

  it.each([
    ['en', 'Original page 2', 'Return to text'], ['pt-BR', 'Página original 2', 'Voltar ao texto'],
    ['ru', 'Исходная страница 2', 'Вернуться к тексту'], ['ko', '원본 2쪽', '텍스트로 돌아가기'],
    ['zh-CN', '原始页面 2', '返回正文'], ['zh-TW', '原始頁面 2', '返回正文'],
    ['es', 'Página original 2', 'Volver al texto'], ['ja', '元のページ 2', '本文に戻る'],
    ['th', 'หน้าต้นฉบับ 2', 'กลับไปที่ข้อความ'],
  ])('uses the book language for original-page labels (%s)', async (language, title, back) => {
    const zip = new JSZip(), result = await createOriginalPage(zip, page(32, 48), 2, { title: 'Book', language });
    const document = parse(await zip.file('OEBPS/original-pages/page-2.xhtml')!.async('string'));
    expect(document.querySelector('h1')?.textContent).toBe(title);
    expect(document.querySelector('a')?.textContent).toBe(back);
    expect(result.link).not.toContain('font-size');
  });

  it('reuses already written review pages and does not render the source a second time', async () => {
    const source = page(32, 48), zip = new JSZip(), metadata = { title: 'Book', language: 'en' };
    const first = await createOriginalPage(zip, source, 1, metadata), second = await createOriginalPage(zip, source, 1, metadata);
    expect(first.bytes).toBeGreaterThan(0); expect(second.bytes).toBe(0);
    expect(second.manifest).toEqual(first.manifest); expect(second.spine).toBe(first.spine); expect(second.link).toBe(first.link);
    expect(source.render).toHaveBeenCalledOnce();
  });

  it('appends non-linear originals after all reading text and adds working round-trip links without changing that text', async () => {
    const zip = book(), pages = [page(32, 48), page(32, 48)], progress = vi.fn();
    const pdf = { numPages: 2, getPage: vi.fn(async (number: number) => pages[number - 1]) } as unknown as PDFDocumentProxy;
    const result = await appendOriginalPages(zip, pdf, [2, 1, 2], { title: 'Book', language: 'en' }, progress);
    expect(result.pages).toBe(2); expect(result.bytes).toBeGreaterThan(0);
    const packageDocument = parse(await zip.file('OEBPS/book.opf')!.async('string'));
    expect([...packageDocument.querySelectorAll('spine>itemref')].map(item => [item.getAttribute('idref'), item.getAttribute('linear')])).toEqual([
      ['page-1', null], ['page-2', null], ['original-page-1', 'no'], ['original-page-2', 'no'],
    ]);
    expect(packageDocument.querySelectorAll('manifest>item')).toHaveLength(6);
    for (const number of [1, 2]) {
      const text = parse(await zip.file(`OEBPS/page-${number}.xhtml`)!.async('string'));
      expect(text.querySelector('p')?.textContent).toBe(`Adjustable reading text ${number}.`);
      const href = text.querySelector('a')!.getAttribute('href')!;
      const [path, id] = href.split('#'), original = parse(await zip.file('OEBPS/' + path)!.async('string'));
      expect(original.getElementById(id)).not.toBeNull();
      expect(original.querySelector('a')?.getAttribute('href')).toBe(`../page-${number}.xhtml#pdf-page-${number}`);
      expect(text.getElementById(`pdf-page-${number}`)).not.toBeNull();
      expect(pages[number - 1].cleanup).toHaveBeenCalledOnce();
    }
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
    const repeated = await appendOriginalPages(zip, pdf, [1, 2], { title: 'Book', language: 'en' });
    expect(repeated.bytes).toBe(0);
    const repeatedPackage = parse(await zip.file('OEBPS/book.opf')!.async('string'));
    expect(repeatedPackage.querySelectorAll('manifest>item')).toHaveLength(6); expect(repeatedPackage.querySelectorAll('spine>itemref')).toHaveLength(4);
    for (const number of [1, 2]) {
      expect(pages[number - 1].render).toHaveBeenCalledOnce();
      expect(parse(await zip.file(`OEBPS/page-${number}.xhtml`)!.async('string')).querySelectorAll('a')).toHaveLength(1);
    }
  });

  it('rejects invalid page numbers and missing main-text documents instead of creating broken review links', async () => {
    const source = page(32, 48);
    await expect(createOriginalPage(new JSZip(), source, 0, { title: 'Book', language: 'en' })).rejects.toThrow('conversionFailed');
    const pdf = { numPages: 2, getPage: vi.fn(async () => source) } as unknown as PDFDocumentProxy;
    await expect(appendOriginalPages(book(), pdf, [3], { title: 'Book', language: 'en' })).rejects.toThrow('conversionFailed');
    const missing = book(); missing.remove('OEBPS/page-2.xhtml');
    await expect(appendOriginalPages(missing, pdf, [2], { title: 'Book', language: 'en' })).rejects.toThrow('conversionFailed');
    expect(source.render).not.toHaveBeenCalled();
  });

  it('releases its canvas when source rendering fails and writes no partial original page', async () => {
    const source = page(32, 48), zip = new JSZip();
    source.render.mockReturnValue({ promise: Promise.reject(new Error('Source rendering failed')), cancel: vi.fn() });
    await expect(createOriginalPage(zip, source, 1, { title: 'Book', language: 'en' })).rejects.toThrow('Source rendering failed');
    expect(zip.file('OEBPS/original-pages/page-1.jpg')).toBeNull(); expect(zip.file('OEBPS/original-pages/page-1.xhtml')).toBeNull();
    expect(canvases.every(value => !value.width && !value.height)).toBe(true);
  });
});
