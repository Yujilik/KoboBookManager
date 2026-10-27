import type { PdfOcr, PdfOcrResult, PdfOcrLine, PdfOcrWord } from './pdf-ocr';

const height = (word: PdfOcrWord) => word.bbox.y1 - word.bbox.y0;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

async function region(source: HTMLCanvasElement, box: { x0: number; y0: number; x1: number; y1: number }, margin: number, action: (canvas: HTMLCanvasElement) => Promise<PdfOcrResult>): Promise<PdfOcrResult> {
  const x = Math.max(0, Math.floor(box.x0)), y = Math.max(0, Math.floor(box.y0));
  const width = Math.min(source.width - x, Math.ceil(box.x1) - x), fullHeight = Math.min(source.height - y, Math.ceil(box.y1) - y);
  const border = Math.ceil(margin), canvas = document.createElement('canvas');
  canvas.width = width + border * 2; canvas.height = fullHeight + border * 2;
  try {
    const context = canvas.getContext('2d'); if (!context || width <= 0 || fullHeight <= 0) throw new Error('pdfOcrFailed');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, x, y, width, fullHeight, border, border, width, fullHeight);
    return await action(canvas);
  } finally { canvas.width = canvas.height = 0; }
}

/** Re-read actual pixels of ambiguous decorated initials; never guess the missing character from prose. */
export async function repairOcrInitials(ocr: PdfOcr, canvas: HTMLCanvasElement, result: PdfOcrResult): Promise<void> {
  let retries = 0;
  for (const line of result.lines) for (const word of line.words) {
    if (retries >= 2 || word.confidence >= 80 || !/^[A-Za-z]{1,3}$/.test(word.text)) continue;
    const normal = median(line.words.filter(other => other !== word).map(height));
    if (!normal || height(word) < normal * 2 || word.bbox.x1 - word.bbox.x0 > height(word) * 2) continue;
    const prior = result.lines.filter(candidate => candidate !== line && candidate.words.length >= 4 &&
      candidate.bbox.y0 >= word.bbox.y0 - normal * .6 && candidate.bbox.y1 < word.bbox.y1 - normal &&
      candidate.bbox.x0 > word.bbox.x0 + normal && candidate.bbox.x0 < word.bbox.x1 + normal)
      .sort((a, b) => a.bbox.y0 - b.bbox.y0)[0];
    const first = prior?.words[0];
    if (!prior || !first || !/^[a-z][a-z.,;:]{0,30}$/.test(first.text)) continue;
    const right = Math.min(word.bbox.x1, first.bbox.x0 - 2);
    if (right - word.bbox.x0 < normal * .6) continue;
    retries++;
    const recovered = await region(canvas, { x0: word.bbox.x0 - normal * .35, y0: word.bbox.y0 - normal * .35, x1: right, y1: word.bbox.y1 + normal * .2 }, normal * .5,
      crop => ocr.recognize(crop, { mode: 'character', characters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' }));
    const character = recovered.text.trim();
    if (!/^[A-Z]$/.test(character) || recovered.confidence < Math.max(70, word.confidence + 10)) continue;
    line.text = line.text.replace(word.text, character); word.text = character; word.confidence = recovered.confidence; word.bbox.x1 = right;
    // The initial's stroke can turn the following short fragment into another
    // letter. Read its whole source line, but replace only that ambiguous word.
    if (first.confidence < 85 && first.text.length <= 3) {
      const reread = await region(canvas, { x0: first.bbox.x0 - 2, y0: prior.bbox.y0 - normal * .2, x1: prior.bbox.x1 + normal * .2, y1: prior.bbox.y1 + normal * .3 }, normal,
        crop => ocr.recognize(crop, { mode: 'line' }));
      const replacement = reread.lines.flatMap(candidate => candidate.words)[0];
      if (replacement && /^[a-z][a-z.,;:]?$/.test(replacement.text)) {
        let accepted = replacement.confidence >= Math.max(70, first.confidence + 10);
        if (!accepted && replacement.text !== first.text && replacement.confidence > first.confidence && replacement.confidence >= 60) {
          const confirm = await region(canvas, { x0: first.bbox.x0 - 2, y0: prior.bbox.y0 - normal * .2, x1: prior.bbox.x1 + normal * .2, y1: prior.bbox.y1 + normal * .3 }, normal * 1.5,
            crop => ocr.recognize(crop, { mode: 'line' }));
          const other = confirm.lines.flatMap(candidate => candidate.words)[0];
          accepted = other?.text === replacement.text && other.confidence >= 60;
        }
        if (accepted) { prior.text = prior.text.replace(first.text, replacement.text); first.text = replacement.text; first.confidence = replacement.confidence; }
      }
    }
  }
}

/** Use Tesseract's fitted baseline and row height, not each glyph's ink bounds, for PDF text geometry. */
export function ocrWordGeometry(line: PdfOcrLine, word: PdfOcrWord): { baseline: number; height: number } {
  const typical = median(line.words.map(height).filter(value => value > 0)) || height(word);
  const longLatinWord = /^[\p{Script=Latin}\p{Mark}]{4,}[.,;:!?'-]?$/u.test(word.text);
  if (!longLatinWord && height(word) > typical * 1.8) return { baseline: word.bbox.y1, height: height(word) };
  const baseline = line.baseline;
  const y = baseline ? baseline.y0 + (word.bbox.x0 - baseline.x0) / Math.max(1, baseline.x1 - baseline.x0) * (baseline.y1 - baseline.y0)
    : median(line.words.filter(other => height(other) <= typical * 1.8).map(other => other.bbox.y1)) || word.bbox.y1;
  return { baseline: y, height: line.height && line.height <= typical * 1.8 ? line.height : typical };
}
