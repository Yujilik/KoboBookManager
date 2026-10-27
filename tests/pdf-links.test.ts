// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import { PDFDocument, PDFName, PDFString, type PDFArray } from 'pdf-lib';
import JSZip from 'jszip';
import { pdfToEpub } from '../src/pdf';
import { emptyMetadata } from '../src/epub';
import { pdfFixture } from './pdf-fixture';
import { kepubWithWasm } from './kepub-fixture';

// These tests verify link migration; recognition quality has separate real-worker checks.
vi.mock('../src/pdf-ocr', () => ({ createPdfOcr: vi.fn(async () => ({
  recognize: async () => ({ text: '', confidence: 100, lines: [] }), close: async () => undefined,
})) }));

const dom = new JSDOM();
beforeAll(() => {
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('document', { createElement: () => {
    const canvas = createCanvas(1, 1);
    return Object.assign(canvas, { toBlob: (callback: (value: Blob) => void, mime = 'image/jpeg') => callback(new Blob([new Uint8Array(mime === 'image/png' ? canvas.encodeSync('png') : canvas.encodeSync('jpeg', 94))], { type: mime })) });
  } });
});
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

async function linkedPdf() {
  const pdf = await PDFDocument.load(pdfFixture([
    'BT /F1 22 Tf 40 750 Td (Contents) Tj /F1 12 Tf 0 -70 Td (Chapter One & notes) Tj 0 -30 Td (Chapter Two) Tj ET',
    'BT /F1 22 Tf 40 700 Td (Chapter One & notes) Tj /F1 12 Tf 0 -60 Td (Visit website) Tj 0 -40 Td (Read lower section) Tj 0 -200 Td (Lower section destination) Tj ET',
    'BT /F1 22 Tf 40 700 Td (Chapter Two) Tj /F1 12 Tf 0 -60 Td (Back to contents) Tj 0 -40 Td (Unsafe link) Tj ET',
  ]));
  const pages = pdf.getPages(), n = PDFName.of;
  const destination = (page: number, y: number) => pdf.context.obj([pages[page - 1].ref, n('XYZ'), 40, y, null]);
  pdf.catalog.set(n('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('lower-section'), destination(2, 400)] } }));
  const annotation = (rect: number[], action: { S: string; D?: PDFArray | PDFString; URI?: PDFString }) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: action }));
  pages[0].node.set(n('Annots'), pdf.context.obj([
    annotation([40, 676, 180, 692], { S: 'GoTo', D: destination(2, 700) }),
    annotation([40, 646, 140, 662], { S: 'GoTo', D: destination(3, 700) }),
  ]));
  pages[1].node.set(n('Annots'), pdf.context.obj([
    annotation([40, 636, 120, 652], { S: 'URI', URI: PDFString.of('https://example.org/read?one=1&two=2') }),
    annotation([40, 596, 150, 612], { S: 'GoTo', D: PDFString.of('lower-section') }),
    annotation([220, 300, 300, 380], { S: 'URI', URI: PDFString.of('https://example.org/figure') }),
  ]));
  pages[2].node.set(n('Annots'), pdf.context.obj([
    annotation([40, 636, 150, 652], { S: 'GoTo', D: destination(1, 750) }),
    annotation([40, 596, 150, 612], { S: 'URI', URI: PDFString.of('javascript:alert(1)') }),
  ]));
  const outlineRoot = pdf.context.obj({ Type: 'Outlines' }), outlineRef = pdf.context.register(outlineRoot);
  const lower = pdf.context.obj({ Title: PDFString.of('Lower section'), Dest: PDFString.of('lower-section') }), lowerRef = pdf.context.register(lower);
  const first = pdf.context.obj({ Title: PDFString.of('Chapter One & notes'), Parent: outlineRef, Dest: destination(2, 700), First: lowerRef, Last: lowerRef, Count: 1 }), firstRef = pdf.context.register(first);
  const second = pdf.context.obj({ Title: PDFString.of('Chapter Two'), Parent: outlineRef, Dest: destination(3, 700), Prev: firstRef }), secondRef = pdf.context.register(second);
  lower.set(n('Parent'), firstRef); first.set(n('Next'), secondRef);
  outlineRoot.set(n('First'), firstRef); outlineRoot.set(n('Last'), secondRef); outlineRoot.set(n('Count'), pdf.context.obj(3)); pdf.catalog.set(n('Outlines'), outlineRef);
  return pdf.save();
}

it('preserves clickable body links, named/coordinate destinations and chapter hierarchy through EPUB and actual KEPUB conversion', async () => {
  const input = await linkedPdf(), before = input.slice();
  const epub = await pdfToEpub(input, emptyMetadata('Linked book'), vi.fn());
  expect(input).toEqual(before);
  for (const bytes of [epub, await kepubWithWasm(epub)]) {
    const zip = await JSZip.loadAsync(bytes);
    const document = async (name: string) => new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/' + name)!.async('string'), 'application/xml');
    const toc = await document('nav.xhtml');
    expect(toc.querySelector('parsererror')).toBeNull();
    const main = toc.querySelector('nav')!;
    expect(main.textContent).toContain('Chapter One & notes');
    expect(main.textContent).toContain('Chapter Two');
    expect(main.querySelectorAll('li ol li a')).not.toHaveLength(0);
    expect(main.textContent).toContain('Lower section');
    const chapterOne = await document('page-2.xhtml');
    expect(chapterOne.querySelector('a[href="https://example.org/read?one=1&two=2"]')?.textContent).toBe('Visit website');
    expect(chapterOne.querySelector('a[href="https://example.org/figure"]')?.textContent).toBe('https://example.org/figure');
    const lowerLink = Array.from(chapterOne.querySelectorAll('a')).find(link => link.textContent?.includes('Read lower section'))!;
    expect(lowerLink).toBeDefined();
    const [lowerFile, lowerId] = lowerLink.getAttribute('href')!.split('#');
    expect(lowerFile === '' || lowerFile === 'page-2.xhtml').toBe(true);
    expect(chapterOne.getElementById(lowerId)?.textContent).toContain('Lower section destination');
    for (const page of ['page-1.xhtml', 'page-2.xhtml', 'page-3.xhtml', 'nav.xhtml']) {
      const source = await document(page);
      expect(source.querySelector('a a')).toBeNull();
      for (const link of Array.from(source.querySelectorAll('a'))) {
        const href = link.getAttribute('href')!;
        expect(href).not.toMatch(/javascript:|data:|file:/i);
        if (/^https?:/.test(href)) continue;
        const [file, id] = href.split('#');
        const target = await document(file || page);
        expect(id, href).toBeTruthy();
        expect(target.getElementById(id), href).not.toBeNull();
      }
    }
    const ncx = await document('toc.ncx');
    expect(ncx.querySelector('parsererror')).toBeNull();
    expect(ncx.querySelector('navPoint navPoint navLabel')?.textContent).toBe('Lower section');
  }
}, 30_000);

it('keeps a link over an image-only page clickable in EPUB and KEPUB', async () => {
  const pdf = await PDFDocument.load(pdfFixture(['BT /F1 12 Tf 40 700 Td (A readable beginning) Tj ET', '']));
  const imageCanvas = createCanvas(2, 2); imageCanvas.getContext('2d').fillRect(0, 0, 2, 2);
  const image = await pdf.embedPng(imageCanvas.encodeSync('png'));
  const pages = pdf.getPages(); pages[1].drawImage(image, { x: 40, y: 500, width: 80, height: 80 });
  const annotation = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 500, 120, 580], A: { S: 'GoTo', D: [pages[0].ref, PDFName.of('Fit')] } }));
  pages[1].node.set(PDFName.of('Annots'), pdf.context.obj([annotation]));
  const epub = await pdfToEpub(await pdf.save(), emptyMetadata('Image link'), vi.fn());
  for (const bytes of [epub, await kepubWithWasm(epub)]) {
    const zip = await JSZip.loadAsync(bytes);
    const doc = new dom.window.DOMParser().parseFromString(await zip.file('OEBPS/page-2.xhtml')!.async('string'), 'application/xml');
    expect(doc.querySelector('figure a[href="page-1.xhtml#pdf-page-1"] img')).not.toBeNull();
  }
}, 30_000);
