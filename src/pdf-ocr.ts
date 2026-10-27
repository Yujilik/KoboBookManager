import { createWorker, OEM, PSM, type Worker, type Page, type Bbox } from 'tesseract.js';
import { PDF_OCR_LANGUAGES, type PdfOcrLanguage } from './pdf-ocr-options';

export interface PdfOcrWord { text: string; confidence: number; bbox: Bbox }
export interface PdfOcrLine extends PdfOcrWord { words: PdfOcrWord[] }
export interface PdfOcrResult { text: string; confidence: number; lines: PdfOcrLine[]; figures?: { bbox: Bbox }[] }
export interface PdfOcr {
  recognize(canvas: HTMLCanvasElement): Promise<PdfOcrResult>;
  close(): Promise<void>;
}
const TIMEOUT = 120_000;
const failure = (cause?: unknown) => new Error('pdfOcrFailed', { cause });
const confidence = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

function bounds(value: Bbox | undefined, width: number, height: number): Bbox | undefined {
  if (!value || ![value.x0, value.y0, value.x1, value.y1].every(Number.isFinite)) return;
  const bbox = { x0: Math.max(0, value.x0), y0: Math.max(0, value.y0), x1: Math.min(width, value.x1), y1: Math.min(height, value.y1) };
  return bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0 ? bbox : undefined;
}

function result(data: Page, width: number, height: number): PdfOcrResult {
  const lines: PdfOcrLine[] = [], figures: { bbox: Bbox }[] = [];
  for (const block of data.blocks ?? []) {
    const image = !block.text?.trim() && /^(?:(?:FLOWING|HEADING|PULLOUT)_)?IMAGE$/i.test(block.blocktype || '');
    const box = image && bounds(block.bbox, width, height);
    if (box) figures.push({ bbox: box });
    for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
      const text = line.text?.trim(), bbox = bounds(line.bbox, width, height);
      if (!text || !bbox) continue;
      const words: PdfOcrWord[] = [];
      for (const word of line.words ?? []) {
        const wordBox = bounds(word.bbox, width, height), wordText = word.text?.trim();
        if (wordText && wordBox) words.push({ text: wordText, confidence: confidence(word.confidence), bbox: wordBox });
      }
      lines.push({ text, confidence: confidence(line.confidence), bbox, words });
    }
  }
  const text = data.text?.trim() || '';
  if (text && !lines.length) throw failure('OCR returned text without usable layout');
  return { text, confidence: confidence(data.confidence), lines, ...(figures.length ? { figures } : {}) };
}

/** One offline worker for a whole conversion, reusing its language models across pages. */
export async function createPdfOcr(languages: PdfOcrLanguage[], onProgress?: (value: number) => void): Promise<PdfOcr> {
  const selected = [...new Set(languages)];
  if (!selected.length || selected.some(language => !PDF_OCR_LANGUAGES.includes(language))) throw failure('Invalid OCR languages');
  let worker: Worker | undefined, closed = false, busy = false;
  let termination: Promise<void> | undefined, cancel: ((error: Error) => void) | undefined;
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_, reject) => { rejectFatal = reject; });
  // A worker can report an error between pages. Keep it available to the next
  // guarded operation without creating an unhandled rejection in the meantime.
  void fatal.catch(() => undefined);
  async function terminate() {
    if (worker && !termination) termination = worker.terminate().then(() => undefined, () => undefined);
    await termination;
  }
  async function close() {
    closed = true; cancel?.(failure('OCR worker closed')); await terminate();
  }
  async function guarded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canceled = new Promise<never>((_, reject) => {
      cancel = reject;
      timer = setTimeout(() => reject(failure('OCR operation timed out')), TIMEOUT);
    });
    try { return await Promise.race([operation, canceled, fatal]); }
    finally { clearTimeout(timer); cancel = undefined; }
  }
  const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const assets = new URL(browser ? 'vendor/ocr/' : '../public/vendor/ocr/', browser ? document.baseURI : import.meta.url);
  const options = {
    langPath: browser ? new URL('langs/', assets).href : decodeURIComponent(new URL('langs/', assets).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
    ...(browser ? { workerPath: new URL('worker.min.js', assets).href, corePath: new URL('core/', assets).href, workerBlobURL: false } : {}),
    // Android's asset packager transparently expands .gz assets and strips the
    // suffix. Bundle raw traineddata explicitly so browser and APK paths agree.
    gzip: false, cacheMethod: 'none', legacyCore: false, legacyLang: false,
    logger: (message: { status: string; progress: number }) => {
      if (!closed && message.status === 'recognizing text' && Number.isFinite(message.progress)) onProgress?.(confidence(message.progress * 100));
    },
    errorHandler: (error: unknown) => { rejectFatal(failure(error)); void close(); },
  };
  // The public Tesseract factory resolves after loading. If initialization times
  // out, terminate a late-created worker instead of letting it survive a retry.
  const creating = createWorker(selected, OEM.LSTM_ONLY, options);
  void creating.then(created => { worker = created; if (closed) void terminate(); }, () => undefined);
  try {
    worker = await guarded(creating);
    if (closed) throw failure('OCR initialization canceled');
    await guarded(worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '300' }));
  } catch (error) { await close(); throw failure(error); }
  return {
    async recognize(canvas) {
      if (closed || busy) throw failure(closed ? 'OCR worker closed' : 'OCR already in progress');
      if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height) || canvas.width <= 0 || canvas.height <= 0 || canvas.width * canvas.height > 12_000_000) throw failure('Invalid OCR canvas');
      busy = true;
      try {
        const operation = (async () => {
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(failure('OCR image encoding failed')), 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (closed) throw failure('OCR worker closed');
          // Both browser and Node Tesseract adapters accept encoded image bytes;
          // passing them directly avoids base64 copies and FileReader dependence.
          const input = bytes as unknown as Parameters<Worker['recognize']>[0];
          return worker!.recognize(input, {}, { text: true, blocks: true });
        })();
        const recognized = await guarded(operation);
        if (closed) throw failure('OCR worker closed');
        return result(recognized.data, canvas.width, canvas.height);
      } catch (error) { await close(); throw failure(error); }
      finally { busy = false; }
    },
    close,
  };
}
