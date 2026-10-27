import { OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Metadata } from './types';
import { defaultOcrLanguages, type PdfConversionOptions } from './pdf-ocr-options';
import type { PdfOcr, PdfOcrLine } from './pdf-ocr';
import { extractPageImages, type PdfFigure } from './pdf-images';
import { textLanguage, lineSeparator } from './pdf-language';

const badText = /[\uFFFD\p{Private_Use}\p{Surrogate}\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const artwork = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.constructPath]);
const countText = (text: TextContent) => text.items.reduce((count, item) => count + ('str' in item ? item.str.replace(/\s/g, '').length : 0), 0);
const unreliable = (text: TextContent) => text.items.some(item => 'str' in item && badText.test(item.str));
const emptyText = (): TextContent => ({ items: [], styles: {}, lang: null });
type Progress = (value: number, stage?: 'ocr') => void;

export interface PdfTextSource {
  read(page: PDFPageProxy, number: number): Promise<TextContent>;
  recognized(number: number): boolean;
  figures(number: number): PdfFigure[];
  close(): Promise<void>;
  verify(): void;
  readonly usesOcr: boolean;
}

function ocrItems(lines: PdfOcrLine[], viewport: ReturnType<PDFPageProxy['getViewport']>): TextItem[] {
  const result: TextItem[] = [];
  for (const line of lines) {
    const words = line.words.length ? line.words : [{ text: line.text, confidence: line.confidence, bbox: line.bbox }];
    let textOffset = 0, previous: TextItem | undefined;
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (!word.text.trim() || badText.test(word.text)) continue;
      const wordOffset = line.text.indexOf(word.text, textOffset);
      if (previous && wordOffset >= textOffset && /\s/u.test(line.text.slice(textOffset, wordOffset)) && lineSeparator(previous.str.trim(), word.text) === ' ') previous.str += ' ';
      if (wordOffset >= 0) textOffset = wordOffset + word.text.length;
      const b = word.bbox;
      const origin = viewport.convertToPdfPoint(b.x0, b.y1);
      const right = viewport.convertToPdfPoint(b.x1, b.y1);
      const top = viewport.convertToPdfPoint(b.x0, b.y0);
      const width = Math.hypot(right[0] - origin[0], right[1] - origin[1]);
      const height = Math.hypot(top[0] - origin[0], top[1] - origin[1]);
      if (!width || !height) continue;
      const dx = (right[0] - origin[0]) / width, dy = (right[1] - origin[1]) / width;
      const item: TextItem = { str: word.text, dir: 'ltr', width, height,
        transform: [dx * height, dy * height, -dy * height, dx * height, origin[0], origin[1]],
        fontName: 'offline-ocr', hasEOL: index === words.length - 1 };
      result.push(item); previous = item;
    }
  }
  return result;
}

async function croppedFigure(canvas: HTMLCanvasElement, bbox: { x0: number; y0: number; x1: number; y1: number }): Promise<PdfFigure | undefined> {
  const x = Math.max(0, Math.floor(bbox.x0)), y = Math.max(0, Math.floor(bbox.y0));
  const width = Math.min(canvas.width - x, Math.ceil(bbox.x1) - x), height = Math.min(canvas.height - y, Math.ceil(bbox.y1) - y);
  if (width < 16 || height < 16 || width * height > canvas.width * canvas.height * 0.8) return;
  const crop = document.createElement('canvas'); crop.width = width; crop.height = height;
  try {
    const context = crop.getContext('2d'); if (!context) throw new Error('pdfOcrFailed');
    context.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => crop.toBlob(value => value ? resolve(value) : reject(new Error('pdfOcrFailed')), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width, height };
  } finally { crop.width = crop.height = 0; }
}

/** Reuse valid text, recognizing scans before chapter/link detection needs their words and coordinates. */
export async function createPdfTextSource(pdf: PDFDocumentProxy, metadata: Metadata, options: PdfConversionOptions, progress: Progress): Promise<PdfTextSource> {
  const cached = new Map<number, TextContent>(), extractedFigures = new Map<number, PdfFigure[]>();
  let meaningfulPages = 0;
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const text = await page.getTextContent({ disableNormalization: true }).catch(() => emptyText());
    cached.set(number, text);
    if (countText(text) >= 32 && !unreliable(text)) meaningfulPages++;
    progress(Math.round(number / pdf.numPages * 5));
  }
  // A mostly scanned book can have a text-only catalog notice at the end. That
  // notice must not turn hundreds of scanned pages into a false reflow success.
  const mostlyScanned = meaningfulPages < pdf.numPages * 0.7;
  const candidates = new Set([...cached].filter(([, text]) => unreliable(text) || mostlyScanned && countText(text) < 32).map(([number]) => number));
  const candidateCount = candidates.size;
  const recognized = new Set<number>(), attempted = new Set<number>();
  const languages = options.ocrLanguages ?? defaultOcrLanguages(metadata);
  let worker: PdfOcr | undefined, completed = 0, closed = false;
  const report = (fraction: number) => progress(Math.round(5 + (completed + Math.max(0, Math.min(1, fraction))) / Math.max(1, candidateCount) * 65), 'ocr');
  async function read(page: PDFPageProxy, number: number): Promise<TextContent> {
    if (!candidates.has(number) || attempted.has(number)) return cached.get(number)!;
    if (closed) throw new Error('pdfOcrFailed');
    const original = cached.get(number)!;
    const operations = await page.getOperatorList();
    const raster = operations.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup].includes(op));
    if (!unreliable(original) && (!operations.fnArray.some(op => artwork.has(op)) || countText(original) > 0 && !raster)) {
      candidates.delete(number); completed++; return original;
    }
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2400 / Math.max(base.width, base.height), Math.sqrt(4_000_000 / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      const context = canvas.getContext('2d'); if (!context) throw new Error('pdfOcrFailed');
      const render = page.render({ canvas, canvasContext: context, viewport, background: 'white' });
      const timeout = setTimeout(() => render.cancel(), 60_000);
      try { await render.promise; } finally { clearTimeout(timeout); }
      // Avoid loading OCR for truly blank image pages, which are common in scans.
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, samples = 0;
      for (let offset = 0; offset < pixels.length; offset += 64) { samples++; if (Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 220) ink++; }
      if (ink / samples < 0.0002) { cached.set(number, emptyText()); attempted.add(number); completed++; return emptyText(); }
      if (!worker) { const { createPdfOcr } = await import('./pdf-ocr'); worker = await createPdfOcr(languages, value => report(value / 100)); }
      const result = await worker.recognize(canvas);
      const items = ocrItems(result.lines, viewport);
      const text: TextContent = { items, styles: { 'offline-ocr': { fontFamily: 'serif', ascent: 0.9, descent: -0.2, vertical: false } }, lang: metadata.language || textLanguage(result.text, 'und') };
      if (unreliable(original) && !items.length) throw new Error('pdfOcrFailed');
      const figures: PdfFigure[] = await extractPageImages(page, operations, { omitPageBackground: true });
      for (const figure of result.figures || []) { const image = await croppedFigure(canvas, figure.bbox); if (image) figures.push(image); }
      extractedFigures.set(number, figures); cached.set(number, text); attempted.add(number); if (items.length) recognized.add(number); completed++; report(0);
      return text;
    } catch (error) { throw new Error('pdfOcrFailed', { cause: error }); }
    finally { canvas.width = canvas.height = 0; page.cleanup(); }
  }
  return {
    read, recognized: number => recognized.has(number), figures: number => extractedFigures.get(number) || [],
    get usesOcr() { return attempted.size > 0; },
    verify() {
      if (mostlyScanned && attempted.size >= 10 && [...recognized].filter(number => countText(cached.get(number)!) >= 32).length < 3) throw new Error('pdfOcrFailed');
    },
    async close() { closed = true; await worker?.close(); },
  };
}
