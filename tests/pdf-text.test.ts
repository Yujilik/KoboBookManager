// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { createPdfTextSource } from '../src/pdf-text';
import { createPdfOcr, type PdfOcr, type PdfOcrResult } from '../src/pdf-ocr';
import { emptyMetadata } from '../src/epub';
import { reflowText } from '../src/pdf-reflow';

vi.mock('../src/pdf-ocr', () => ({ createPdfOcr: vi.fn() }));
const content = (str = ''): TextContent => ({ items: str ? [{ str, dir: 'ltr', width: str.length * 6, height: 12, transform: [12, 0, 0, 12, 20, 500], fontName: 'existing-font', hasEOL: true } as TextItem] : [], styles: {}, lang: null });
const body = 'An existing readable paragraph with enough real text to reuse.';
const recognized = (text = 'Recognized text from a scanned page with useful readable words.'): PdfOcrResult => ({
  text, confidence: 92,
  lines: text ? [{ text, confidence: 92, bbox: { x0: 40, y0: 80, x1: 240, y1: 120 }, words: [{ text, confidence: 92, bbox: { x0: 40, y0: 80, x1: 240, y1: 120 } }] }] : [],
});
type MockCanvas = HTMLCanvasElement & { blank?: boolean };
let canvases: MockCanvas[], worker: { recognize: Mock<PdfOcr['recognize']>; close: Mock<PdfOcr['close']> };
beforeEach(() => {
  vi.resetAllMocks(); canvases = [];
  worker = { recognize: vi.fn<PdfOcr['recognize']>().mockResolvedValue(recognized()), close: vi.fn<PdfOcr['close']>().mockResolvedValue(undefined) };
  vi.mocked(createPdfOcr).mockResolvedValue(worker);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unit recognition must not request the network'); }));
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, blank: false, toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })) } as MockCanvas;
    const context = {
      drawImage: vi.fn(), getImageData: vi.fn(() => {
        const data = new Uint8ClampedArray(64 * 4);
        for (let index = 0; index < data.length; index += 4) { data[index] = data[index + 1] = data[index + 2] = canvas.blank ? 255 : 0; data[index + 3] = 255; }
        return { data };
      }),
    };
    canvas.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext']; canvases.push(canvas); return canvas;
  } });
});
afterEach(() => vi.unstubAllGlobals());

function page(text = '', options: { raster?: boolean; vector?: boolean; blank?: boolean; rotate?: boolean } = {}) {
  const source = content(text), fnArray = options.raster === false ? options.vector ? [OPS.constructPath] : [] : [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore];
  const argsArray = options.raster === false ? fnArray.map(() => []) : [[], [400, 0, 0, 600, 0, 0], ['scan'], []];
  const result = {
    view: [0, 0, 400, 600], getTextContent: vi.fn().mockResolvedValue(source), getOperatorList: vi.fn().mockResolvedValue({ fnArray, argsArray, lastChunk: true }), cleanup: vi.fn(),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale,
      convertToPdfPoint: (x: number, y: number) => options.rotate ? [y / scale, x / scale] : [x / scale, 600 - y / scale],
    })),
    render: vi.fn(({ canvas }: { canvas: MockCanvas }) => { canvas.blank = options.blank; return { promise: Promise.resolve(), cancel: vi.fn() }; }),
  };
  return result as unknown as PDFPageProxy & typeof result;
}
function document(pages: PDFPageProxy[]) { return { numPages: pages.length, getPage: vi.fn(async (number: number) => pages[number - 1]) } as unknown as PDFDocumentProxy; }

describe('PDF text extraction and offline recognition selection', () => {
  it('recognizes scans even when the final catalog page contains readable metadata, reusing one worker', async () => {
    const pages = [...Array.from({ length: 11 }, () => page()), page('Catalog metadata: title, author, language and page count.')];
    const progress = vi.fn(); let notify: ((value: number) => void) | undefined;
    vi.mocked(createPdfOcr).mockImplementation(async (_languages, report) => { notify = report; report?.(25); return worker; });
    worker.recognize.mockImplementation(async () => { notify?.(50); return recognized(); });
    const source = await createPdfTextSource(document(pages), emptyMetadata('Scanned book'), { ocrLanguages: ['eng', 'jpn'] }, progress);
    for (let number = 1; number <= pages.length; number++) await source.read(pages[number - 1], number);
    expect(createPdfOcr).toHaveBeenCalledOnce();
    expect(createPdfOcr).toHaveBeenCalledWith(['eng', 'jpn'], expect.any(Function));
    expect(worker.recognize).toHaveBeenCalledTimes(11);
    expect(source.recognized(1)).toBe(true); expect(source.recognized(12)).toBe(false); expect(source.usesOcr).toBe(true);
    expect(source.verify()).toBeUndefined();
    await source.read(pages[0], 1); expect(worker.recognize).toHaveBeenCalledTimes(11);
    const recognitionUpdates = progress.mock.calls.filter(([, stage]) => stage === 'ocr');
    expect(recognitionUpdates.length).toBeGreaterThan(0);
    expect(recognitionUpdates.every(([value]) => value >= 5 && value <= 70)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
    await source.close(); expect(worker.close).toHaveBeenCalledOnce();
  });

  it('leaves a mostly textual book with three cover/picture pages on its reliable extraction path', async () => {
    const pages = [...Array.from({ length: 3 }, () => page()), ...Array.from({ length: 9 }, () => page(body, { raster: false }))];
    const source = await createPdfTextSource(document(pages), emptyMetadata('Text book'), {}, vi.fn());
    for (let number = 1; number <= pages.length; number++) {
      const result = await source.read(pages[number - 1], number);
      expect(result).toBe(await pages[number - 1].getTextContent());
    }
    expect(createPdfOcr).not.toHaveBeenCalled(); expect(source.usesOcr).toBe(false);
    expect(pages.every(value => !vi.mocked(value.render).mock.calls.length)).toBe(true);
    await source.close(); expect(worker.close).not.toHaveBeenCalled();
  });

  it('reuses existing searchable OCR text without recognizing the scanned page again', async () => {
    const existing = page(body);
    existing.getTextContent.mockResolvedValue({ ...content(body), styles: { 'existing-font': { fontFamily: 'GlyphLessFont', ascent: .9, descent: -.2, vertical: false } } });
    const source = await createPdfTextSource(document([existing]), emptyMetadata('Searchable scan'), {}, vi.fn());
    const result = await source.read(existing, 1);
    expect(result.items[0]).toMatchObject({ str: body });
    expect(existing.render).not.toHaveBeenCalled(); expect(createPdfOcr).not.toHaveBeenCalled();
    await source.close();
  });

  it('preserves short valid text beside vector artwork instead of needlessly running OCR', async () => {
    const short = page('Brief but valid text.', { raster: false, vector: true });
    const source = await createPdfTextSource(document([short]), emptyMetadata('Short text'), {}, vi.fn());
    expect(await source.read(short, 1)).toBe(await short.getTextContent());
    expect(short.render).not.toHaveBeenCalled(); expect(createPdfOcr).not.toHaveBeenCalled();
    await source.close();
  });

  it('recognizes unreadable mappings even in an otherwise valid text book', async () => {
    const pages = [...Array.from({ length: 9 }, () => page(body)), page('\uE001\uFFFD broken map', { raster: false, vector: true })];
    const source = await createPdfTextSource(document(pages), { ...emptyMetadata('Japanese book'), language: 'ja' }, {}, vi.fn());
    const result = await source.read(pages[9], 10);
    expect(result.items[0]).toMatchObject({ str: recognized().text });
    expect(source.recognized(10)).toBe(true);
    expect(createPdfOcr).toHaveBeenCalledWith(['eng', 'jpn', 'chi_sim', 'kor'], expect.any(Function));
    await source.close();
  });

  it('does not initialize recognition for a genuinely blank scan', async () => {
    const blank = page('', { blank: true });
    const source = await createPdfTextSource(document([blank]), emptyMetadata('Blank scan'), {}, vi.fn());
    expect((await source.read(blank, 1)).items).toHaveLength(0);
    expect(createPdfOcr).not.toHaveBeenCalled(); expect(source.recognized(1)).toBe(false);
    await source.close();
  });

  it('stops persistent empty recognition instead of allowing a large image-only book to pass', async () => {
    worker.recognize.mockResolvedValue(recognized(''));
    const pages = Array.from({ length: 12 }, () => page());
    const source = await createPdfTextSource(document(pages), emptyMetadata('Unreadable scan'), { ocrLanguages: ['eng'] }, vi.fn());
    for (let index = 0; index < 10; index++) await source.read(pages[index], index + 1);
    expect(() => source.verify()).toThrow('pdfOcrFailed'); expect(source.recognized(1)).toBe(false);
    await source.close(); expect(worker.close).toHaveBeenCalledOnce();
  });

  it('propagates failed recognition, releases page canvases and allows its worker to close', async () => {
    worker.recognize.mockRejectedValue(new Error('Recognition engine failed'));
    const scan = page(), source = await createPdfTextSource(document([scan]), emptyMetadata('Failure'), {}, vi.fn());
    await expect(source.read(scan, 1)).rejects.toThrow('pdfOcrFailed');
    expect(source.recognized(1)).toBe(false); expect(scan.cleanup).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
    await source.close(); expect(worker.close).toHaveBeenCalledOnce();
  });

  it('rejects an unreadable character map when recognition produces no replacement text', async () => {
    worker.recognize.mockResolvedValue(recognized(''));
    const broken = page('\uE001\uFFFD', { raster: false, vector: true });
    const source = await createPdfTextSource(document([broken]), emptyMetadata('Broken text map'), {}, vi.fn());
    await expect(source.read(broken, 1)).rejects.toThrow('pdfOcrFailed');
    expect(source.recognized(1)).toBe(false);
    await source.close();
  });

  it('retains bounded illustrations detected by OCR separately from its reflowable text', async () => {
    worker.recognize.mockResolvedValue({ ...recognized(), figures: [
      { bbox: { x0: 100, y0: 100, x1: 300, y1: 200 } },
      { bbox: { x0: 0, y0: 0, x1: 1600, y1: 2400 } },
      { bbox: { x0: 10, y0: 10, x1: 15, y1: 15 } },
    ] });
    const scan = page(), source = await createPdfTextSource(document([scan]), emptyMetadata('Illustrated scan'), {}, vi.fn());
    await source.read(scan, 1);
    expect(source.figures(1)).toMatchObject([{ width: 200, height: 100, mime: 'image/png' }]);
    expect([...source.figures(1)[0].bytes]).toEqual([137, 80, 78, 71]);
    expect(source.figures(2)).toEqual([]);
    expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
    await source.close();
  });

  it('closes one reused worker and rejects a new pending page after close', async () => {
    const pages = [page(), page()], source = await createPdfTextSource(document(pages), emptyMetadata('Two scans'), { ocrLanguages: ['eng'] }, vi.fn());
    await source.read(pages[0], 1); await source.close();
    await expect(source.read(pages[1], 2)).rejects.toThrow('pdfOcrFailed');
    expect(worker.recognize).toHaveBeenCalledOnce(); expect(worker.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('maps OCR pixel bounds back into PDF source coordinates (rotated: %s)', async rotate => {
    worker.recognize.mockResolvedValue(recognized('word'));
    const scan = page('', { rotate }), source = await createPdfTextSource(document([scan]), emptyMetadata('Coordinates'), {}, vi.fn());
    const result = await source.read(scan, 1), first = result.items[0] as TextItem;
    expect(first).toMatchObject({ str: 'word', width: 50, height: 10, fontName: 'offline-ocr', hasEOL: true });
    expect(first.transform).toEqual(rotate ? [0, 10, -10, 0, 30, 10] : [10, 0, -0, 10, 10, 570]);
    await source.close();
  });

  it('preserves the logical space between tightly positioned OCR words when they reflow', async () => {
    worker.recognize.mockResolvedValue({ text: 'Hello world', confidence: 90, lines: [{ text: 'Hello world', confidence: 90, bbox: { x0: 40, y0: 80, x1: 242, y1: 120 }, words: [
      { text: 'Hello', confidence: 90, bbox: { x0: 40, y0: 80, x1: 140, y1: 120 } },
      { text: 'world', confidence: 90, bbox: { x0: 142, y0: 80, x1: 242, y1: 120 } },
    ] }] });
    const scan = page(), source = await createPdfTextSource(document([scan]), emptyMetadata('Word spacing'), {}, vi.fn());
    const result = await source.read(scan, 1);
    expect(reflowText(result.items as TextItem[], 'en', new Set())).toContain('Hello world');
    await source.close();
  });
});
