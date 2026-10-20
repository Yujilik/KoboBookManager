import { Directory, Filesystem } from '@capacitor/filesystem';
import { isAndroid, native, toBase64 } from './native';
import { original } from './library';
import { editEpub } from './epub';
import { fromBase64 } from './native';
import { convert } from './converter';
import type { Book } from './types';
import JSZip from 'jszip';
import { uniqueNames } from './collection';
import type { Locale, Translate } from './messages';

export function filename(book: Book, kepub = false) {
  const title = book.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'book';
  return title + (book.format === 'pdf' ? '.pdf' : kepub ? '.kepub.epub' : '.epub');
}
export async function generate(book: Book, kepub: boolean, progress: (value: number) => void) {
  const bytes = await original(book.id);
  if (book.format === 'pdf') return bytes;
  const edited = await editEpub(bytes, book, book.customCover ? { bytes: fromBase64(book.customCover), mime: book.customCover.slice(5, book.customCover.indexOf(';')) } : undefined);
  return kepub ? convert(edited, progress) : edited;
}
export async function saveFile(bytes: Uint8Array, name: string, mime: string) {
  if (isAndroid) { await native.saveDocument({ name, mime, data: toBase64(bytes) }); return; }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function exportCollection(books: Book[], kepub: boolean, send: boolean, locale: Locale, t: Translate, status: (label: string) => void) {
  if (send && !isAndroid) throw new Error('Local delivery requires Android.');
  if (!books.length || books.some(book => !book.title.trim())) throw new Error('titleRequired');
  const names = uniqueNames(books.map(book => filename(book, kepub)));
  const archive = new JSZip();
  const files: { path: string; name: string; mime: string; title: string }[] = [];
  const session = crypto.randomUUID();
  let total = 0;
  for (let index = 0; index < books.length; index++) {
    const book = books[index];
    status(t('reading', { index: index + 1, count: books.length, name: book.title }));
    const bytes = await generate(book, kepub, progress => status(t('converting', { index: index + 1, count: books.length, progress })));
    const mime = book.format === 'pdf' ? 'application/pdf' : 'application/epub+zip';
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
  await saveFile(await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }), kepub ? 'kebooks-collection-kepub.zip' : 'kebooks-collection-epub.zip', 'application/zip');
}
