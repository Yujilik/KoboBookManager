// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PdfOcr, PdfOcrResult } from '../src/pdf-ocr';
import { repairOcrInitials } from '../src/pdf-ocr-repair';

const word = (text: string, x: number, y: number, width: number, height: number, confidence = 95) => ({ text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } });
function page(): PdfOcrResult {
  return { text: 't. and other words NN continuation text.', confidence: 92, lines: [
    { text: 't. and other words', confidence: 90, bbox: { x0: 80, y0: 100, x1: 300, y1: 130 }, words: [word('t.', 80, 110, 15, 15, 50), word('and', 100, 100, 40, 25), word('other', 150, 100, 60, 25), word('words', 220, 100, 80, 25)] },
    { text: 'NN continuation text.', confidence: 92, bbox: { x0: 20, y0: 95, x1: 300, y1: 175 }, words: [word('NN', 20, 95, 70, 80, 40), word('continuation', 95, 145, 120, 25), word('text.', 225, 145, 75, 25)] },
  ] };
}
const recognized = (text: string, confidence: number): PdfOcrResult => ({ text, confidence, lines: text ? [{ text, confidence, bbox: { x0: 0, y0: 0, x1: 30, y1: 30 }, words: [word(text, 0, 0, 30, 30, confidence)] }] : [] });
let canvases: HTMLCanvasElement[];
beforeEach(() => {
  canvases = [];
  vi.stubGlobal('document', { createElement: () => { const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }) } as unknown as HTMLCanvasElement; canvases.push(canvas); return canvas; } });
});
afterEach(() => vi.unstubAllGlobals());

it('recovers a decorated initial and adjacent fragment only from higher-confidence pixel recognition', async () => {
  const recognize = vi.fn<PdfOcr['recognize']>().mockResolvedValueOnce(recognized('M', 83)).mockResolvedValueOnce(recognized('r.', 80));
  const result = page();
  await repairOcrInitials({ recognize, close: vi.fn() }, { width: 400, height: 600 } as HTMLCanvasElement, result);
  expect(result.lines[1].words[0]).toMatchObject({ text: 'M', confidence: 83 });
  expect(result.lines[0].words[0]).toMatchObject({ text: 'r.', confidence: 80 });
  expect(result.lines[0].words[2].text).toBe('other');
  expect(recognize.mock.calls.map(call => call[1]?.mode)).toEqual(['character', 'line']);
  expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
});

it.each([['W', 20], ['MN', 99], ['', 0]] as const)('does not guess an initial when the retry returns %s with confidence %d', async (text, confidence) => {
  const recognize = vi.fn<PdfOcr['recognize']>().mockResolvedValue(recognized(text, confidence));
  const result = page();
  await repairOcrInitials({ recognize, close: vi.fn() }, { width: 400, height: 600 } as HTMLCanvasElement, result);
  expect(result.lines[1].words[0].text).toBe('NN');
  expect(result.lines[0].words[0].text).toBe('t.');
  expect(recognize).toHaveBeenCalledOnce();
});

it('does not reinterpret ordinary capitals or non-overlapping headings as drop caps', async () => {
  const result = page(); result.lines[1].words[0].bbox = { x0: 20, y0: 145, x1: 45, y1: 170 };
  const recognize = vi.fn<PdfOcr['recognize']>();
  await repairOcrInitials({ recognize, close: vi.fn() }, { width: 400, height: 600 } as HTMLCanvasElement, result);
  expect(recognize).not.toHaveBeenCalled();
});
