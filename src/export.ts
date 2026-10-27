import { isAndroid, native } from './native';
import { original } from './library';
import { editEpub } from './epub';
import { readCover } from './cover';
import { convert } from './converter';
import type { Book, ExportFormat } from './types';
import JSZip from 'jszip';
import { uniqueNames } from './collection';
import type { Locale, Translate } from './messages';
import { checkReceipt, discardOutput, stageOutput, validateOutput } from './output';
import type { StagedFile } from './native';
import type { PdfConversionOptions } from './pdf-ocr-options';
export interface ExportOptions extends PdfConversionOptions {
  pdfByBook?: Record<string, PdfConversionOptions>;
}
type ConversionProgress = (value: number, stage?: 'ocr') => void;

function pdfOptions(book: Book, options?: ExportOptions): PdfConversionOptions | undefined {
  if (book.format !== 'pdf') return;
  if (!options?.pdfByBook) return options;
  return options.pdfByBook[book.id] ?? (options.ocrLanguages ? { ocrLanguages: options.ocrLanguages } : undefined);
}

export function filename(book: Book, format: ExportFormat = 'original') {
  const title = book.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'book';
  const kepub = format === 'kepub' || format === 'original' && /\.kepub\.epub$/i.test(book.filename);
  return title + (format === 'original' && book.format === 'pdf' ? '.pdf' : kepub ? '.kepub.epub' : '.epub');
}
async function generateBytes(book: Book, format: ExportFormat, progress: ConversionProgress, options?: PdfConversionOptions) {
  if (!['original', 'epub', 'kepub'].includes(format)) throw new Error('outputInvalid');
  const bytes = await original(book.id);
  const cover = readCover(book.customCover);
  if (book.format === 'pdf' && format === 'original') {
    if (!cover) return bytes;
    const { withPdfCover } = await import('./pdf-cover');
    return withPdfCover(bytes, cover);
  }
  let edited: Uint8Array;
  if (book.format === 'pdf') {
    const { pdfToEpub } = await import('./pdf');
    const report: ConversionProgress = (value, stage) => progress(format === 'kepub' ? Math.round(value * 0.7) : value, stage);
    edited = options ? await pdfToEpub(bytes, book, report, cover, options)
      : cover ? await pdfToEpub(bytes, book, report, cover) : await pdfToEpub(bytes, book, report);
  } else {
    edited = await editEpub(bytes, book, cover);
  }
  const alreadyKepub = book.format === 'epub' && /\.kepub\.epub$/i.test(book.filename);
  return format === 'kepub' && !alreadyKepub
    ? convert(edited, value => progress(book.format === 'pdf' ? 70 + Math.round(value * 0.3) : value)) : edited;
}
export async function generate(book: Book, format: ExportFormat, progress: ConversionProgress, options?: PdfConversionOptions) {
  const bytes = await generateBytes(book, format, progress, options);
  await validateOutput(bytes, outputMime(book, format));
  return bytes;
}
function outputMime(book: Book, format: ExportFormat) {
  return book.format === 'pdf' && format === 'original' ? 'application/pdf' : 'application/epub+zip';
}
export async function saveFile(bytes: Uint8Array, name: string, mime: string) {
  await validateOutput(bytes, mime);
  if (isAndroid) {
    const file = await stageOutput(bytes, name, mime);
    try {
      const receipt = await native.saveDocument(file);
      checkReceipt(file, receipt);
      if (!receipt.uri) throw new Error('outputInvalid');
    } finally { await discardOutput(file); }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function exportCollection(books: Book[], format: ExportFormat, send: boolean, locale: Locale, t: Translate, status: (label: string) => void, options?: ExportOptions) {
  if (send && !isAndroid) throw new Error('Local delivery requires Android.');
  if (!books.length || books.some(book => !book.title.trim())) throw new Error('titleRequired');
  if (format !== 'original' && books.some(book => pdfOptions(book, options)?.ocrLanguages?.length === 0)) throw new Error('pdfOcrFailed');
  const names = uniqueNames(books.map(book => filename(book, format)));
  const archive = new JSZip();
  const files: (StagedFile & { title: string })[] = [];
  let total = 0;
  try {
    for (let index = 0; index < books.length; index++) {
      const book = books[index];
      status(t('reading', { index: index + 1, count: books.length, name: book.title }));
      const bytes = await generate(book, format, (progress, stage) => status(t(stage === 'ocr' ? 'recognizing' : 'converting', { index: index + 1, count: books.length, progress })), pdfOptions(book, options));
      const mime = outputMime(book, format);
      if (send) {
        files.push({ ...await stageOutput(bytes, names[index], mime), title: book.title });
      } else if (books.length === 1) { await saveFile(bytes, names[index], mime); return; }
      else {
        total += bytes.byteLength;
        if (total > 512 * 1024 * 1024) throw new Error('collectionTooLarge');
        archive.file(names[index], bytes);
      }
    }
    if (send) {
      const labels = Object.fromEntries((['receiveTitle', 'enterCode', 'open', 'wrongCode', 'retry', 'readyKobo', 'download', 'closeBrowser', 'notFound', 'methodNotAllowed'] as const).map(key => [key, t(key)]));
      const result = await native.startDelivery({ files, locale, labels });
      if (!Array.isArray(result.files) || result.files.length !== files.length) throw new Error('outputInvalid');
      for (let index = 0; index < files.length; index++) {
        checkReceipt(files[index], result.files[index]);
        if (result.files[index].name !== files[index].name || result.files[index].mime !== files[index].mime) throw new Error('outputInvalid');
      }
      return result;
    }
    status(t('preparing'));
    await saveFile(await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }), format === 'kepub' ? 'kebooks-collection-kepub.zip' : 'kebooks-collection-epub.zip', 'application/zip');
  } catch (error) {
    if (send) { await native.stopDelivery().catch(() => undefined); await Promise.all(files.map(discardOutput)); }
    throw error;
  }
}
