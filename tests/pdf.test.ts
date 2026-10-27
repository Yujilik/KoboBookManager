// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToEpub } from '../src/pdf';
import { emptyMetadata, readEpub } from '../src/epub';
import { pdfFixture } from './pdf-fixture';
import { kepubWithWasm } from './kepub-fixture';
import { coverFixture } from './cover-fixture';

const dom = new JSDOM();
beforeAll(() => {
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    return Object.assign(canvas, { toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(canvas.encodeSync('jpeg'))], { type: 'image/jpeg' })) });
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
  expect(await zip.file('OEBPS/nav.xhtml')!.async('string')).toContain('href="page-1.xhtml"');
  expect(progress.mock.calls.at(-1)).toEqual([100]);
}, 30_000);

it('keeps scans, blank pages and illustrations as page images instead of producing an empty EPUB or dropping graphics', async () => {
  const pdf = pdfFixture(['0.2 0.4 0.6 rg 40 550 300 200 re f', 'BT /F1 12 Tf 40 750 Td (Illustrated page) Tj ET 0.5 g 40 550 100 100 re f', '']);
  const epub = await pdfToEpub(pdf, emptyMetadata('Illustrated book'), vi.fn());
  const zip = await JSZip.loadAsync(epub);
  for (const number of [1, 2, 3]) {
    expect(await zip.file(`OEBPS/page-${number}.xhtml`)!.async('string')).toContain(`<img src="images/page-${number}.jpg"`);
    expect((await zip.file(`OEBPS/images/page-${number}.jpg`)!.async('uint8array')).byteLength).toBeGreaterThan(100);
  }
  const opf = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
  expect(opf.querySelector('parsererror')).toBeNull();
  expect(opf.getElementsByTagName('itemref').length).toBe(3);
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
