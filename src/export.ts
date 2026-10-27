import { Directory, Filesystem } from '@capacitor/filesystem';
import { isAndroid, native, toBase64 } from './native';
import { original } from './library';
import { editEpub } from './epub';
import { readCover } from './cover';
import { convert } from './converter';
import type { Book, ExportFormat } from './types';
import JSZip from 'jszip';
import { uniqueNames } from './collection';
import type { Locale, Translate } from './messages';

export function filename(book: Book, format: ExportFormat = 'original') {
  const title = book.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'book';
  const kepub = format === 'kepub' || format === 'original' && /\.kepub\.epub$/i.test(book.filename);
  return title + (format === 'original' && book.format === 'pdf' ? '.pdf' : kepub ? '.kepub.epub' : '.epub');
}
export async function generate(book: Book, format: ExportFormat, progress: (value: number) => void) {
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
    const report = (value: number) => progress(format === 'kepub' ? Math.round(value * 0.7) : value);
    edited = cover ? await pdfToEpub(bytes, book, report, cover) : await pdfToEpub(bytes, book, report);
  } else {
    edited = await editEpub(bytes, book, cover);
  }
  const alreadyKepub = book.format === 'epub' && /\.kepub\.epub$/i.test(book.filename);
  return format === 'kepub' && !alreadyKepub
    ? convert(edited, value => progress(book.format === 'pdf' ? 70 + Math.round(value * 0.3) : value)) : edited;
}
export async function saveFile(bytes: Uint8Array, name: string, mime: string) {
  if (isAndroid) { await native.saveDocument({ name, mime, data: toBase64(bytes) }); return; }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function exportCollection(books: Book[], format: ExportFormat, send: boolean, locale: Locale, t: Translate, status: (label: string) => void) {
  if (send && !isAndroid) throw new Error('Local delivery requires Android.');
  if (!books.length || books.some(book => !book.title.trim())) throw new Error('titleRequired');
  const names = uniqueNames(books.map(book => filename(book, format)));
  const archive = new JSZip();
  const files: { path: string; name: string; mime: string; title: string }[] = [];
  const session = crypto.randomUUID();
  let total = 0;
  for (let index = 0; index < books.length; index++) {
    const book = books[index];
    status(t('reading', { index: index + 1, count: books.length, name: book.title }));
    const bytes = await generate(book, format, progress => status(t('converting', { index: index + 1, count: books.length, progress })));
    const mime = book.format === 'pdf' && format === 'original' ? 'application/pdf' : 'application/epub+zip';
    if (send) {
      const path = `delivery/${session}/${index}`;
      await Filesystem.writeFile({ path, directory: Directory.Cache, data: toBase64(bytes), recursive: true });
      files.push({ path, name: names[index], mime, title: book.title });
    } else if (books.length === 1) { await saveFile(bytes, names[index], mime); return; }
    else {
      total += bytes.byteLength;
      if (total > 512 * 1024 * 1024) throw new Error('collectionTooLarge');
      archive.file(names[index], bytes);
    }
  }
  if (send) {
    const labels = Object.fromEntries((['receiveTitle', 'enterCode', 'open', 'wrongCode', 'retry', 'readyKobo', 'download', 'closeBrowser', 'notFound', 'methodNotAllowed'] as const).map(key => [key, t(key)]));
    return native.startDelivery({ files, locale, labels });
  }
  status(t('preparing'));
  await saveFile(await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }), format === 'kepub' ? 'kebooks-collection-kepub.zip' : 'kebooks-collection-epub.zip', 'application/zip');
}
