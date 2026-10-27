import type { Bbox } from 'tesseract.js';

interface FigureData { blocks?: readonly { blocktype?: unknown; text?: string; bbox?: Bbox }[] | null; hocr?: string | null }
export interface OcrFigure { bbox: Bbox }

function bounded(value: Bbox | undefined, width: number, height: number): Bbox | undefined {
  if (!value || ![width, height, value.x0, value.y0, value.x1, value.y1].every(Number.isFinite) || width <= 0 || height <= 0) return;
  const box = { x0: Math.max(0, value.x0), y0: Math.max(0, value.y0), x1: Math.min(width, value.x1), y1: Math.min(height, value.y1) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : undefined;
}

/** JSON omits some image blocks; HOCR still exposes those regions as ocr_photo. */
export function ocrFigures(data: FigureData, width: number, height: number): OcrFigure[] {
  const figures: OcrFigure[] = [];
  const add = (value: Bbox | undefined) => {
    const bbox = bounded(value, width, height); if (!bbox) return;
    const area = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);
    if (figures.some(({ bbox: other }) => {
      const intersection = Math.max(0, Math.min(bbox.x1, other.x1) - Math.max(bbox.x0, other.x0)) * Math.max(0, Math.min(bbox.y1, other.y1) - Math.max(bbox.y0, other.y0));
      const otherArea = (other.x1 - other.x0) * (other.y1 - other.y0);
      return intersection / (area + otherArea - intersection) >= .9;
    })) return;
    figures.push({ bbox });
  };
  for (const block of data.blocks || []) {
    const type = block.blocktype;
    if (!block.text?.trim() && (typeof type === 'number' && [9, 10, 11].includes(type) || typeof type === 'string' && /^(?:(?:FLOWING|HEADING|PULLOUT)_)?IMAGE$/i.test(type))) add(block.bbox);
  }
  // Only inspect bounded opening-tag attributes; HOCR is never inserted as HTML.
  for (const tag of (data.hocr || '').match(/<[A-Za-z][^<>]{0,4096}>/g) || []) {
    const classes = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) || [];
    if (!classes.some(value => value === 'ocr_photo' || value === 'ocr_image')) continue;
    const title = tag.match(/\btitle\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    const match = title.match(/(?:^|;\s*)bbox\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?=\s*(?:;|$))/);
    if (match) add({ x0: Number(match[1]), y0: Number(match[2]), x1: Number(match[3]), y1: Number(match[4]) });
  }
  return figures;
}

/** Remove an isolated printed header accidentally grouped with a top-page photo.
 * Keep continuous artwork, captions and non-header photos unchanged. */
export function trimOcrFigureHeader(canvas: HTMLCanvasElement, value: Bbox): Bbox {
  const bbox = bounded(value, canvas.width, canvas.height); if (!bbox) return value;
  const x = Math.floor(bbox.x0), y = Math.floor(bbox.y0), width = Math.ceil(bbox.x1) - x, height = Math.ceil(bbox.y1) - y;
  if (bbox.y0 > canvas.height * .08 || width < 120 || height < 120) return bbox;
  const context = canvas.getContext('2d'); if (!context) return bbox;
  const pixels = context.getImageData(x, y, width, height).data;
  if (pixels.length !== width * height * 4) return bbox;
  const luminance = (offset: number) => pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
  const edges: number[] = [];
  for (let row = 0; row < height; row++) for (const column of [0, 1, 2, width - 3, width - 2, width - 1]) edges.push(luminance((row * width + column) * 4));
  edges.sort((a, b) => a - b); const threshold = edges[Math.floor(edges.length * .75)] - 35;
  const bands: { start: number; end: number }[] = [];
  for (let row = 0; row < height; row++) {
    let dark = 0; for (let column = 0; column < width; column++) if (luminance((row * width + column) * 4) < threshold) dark++;
    if (dark <= width * .02) continue;
    const previous = bands.at(-1);
    if (previous && row - previous.end <= 4) previous.end = row; else bands.push({ start: row, end: row });
  }
  const substantial = bands.filter(band => band.end - band.start >= 2);
  if (substantial.length !== 2) return bbox;
  const [header, image] = substantial, gap = image.start - header.end - 1;
  if (header.start > height * .05 || header.end - header.start + 1 > height * .1 || gap < height * .1 || image.end - image.start + 1 < height * .55) return bbox;
  // A row of separated letter-like components is evidence of a printed header;
  // a continuous line or a connected illustration is not discarded.
  const components: { start: number; end: number }[] = [];
  for (let column = 0; column < width; column++) {
    let ink = false; for (let row = header.start; row <= header.end; row++) if (luminance((row * width + column) * 4) < threshold) { ink = true; break; }
    if (!ink) continue;
    const previous = components.at(-1);
    if (previous && column - previous.end <= 2) previous.end = column; else components.push({ start: column, end: column });
  }
  if (components.length < 5 || components.length > 40 || components.at(-1)!.end - components[0].start < width * .65 || components.some(component => component.end - component.start > width * .2)) return bbox;
  // Cut through the blank gap, retaining generous space before all artwork.
  return { ...bbox, y0: y + header.end + 1 + Math.floor(gap / 2) };
}
