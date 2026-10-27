import type { PdfOcrLine, PdfOcrResult, PdfOcrWord } from './pdf-ocr';

export interface OcrInitialImage { bytes: Uint8Array; width: number; height: number; anchor: PdfOcrWord; bottom: number }
const wordHeight = (word: PdfOcrWord) => word.bbox.y1 - word.bbox.y0;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
const baseline = (line: PdfOcrLine) => line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 : median(line.words.map(word => word.bbox.y1));

/** Preserve a decorative initial's actual ink, including initials omitted by OCR. */
export async function originalInitialWords(canvas: HTMLCanvasElement, result: PdfOcrResult): Promise<OcrInitialImage[]> {
  const rowHeight = median(result.lines.map(line => line.height || median(line.words.map(wordHeight))).filter(height => height > 0));
  if (!rowHeight) return [];
  const lines = result.lines.filter(line => line.words.length >= 2 && /[a-z]{2}/.test(line.text) && (line.height || rowHeight) < rowHeight * 1.5).sort((a, b) => baseline(a) - baseline(b));
  const margins = lines.map(line => Math.min(...line.words.map(word => word.bbox.x0))).sort((a, b) => a - b);
  const left = margins[Math.floor(margins.length * .15)];
  if (!Number.isFinite(left)) return [];
  const context = canvas.getContext('2d'); if (!context) throw new Error('pdfOcrFailed');
  const originals: OcrInitialImage[] = [];
  for (const line of lines) {
    if (originals.length >= 2) break;
    const y = baseline(line), normal = line.height || rowHeight;
    const regular = line.words.filter(word => wordHeight(word) < normal * 1.8 && /[\p{L}\p{N}]/u.test(word.text));
    if (regular.length < 2) continue;
    const first = regular[0], preceding = result.lines.filter(other => baseline(other) < y - normal * .5).sort((a, b) => baseline(b) - baseline(a))[0];
    const tall = result.lines.flatMap(other => other.words).some(word => wordHeight(word) > normal * 1.8 && word.bbox.y0 < y && word.bbox.y1 > y + normal * .3 && word.bbox.x0 <= first.bbox.x0);
    if (!tall && (!preceding || y - baseline(preceding) < normal * 3 || first.bbox.x0 - left < normal * .4)) continue;
    const x0 = Math.max(0, Math.floor(Math.min(left, first.bbox.x0 - normal * 3) - normal * .3));
    const y0 = Math.max(0, Math.floor(y - normal * 1.5));
    // Stop before the first regular word. Its ink must never become part of
    // the large capital's connected component (serifs may nearly touch it).
    const x1 = Math.min(canvas.width, Math.floor(first.bbox.x0 - 1));
    const y1 = Math.min(canvas.height, Math.ceil(y + normal * 3));
    const width = x1 - x0, height = y1 - y0;
    if (width <= 2 || height <= 2 || width * height > 500_000) continue;
    const pixels = context.getImageData(x0, y0, width, height), gray = new Uint8Array(width * height), histogram = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) { const value = Math.round((pixels.data[i * 4] + pixels.data[i * 4 + 1] + pixels.data[i * 4 + 2]) / 3); gray[i] = value; histogram[value]++; }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * histogram[i];
    let weight = 0, partial = 0, variance = 0, threshold = 0;
    for (let i = 0; i < 255; i++) { weight += histogram[i]; partial += i * histogram[i]; const after = gray.length - weight; if (!weight || !after) continue; const delta = partial / weight - (sum - partial) / after; const score = weight * after * delta * delta; if (score > variance) { variance = score; threshold = i; } }
    const visited = new Uint8Array(gray.length), queue = new Int32Array(gray.length);
    const components: { indices: number[]; x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
    for (let start = 0; start < gray.length; start++) {
      if (visited[start] || gray[start] > threshold) continue;
      let head = 0, end = 1, minX = width, maxX = 0, minY = height, maxY = 0; queue[0] = start; visited[start] = 1;
      const indices: number[] = [];
      while (head < end) {
        const index = queue[head++], x = index % width, py = Math.floor(index / width); indices.push(index);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = py + dy, next = ny * width + nx; if (nx < 0 || nx >= width || ny < 0 || ny >= height || visited[next] || gray[next] > threshold) continue; visited[next] = 1; queue[end++] = next; }
      }
      const componentHeight = maxY - minY + 1, componentWidth = maxX - minX + 1;
      if (componentHeight < normal * 1.65 || componentHeight > normal * 4 || componentWidth < 2 || componentWidth > normal * 5 ||
        y0 + minY > y - normal * .25 || y0 + maxY < y + normal * .3 || x0 + minX >= first.bbox.x0) continue;
      components.push({ indices, x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1, area: indices.length });
    }
    const selected = components.sort((a, b) => b.area - a.area)[0];
    if (!selected) continue;
    // Thin serifs can split one printed initial into several disconnected ink
    // components. Preserve their combined outline, not just its largest stem.
    for (const component of components.slice(1)) {
      const overlap = Math.min(selected.y1, component.y1) - Math.max(selected.y0, component.y0);
      const gap = Math.max(0, component.x0 - selected.x1, selected.x0 - component.x1);
      if (overlap < Math.min(selected.y1 - selected.y0, component.y1 - component.y0) * .5 || gap > normal * 1.5) continue;
      selected.x0 = Math.min(selected.x0, component.x0); selected.x1 = Math.max(selected.x1, component.x1);
      selected.y0 = Math.min(selected.y0, component.y0); selected.y1 = Math.max(selected.y1, component.y1);
      selected.indices.push(...component.indices);
    }
    const capital = { x0: x0 + selected.x0, y0: y0 + selected.y0, x1: x0 + selected.x1, y1: y0 + selected.y1 };
    const opening = lines.filter(candidate => {
      const value = baseline(candidate);
      return value > capital.y0 + normal * .25 && value < capital.y1 - normal * .2 &&
        candidate.words.filter(word => wordHeight(word) < normal * 1.8 && /[\p{L}\p{N}]/u.test(word.text)).length >= 2;
    })[0];
    if (opening !== line) continue;
    const touching = result.lines.flatMap(other => other.words).filter(word => wordHeight(word) > normal * 1.6 && word.bbox.x0 < capital.x1 && word.bbox.x1 > capital.x0 && word.bbox.y0 < capital.y1 && word.bbox.y1 > capital.y0);
    let wordEnd = Math.max(capital.x1, ...touching.map(word => word.bbox.x1));
    const suffix = regular.find(word => word.bbox.x0 >= capital.x1 - normal * .1 &&
      (word.bbox.x0 < wordEnd || wordEnd - capital.x1 < normal * .65 && word.bbox.x0 - wordEnd < normal * 1.5));
    if (suffix) wordEnd = Math.max(wordEnd, suffix.bbox.x1);
    const anchor = suffix || touching[0];
    if (!anchor || wordEnd <= capital.x1 || wordEnd - capital.x0 > normal * 14) continue;
    const glyphCanvas = document.createElement('canvas'); glyphCanvas.width = selected.x1 - selected.x0; glyphCanvas.height = selected.y1 - selected.y0;
    const suffixTop = Math.max(0, Math.floor(y - normal)), suffixBottom = Math.min(canvas.height, Math.ceil(y + normal * .2));
    const suffixLeft = Math.floor(capital.x1), suffixWidth = Math.max(1, Math.ceil(wordEnd) - suffixLeft);
    const image = document.createElement('canvas'); image.height = Math.ceil(normal * 1.2);
    const glyphWidth = Math.max(1, Math.round(glyphCanvas.width / glyphCanvas.height * normal)); image.width = glyphWidth + suffixWidth;
    try {
      const glyphContext = glyphCanvas.getContext('2d'), target = image.getContext('2d'); if (!glyphContext || !target) throw new Error('pdfOcrFailed');
      const glyphPixels = glyphContext.createImageData(glyphCanvas.width, glyphCanvas.height);
      for (const index of selected.indices) { const gx = index % width - selected.x0, gy = Math.floor(index / width) - selected.y0; glyphPixels.data[(gy * glyphCanvas.width + gx) * 4 + 3] = 255; }
      glyphContext.putImageData(glyphPixels, 0, 0); target.drawImage(glyphCanvas, 0, 0, glyphWidth, Math.ceil(normal));
      const suffixPixels = context.getImageData(suffixLeft, suffixTop, suffixWidth, suffixBottom - suffixTop), clean = target.createImageData(suffixWidth, suffixBottom - suffixTop);
      for (let i = 0; i < clean.data.length; i += 4) { const value = (suffixPixels.data[i] + suffixPixels.data[i + 1] + suffixPixels.data[i + 2]) / 3; if (value <= threshold) clean.data[i + 3] = 255; }
      target.putImageData(clean, glyphWidth, 0);
      const blob = await new Promise<Blob>((resolve, reject) => image.toBlob(value => value ? resolve(value) : reject(new Error('pdfOcrFailed')), 'image/png'));
      const replaced = new Set(touching);
      for (const word of line.words) if (word.bbox.x0 >= capital.x0 && word.bbox.x1 <= wordEnd + normal * .15) replaced.add(word);
      // Broken cap strokes can be emitted as a semicolon or bracket before the
      // actual opening word. These are glyph fragments, not leading prose.
      for (const word of line.words) if (/^[;:|}\[\]()]$/.test(word.text) && word.bbox.x0 >= capital.x0 - normal && word.bbox.x1 < wordEnd) replaced.add(word);
      for (const other of result.lines) { other.words = other.words.filter(word => word === anchor || !replaced.has(word)); if (other !== line) other.words = other.words.filter(word => word !== anchor); }
      if (!line.words.includes(anchor)) line.words.unshift(anchor);
      anchor.text = '\ufffc'; anchor.bbox = { x0: capital.x0, y0: y - normal, x1: wordEnd, y1: y }; anchor.confidence = 100;
      line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0); for (const other of result.lines) other.text = other.words.map(word => word.text).join(' ');
      originals.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: image.width, height: image.height, anchor, bottom: capital.y1 });
    } finally { glyphCanvas.width = glyphCanvas.height = image.width = image.height = 0; }
  }
  return originals;
}
