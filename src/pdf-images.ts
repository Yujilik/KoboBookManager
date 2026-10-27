import { ImageKind, OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

type OperatorList = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>;
type Pixels = ArrayLike<number>;
interface Raster {
  width: number;
  height: number;
  kind?: number;
  data?: Pixels | string;
  bitmap?: CanvasImageSource;
}
export interface PdfFigure {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}
export interface PdfImageOptions { omitPageBackground?: boolean }
type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];

function matrix(value: unknown): Matrix | undefined {
  if (!value || !ArrayBuffer.isView(value) && !Array.isArray(value)) return;
  const values = Array.from(value as ArrayLike<number>);
  return values.length === 6 && values.every(Number.isFinite) ? values as Matrix : undefined;
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function textCharacters(value: unknown): number {
  if (typeof value === 'string') return value.replace(/\s/g, '').length;
  if (Array.isArray(value)) return value.reduce((count: number, part: unknown) => count + textCharacters(part), 0);
  if (value && typeof value === 'object' && 'unicode' in value) return textCharacters(value.unicode);
  return 0;
}

/** Invisible searchable text over a scanned page is already an OCR layer. */
export function hasOcrTextLayer(operations: OperatorList): boolean {
  const modes: number[] = []; let mode = 0, invisible = 0, visible = 0;
  for (let index = 0; index < operations.fnArray.length; index++) {
    const op = operations.fnArray[index], args = operations.argsArray[index];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) { modes.push(mode); continue; }
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) { mode = modes.pop() ?? 0; continue; }
    if (op === OPS.setTextRenderingMode) { mode = Number(args[0]); continue; }
    if (![OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(op)) continue;
    const count = textCharacters(args);
    if (mode === 3) invisible += count; else visible += count;
  }
  return invisible >= 8 && invisible > visible * 2;
}

/** Compare the painted unit-square polygon with the actual cropped PDF page. */
function pageBackground(transform: Matrix, view: number[]): boolean {
  if (!Array.isArray(view) || view.length !== 4 || !view.every(Number.isFinite)) return false;
  const left = Math.min(view[0], view[2]), right = Math.max(view[0], view[2]), bottom = Math.min(view[1], view[3]), top = Math.max(view[1], view[3]);
  const pageArea = (right - left) * (top - bottom); if (pageArea <= 0) return false;
  let polygon = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [transform[0] * x + transform[2] * y + transform[4], transform[1] * x + transform[3] * y + transform[5]]);
  for (const [axis, boundary, direction] of [[0, left, 1], [0, right, -1], [1, bottom, 1], [1, top, -1]]) {
    const clipped: number[][] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index], b = polygon[(index + 1) % polygon.length];
      const aInside = (a[axis] - boundary) * direction >= 0, bInside = (b[axis] - boundary) * direction >= 0;
      if (aInside) clipped.push(a);
      if (aInside !== bInside) {
        const ratio = (boundary - a[axis]) / (b[axis] - a[axis]);
        clipped.push([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]);
      }
    }
    polygon = clipped;
    if (!polygon.length) return false;
  }
  const area = Math.abs(polygon.reduce((sum, point, index) => { const next = polygon[(index + 1) % polygon.length]; return sum + point[0] * next[1] - point[1] * next[0]; }, 0)) / 2;
  return area >= pageArea * 0.8;
}

function imageTransforms(op: number, args: unknown[], current: Matrix): Matrix[] {
  if (op === OPS.paintImageXObjectRepeat) {
    const positions = args[3] as ArrayLike<number>, result: Matrix[] = [];
    if (!positions || !Number.isFinite(args[1]) || !Number.isFinite(args[2])) return [current];
    for (let index = 0; index + 1 < positions.length; index += 2) result.push(multiply(current, [Number(args[1]), 0, 0, Number(args[2]), positions[index], positions[index + 1]]));
    return result;
  }
  if (op === OPS.paintImageMaskXObjectRepeat) {
    const positions = args[5] as ArrayLike<number>, result: Matrix[] = [];
    if (!positions || !args.slice(1, 5).every(Number.isFinite)) return [current];
    for (let index = 0; index + 1 < positions.length; index += 2) result.push(multiply(current, [Number(args[1]), Number(args[2]), Number(args[3]), Number(args[4]), positions[index], positions[index + 1]]));
    return result;
  }
  if (op === OPS.paintInlineImageXObjectGroup && Array.isArray(args[1])) {
    return args[1].map(entry => { const placement = matrix(entry?.transform); return placement ? multiply(current, placement) : current; });
  }
  return [current];
}

const MAX_PIXELS = 12_000_000;
const MAX_SOURCE_PIXELS = 64_000_000;

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width; element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error('conversionFailed');
  return { element, context };
}

async function encode(element: HTMLCanvasElement, mime: PdfFigure['mime']): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    element.toBlob(value => value ? resolve(value) : reject(new Error('conversionFailed')), mime, 0.94);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function opaque(context: CanvasRenderingContext2D, width: number, height: number) {
  // PDF.js transfers browser images as bitmaps without their original ImageKind.
  for (let top = 0; top < height; top += 64) {
    const data = context.getImageData(0, top, width, Math.min(64, height - top)).data;
    for (let index = 3; index < data.length; index += 4) if (data[index] !== 255) return false;
  }
  return true;
}

function object(page: PDFPageProxy, id: string): Promise<Raster> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('conversionFailed')), 30_000);
    try {
      (id.startsWith('g_') ? page.commonObjs : page.objs).get(id, (value: Raster) => {
        clearTimeout(timeout);
        if (value) resolve(value); else reject(new Error('conversionFailed'));
      });
    } catch (error) { clearTimeout(timeout); reject(error); }
  });
}

async function figure(image: Raster, mask: boolean, fill: string): Promise<PdfFigure> {
  const { width, height } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('conversionFailed');
  if (width * height > MAX_SOURCE_PIXELS) throw new Error('pdfConversionTooLarge');
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const output = canvas(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
  let strip: ReturnType<typeof canvas> | undefined;
  try {
    if (image.bitmap) {
      output.context.drawImage(image.bitmap, 0, 0, output.element.width, output.element.height);
      if (mask) {
        output.context.globalCompositeOperation = 'source-in'; output.context.fillStyle = fill;
        output.context.fillRect(0, 0, output.element.width, output.element.height);
      }
    }
    else {
      const source = image.data;
      const kind = mask ? ImageKind.GRAYSCALE_1BPP : image.kind;
      const rowBytes = kind === ImageKind.GRAYSCALE_1BPP ? Math.ceil(width / 8)
        : kind === ImageKind.RGB_24BPP ? width * 3 : kind === ImageKind.RGBA_32BPP ? width * 4 : 0;
      if (!source || typeof source === 'string' || !rowBytes || source.length < rowBytes * height) throw new Error('conversionFailed');
      // Decode strips so a large packed image never requires a full-size extra RGBA buffer.
      const stripHeight = Math.min(64, height);
      strip = canvas(width, stripHeight);
      const pixels = strip.context.createImageData(width, stripHeight);
      for (let top = 0; top < height; top += stripHeight) {
        const rows = Math.min(stripHeight, height - top);
        for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
          const destination = (y * width + x) * 4;
          if (kind === ImageKind.GRAYSCALE_1BPP) {
            const white = !!(source[(top + y) * rowBytes + (x >> 3)] & (128 >> (x & 7)));
            pixels.data[destination] = pixels.data[destination + 1] = pixels.data[destination + 2] = white ? 255 : 0;
            pixels.data[destination + 3] = mask && white ? 0 : 255;
          } else {
            const stride = kind === ImageKind.RGB_24BPP ? 3 : 4;
            const offset = (top + y) * rowBytes + x * stride;
            pixels.data[destination] = source[offset]; pixels.data[destination + 1] = source[offset + 1]; pixels.data[destination + 2] = source[offset + 2];
            pixels.data[destination + 3] = stride === 4 ? source[offset + 3] : 255;
          }
        }
        strip.context.putImageData(pixels, 0, 0);
        if (mask) {
          strip.context.globalCompositeOperation = 'source-in'; strip.context.fillStyle = fill;
          strip.context.fillRect(0, 0, width, stripHeight); strip.context.globalCompositeOperation = 'source-over';
        }
        output.context.drawImage(strip.element, 0, 0, width, rows, 0, top * output.element.height / height, output.element.width, rows * output.element.height / height);
      }
    }
    const jpeg = !mask && width * height > 4096 && (image.kind === ImageKind.RGB_24BPP || image.bitmap && opaque(output.context, output.element.width, output.element.height));
    const mime = jpeg ? 'image/jpeg' : 'image/png';
    return { bytes: await encode(output.element, mime), mime, width: output.element.width, height: output.element.height };
  } finally {
    output.element.width = output.element.height = 0;
    if (strip) strip.element.width = strip.element.height = 0;
  }
}

/** Preserve embedded raster figures independently from the PDF's reflowable text. */
export async function extractPageImages(page: PDFPageProxy, operations: OperatorList, options: PdfImageOptions = {}): Promise<PdfFigure[]> {
  const result: PdfFigure[] = [], seenIds = new Set<string>(), seenInline = new WeakSet<object>();
  const states: { fill: string; transform: Matrix }[] = []; let fill = '#000000', transform = identity();
  for (let index = 0; index < operations.fnArray.length; index++) {
    const op = operations.fnArray[index], args = operations.argsArray[index];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      states.push({ fill, transform: [...transform] });
      if (op === OPS.paintFormXObjectBegin) { const placement = matrix(args[0]); if (placement) transform = multiply(transform, placement); }
      continue;
    }
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) { const state = states.pop(); fill = state?.fill ?? '#000000'; transform = state?.transform ?? identity(); continue; }
    if (op === OPS.transform) { const placement = matrix(args); if (placement) transform = multiply(transform, placement); continue; }
    if (op === OPS.setFillRGBColor && typeof args[0] === 'string') { fill = args[0]; continue; }
    const mask = op === OPS.paintImageMaskXObject || op === OPS.paintImageMaskXObjectRepeat;
    if (op !== OPS.paintImageXObject && op !== OPS.paintImageXObjectRepeat && op !== OPS.paintInlineImageXObject && op !== OPS.paintInlineImageXObjectGroup && !mask) continue;
    if (options.omitPageBackground) {
      const transforms = imageTransforms(op, args, transform);
      if (transforms.length && transforms.every(placement => pageBackground(placement, page.view))) continue;
    }
    const original = args[0] as Raster | string;
    const id = typeof original === 'string' ? original : typeof original?.data === 'string' ? original.data : undefined;
    if (id) {
      const key = id + (mask ? ':' + fill : ''); if (seenIds.has(key)) continue; seenIds.add(key);
    } else {
      if (!original || typeof original !== 'object') throw new Error('conversionFailed');
      if (seenInline.has(original)) continue; seenInline.add(original);
    }
    const decoded = id ? await object(page, id) : original as Raster;
    // Tiny stencil masks are normally bullets or glyph fragments, not illustrations.
    if (mask && decoded.width <= 16 && decoded.height <= 16) continue;
    result.push(await figure(decoded, mask, fill));
  }
  return result;
}
