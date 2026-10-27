// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorker, type Worker } from 'tesseract.js';
import { createPdfOcr } from '../src/pdf-ocr';
import type { PdfOcrLanguage } from '../src/pdf-ocr-options';

vi.mock('tesseract.js', () => ({ createWorker: vi.fn(), OEM: { LSTM_ONLY: 1 }, PSM: { AUTO: '3', SINGLE_LINE: '7', SINGLE_CHAR: '10' } }));
const response = () => ({ data: { text: '日本語 sample\n', confidence: 87, blocks: [{ blocktype: 'FLOWING_TEXT', text: '日本語 sample', bbox: { x0: 4, y0: 10, x1: 94, y1: 30 }, paragraphs: [{ lines: [{ text: '日本語 sample\n', confidence: 92, bbox: { x0: 4, y0: 10, x1: 94, y1: 30 }, words: [{ text: '日本語', confidence: 89, bbox: { x0: 4, y0: 10, x1: 44, y1: 30 } }, { text: 'sample', confidence: 95, bbox: { x0: 48, y0: 10, x1: 94, y1: 30 } }] }] }] }] } });
const canvas = () => ({ width: 100, height: 200, toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })) }) as unknown as HTMLCanvasElement;
let worker: { setParameters: ReturnType<typeof vi.fn>; recognize: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('document', { baseURI: 'https://localhost/' });
  vi.stubGlobal('window', {});
  worker = { setParameters: vi.fn().mockResolvedValue({}), recognize: vi.fn().mockResolvedValue(response()), terminate: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(createWorker).mockResolvedValue(worker as unknown as Worker);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses bundled worker/core/models and reuses one LSTM worker across pages, returning real pixel layout', async () => {
  const ocr = await createPdfOcr(['eng', 'jpn', 'eng']);
  expect(createWorker).toHaveBeenCalledOnce();
  expect(createWorker).toHaveBeenCalledWith(['eng', 'jpn'], 1, expect.objectContaining({ workerPath: 'https://localhost/vendor/ocr/worker.min.js', corePath: 'https://localhost/vendor/ocr/core/', langPath: 'https://localhost/vendor/ocr/langs/', gzip: false, workerBlobURL: false, legacyCore: false, legacyLang: false, cacheMethod: 'none' }));
  expect(worker.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '3', user_defined_dpi: '300' });
  const first = await ocr.recognize(canvas()); await ocr.recognize(canvas());
  expect(first).toMatchObject({ text: '日本語 sample', confidence: 87, lines: [{ text: '日本語 sample', confidence: 92, bbox: { x0: 4, y0: 10, x1: 94, y1: 30 }, words: [{ text: '日本語' }, { text: 'sample' }] }] });
  expect(worker.recognize).toHaveBeenCalledTimes(2);
  expect(worker.recognize.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  expect(worker.recognize.mock.calls[0][2]).toEqual({ text: true, blocks: true, hocr: true });
  await ocr.close(); await ocr.close(); expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects empty or unsupported language selections before starting a worker', async () => {
  await expect(createPdfOcr([])).rejects.toThrow('pdfOcrFailed');
  await expect(createPdfOcr(['unsupported'] as unknown as PdfOcrLanguage[])).rejects.toThrow('pdfOcrFailed');
  expect(createWorker).not.toHaveBeenCalled();
});

it('bounds region retries to the requested mode and restores page settings for the next recognition', async () => {
  const ocr = await createPdfOcr(['eng']);
  await ocr.recognize(canvas(), { mode: 'character', characters: 'ABC' });
  expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: 'ABC' });
  await ocr.recognize(canvas(), { mode: 'line' });
  expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
  await ocr.recognize(canvas());
  expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  await ocr.close();
});

it('treats a genuinely blank page as empty and only reports image blocks explicitly identified by the engine', async () => {
  worker.recognize.mockResolvedValue({ data: { text: '', confidence: 0, blocks: [{ blocktype: 'FLOWING_IMAGE', text: '', bbox: { x0: 0, y0: 0, x1: 100, y1: 180 } }] } });
  const ocr = await createPdfOcr(['jpn']);
  expect(await ocr.recognize(canvas())).toEqual({ text: '', confidence: 0, lines: [], figures: [{ bbox: { x0: 0, y0: 0, x1: 100, y1: 180 } }] });
  await ocr.close();
});

it('stops failed recognition instead of returning a successful empty conversion', async () => {
  worker.recognize.mockRejectedValue(new Error('WASM crashed'));
  const ocr = await createPdfOcr(['eng']);
  await expect(ocr.recognize(canvas())).rejects.toThrow('pdfOcrFailed');
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(ocr.recognize(canvas())).rejects.toThrow('pdfOcrFailed');
});

it('rejects text without valid geometry instead of fabricating a page layout', async () => {
  worker.recognize.mockResolvedValue({ data: { text: 'Unplaced text', confidence: 80, blocks: [] } });
  const ocr = await createPdfOcr(['eng']);
  await expect(ocr.recognize(canvas())).rejects.toThrow('pdfOcrFailed');
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('bounds each page independently and terminates a stalled operation', async () => {
  vi.useFakeTimers();
  worker.recognize.mockReturnValue(new Promise(() => undefined));
  const ocr = await createPdfOcr(['jpn']);
  const failed = expect(ocr.recognize(canvas())).rejects.toThrow('pdfOcrFailed');
  await vi.advanceTimersByTimeAsync(120_000); await failed;
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('cancels an active page promptly when the conversion closes', async () => {
  worker.recognize.mockReturnValue(new Promise(() => undefined));
  const ocr = await createPdfOcr(['eng']);
  const pending = ocr.recognize(canvas()); const failed = expect(pending).rejects.toThrow('pdfOcrFailed');
  await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
  await ocr.close(); await failed; expect(worker.terminate).toHaveBeenCalledOnce();
});

it('terminates a late initialized worker after startup times out and does not leak stale progress', async () => {
  vi.useFakeTimers();
  let ready!: (worker: Worker) => void;
  vi.mocked(createWorker).mockReturnValue(new Promise(resolve => { ready = resolve; }));
  const progress = vi.fn();
  const pending = createPdfOcr(['eng'], progress); const failed = expect(pending).rejects.toThrow('pdfOcrFailed');
  await vi.advanceTimersByTimeAsync(120_000); await failed;
  ready(worker as unknown as Worker); await vi.advanceTimersByTimeAsync(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  const options = vi.mocked(createWorker).mock.calls[0][2]!;
  options.logger!({ status: 'recognizing text', progress: .9 } as never);
  expect(progress).not.toHaveBeenCalled();
});

it('reports bounded recognition progress while ignoring model loading and invalid percentages', async () => {
  const progress = vi.fn(); const ocr = await createPdfOcr(['eng'], progress);
  const logger = vi.mocked(createWorker).mock.calls[0][2]!.logger!;
  logger({ status: 'loading language traineddata', progress: .5 } as never);
  logger({ status: 'recognizing text', progress: .25 } as never);
  logger({ status: 'recognizing text', progress: 2 } as never);
  logger({ status: 'recognizing text', progress: NaN } as never);
  expect(progress.mock.calls.map(call => call[0])).toEqual([25, 100]);
  await ocr.close();
});
