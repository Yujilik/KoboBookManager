// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToEpub } from '../src/pdf';
import { emptyMetadata, readEpub } from '../src/epub';
import { pdfFixture } from './pdf-fixture';
import { kepubWithWasm } from './kepub-fixture';
import { coverFixture } from './cover-fixture';
import { createPdfOcr, type PdfOcr } from '../src/pdf-ocr';

vi.mock('../src/pdf-ocr', () => ({ createPdfOcr: vi.fn() }));
let recognize: Mock<PdfOcr['recognize']>, closeOcr: Mock<PdfOcr['close']>;
beforeEach(() => {
  recognize = vi.fn<PdfOcr['recognize']>().mockResolvedValue({ text: '', confidence: 0, lines: [] });
  closeOcr = vi.fn<PdfOcr['close']>().mockResolvedValue(undefined);
  vi.mocked(createPdfOcr).mockReset().mockResolvedValue({ recognize, close: closeOcr });
});

const dom = new JSDOM();
beforeAll(() => {
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    return Object.assign(canvas, { toBlob: (callback: (blob: Blob) => void, mime = 'image/jpeg') => callback(new Blob([new Uint8Array(mime === 'image/png' ? canvas.encodeSync('png') : canvas.encodeSync('jpeg', 94))], { type: mime })) });
  } });
});
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

it('parses a real PDF into an EPUB with reflowable escaped text, cover, navigation and an intact original', async () => {
  const pdf = pdfFixture(), original = pdf.slice();
  const progress = vi.fn();
  const epub = await pdfToEpub(pdf, emptyMetadata('A book & its notes'), progress);
  expect(pdf).toEqual(original);
  const zip = await JSZip.loadAsync(epub);
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
  const chapter = await zip.file('OEBPS/page-1.xhtml')!.async('string');
  expect(chapter).toContain('Title &amp; &lt;notes&gt;');
  expect(chapter).toContain('First line of a paragraph and its continuation.');
  expect(chapter).not.toContain('<img');
  const read = await readEpub(epub);
  expect(read.metadata.title).toBe('A book & its notes');
  expect(read.metadata.language).toBe('en-GB');
  expect(read.cover?.mime).toBe('image/jpeg');
  expect(read.cover?.bytes.byteLength).toBeGreaterThan(100);
  const nav = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/nav.xhtml')!.async('string'), 'application/xml');
  expect(Array.from(nav.querySelectorAll('a')).some(link => link.getAttribute('href')?.startsWith('page-1.xhtml#'))).toBe(true);
  expect(progress.mock.calls.at(-1)).toEqual([100]);
}, 30_000);

it('keeps text adjustable beside drawings and preserves genuine picture and blank pages', async () => {
  const pdf = pdfFixture(['0.2 0.4 0.6 rg 40 550 300 200 re f', 'BT /F1 12 Tf 40 750 Td (Illustrated page) Tj ET 0.5 g 40 550 100 100 re f', '']);
  const epub = await pdfToEpub(pdf, emptyMetadata('Illustrated book'), vi.fn());
  const zip = await JSZip.loadAsync(epub);
  for (const number of [1, 3]) {
    expect(await zip.file(`OEBPS/page-${number}.xhtml`)!.async('string')).toContain(`<img src="images/page-${number}.jpg"`);
    expect((await zip.file(`OEBPS/images/page-${number}.jpg`)!.async('uint8array')).byteLength).toBeGreaterThan(100);
  }
  const textPage = await zip.file('OEBPS/page-2.xhtml')!.async('string');
  expect(textPage).toContain('Illustrated page');
  expect(textPage).not.toContain('<img');
  expect(textPage).toMatch(/<p|<h2/);
  const opf = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
  expect(opf.querySelector('parsererror')).toBeNull();
  expect(opf.getElementsByTagName('itemref').length).toBe(3);
}, 30_000);

it('recovers an unreadable character map through recognition instead of disguising its text as a page image', async () => {
  const pdf = pdfFixture(['BT /F1 12 Tf 40 750 Td (Visible page text) Tj ET 0.5 g 40 550 100 100 re f']);
  const task = getDocument({ data: pdf.slice() });
  const source = await task.promise;
  const page = await source.getPage(1);
  const originalGetTextContent = page.getTextContent;
  const prototype = Object.getPrototypeOf(page) as PDFPageProxy;
  await task.destroy();
  const extraction = vi.spyOn(prototype, 'getTextContent').mockImplementation(async function (this: PDFPageProxy, ...args: Parameters<PDFPageProxy['getTextContent']>) {
    const content = await originalGetTextContent.apply(this, args);
    return { ...content, items: content.items.map(item => 'str' in item ? { ...item, str: '\uE001\uFFFD' } : item) };
  });
  try {
    recognize.mockResolvedValue({ text: 'Recovered readable paragraph', confidence: 93, lines: [{ text: 'Recovered readable paragraph', confidence: 93, bbox: { x0: 40, y0: 80, x1: 240, y1: 120 }, words: [{ text: 'Recovered readable paragraph', confidence: 93, bbox: { x0: 40, y0: 80, x1: 240, y1: 120 } }] }] });
    const output = await pdfToEpub(pdf, emptyMetadata('Unreadable text'), vi.fn(), undefined, { ocrLanguages: ['eng'] });
    const zip = await JSZip.loadAsync(output), chapter = await zip.file('OEBPS/page-1.xhtml')!.async('string');
    expect(chapter).toContain('Recovered readable paragraph');
    expect(chapter).not.toContain('<img');
    expect(createPdfOcr).toHaveBeenCalledWith(['eng'], expect.any(Function));
    expect(closeOcr).toHaveBeenCalled();
  } finally { extraction.mockRestore(); }
}, 30_000);

it('does not report image-only scans as successful adjustable EPUB conversions', async () => {
  await expect(pdfToEpub(pdfFixture(['0.2 0.4 0.6 rg 40 550 300 200 re f']), emptyMetadata('Scan'), vi.fn())).rejects.toThrow('pdfTextUnavailable');
  expect(createPdfOcr).toHaveBeenCalledOnce();
  expect(recognize).toHaveBeenCalledOnce();
  expect(closeOcr).toHaveBeenCalled();
});

it.each([false, true])('omits absent or blank optional metadata from EPUB and KEPUB packages (blank fields: %s)', async blank => {
  const details = emptyMetadata('Book without source metadata');
  if (blank) Object.assign(details, {
    description: ' \n\u0001', publisher: '\t ', published: ' ', isbn: '\u0001',
    authors: [' ', '\u0001'], tags: ['\n', '\u0001'], series: ' \u0001', seriesIndex: ' ',
  });
  const epub = await pdfToEpub(pdfFixture(), details, vi.fn());
  for (const bytes of [epub, await kepubWithWasm(epub)]) {
    const zip = await JSZip.loadAsync(bytes);
    const opf = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
    const dc = 'http://purl.org/dc/elements/1.1/';
    expect(opf.querySelector('parsererror')).toBeNull();
    for (const name of ['description', 'publisher', 'date', 'creator', 'subject']) {
      expect(opf.getElementsByTagNameNS(dc, name)).toHaveLength(0);
    }
    expect(opf.getElementsByTagNameNS(dc, 'identifier')).toHaveLength(1);
    expect(opf.getElementsByTagNameNS(dc, 'title')[0].textContent).toBe(details.title);
    expect(opf.querySelector('meta[name="calibre:series"]')).toBeNull();
  }
}, 30_000);

it('keeps nonempty optional metadata escaped and omits blank authors and tags', async () => {
  const details = { ...emptyMetadata('Metadata book'), description: 'Notes & <examples>',
    publisher: 'A & B', published: '2026-10-27', isbn: '9780000000002',
    authors: [' ', 'Writer & Editor'], tags: ['', 'Languages & stories'], series: 'Notes & books', seriesIndex: ' ' };
  const zip = await JSZip.loadAsync(await pdfToEpub(pdfFixture(), details, vi.fn()));
  const source = await zip.file('OEBPS/book.opf')!.async('string');
  const opf = new dom.window.DOMParser().parseFromString(source, 'application/xml');
  const values = (name: string) => Array.from(opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)).map(node => node.textContent);
  expect(opf.querySelector('parsererror')).toBeNull();
  expect(source).toContain('Notes &amp; &lt;examples&gt;');
  expect(values('description')).toEqual([details.description]);
  expect(values('publisher')).toEqual([details.publisher]);
  expect(values('date')).toEqual([details.published]);
  expect(values('creator')).toEqual(['Writer & Editor']);
  expect(values('subject')).toEqual(['Languages & stories']);
  expect(values('identifier')).toContain('urn:isbn:9780000000002');
  expect(opf.querySelector('meta[name="calibre:series"]')?.getAttribute('content')).toBe(details.series);
  expect(opf.querySelector('meta[name="calibre:series_index"]')?.getAttribute('content')).toBe('1');
}, 30_000);

it('rejects malformed PDFs rather than saving corrupt output', async () => {
  await expect(pdfToEpub(new TextEncoder().encode('%PDF-1.7 broken'), emptyMetadata('Invalid'), vi.fn())).rejects.toThrow('conversionFailed');
});

it('limits page count before rendering to avoid exhausting a phone', async () => {
  await expect(pdfToEpub(pdfFixture(Array(2001).fill('')), emptyMetadata('Large'), vi.fn())).rejects.toThrow('pdfConversionTooLarge');
}, 30_000);

it('uses a chosen cover for PDF-to-EPUB and PDF-to-KEPUB, including the first spine page and cover metadata', async () => {
  const cover = coverFixture();
  const epub = await pdfToEpub(pdfFixture(), emptyMetadata('New cover'), vi.fn(), cover);
  for (const output of [epub, await kepubWithWasm(epub)]) {
    expect((await readEpub(output)).cover).toEqual(cover);
    const zip = await JSZip.loadAsync(output);
    const opf = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
    expect(opf.getElementsByTagName('itemref')[0].getAttribute('idref')).toBe('cover-page');
    expect(opf.querySelector('meta[name="cover"]')?.getAttribute('content')).toBe('cover-image');
    expect(Array.from(opf.getElementsByTagName('item')).filter(item => item.getAttribute('properties') === 'cover-image')).toHaveLength(1);
    expect(await zip.file('OEBPS/cover.xhtml')!.async('string')).toContain('images/cover.png');
    expect(await zip.file('OEBPS/page-1.xhtml')!.async('string')).toContain('First line of a paragraph');
  }
}, 30_000);

it('preserves mixed-script Unicode and language tags in both EPUB and actual KEPUB output', async () => {
  const pdf = new Uint8Array(await readFile('tests/fixtures/mixed-scripts.pdf'));
  const task = getDocument({ data: pdf.slice() });
  try {
    const source = await task.promise;
    const text = await (await source.getPage(1)).getTextContent();
    const characters = text.items.flatMap(item => 'str' in item ? [item.str] : []).join('').replace(/\s/g, '');
    expect(characters).toContain('中文日本語ひらがなカタカナ');
    expect(characters).toContain('ภาษาไทยสวัสดี');
  } finally { await task.destroy(); }
  const epub = await pdfToEpub(pdf, emptyMetadata('Mixed scripts'), vi.fn());
  const zip = await JSZip.loadAsync(epub);
  const image = await zip.file('OEBPS/images/page-1.jpg')!.async('uint8array');
  expect(image.byteLength).toBeGreaterThan(5000);
  const page = await zip.file('OEBPS/page-1.xhtml')!.async('string');
  expect(page).not.toContain('<img');
  const parsed = new dom.window.DOMParser().parseFromString(page, 'application/xml');
  expect(parsed.querySelector('parsererror')).toBeNull();
  expect(parsed.documentElement.textContent?.replace(/\s/g, '')).toContain('ภาษาไทยสวัสดี');
  for (const language of ['ja', 'ko', 'th']) expect(page).toContain(`lang="${language}" xml:lang="${language}"`);
  expect(page).not.toContain('\ufffd');
  const kepub = await JSZip.loadAsync(await kepubWithWasm(epub));
  expect(await kepub.file('OEBPS/images/page-1.jpg')!.async('uint8array')).toEqual(image);
  const converted = await kepub.file('OEBPS/page-1.xhtml')!.async('string');
  for (const language of ['ja', 'ko', 'th']) expect(converted).toContain(`lang="${language}"`);
  expect(converted).toContain('koboSpan');
  expect(new dom.window.DOMParser().parseFromString(converted, 'application/xml').documentElement.textContent?.replace(/\s/g, '')).toContain('ภาษาไทยสวัสดี');
  const metadata = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
  expect(Array.from(metadata.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')).map(node => node.textContent)).toEqual(expect.arrayContaining(['zh', 'ja', 'ko', 'th']));
}, 30_000);
