import { openDB, type DBSchema } from 'idb';
import type { Book } from './types';
import JSZip from 'jszip';
import { MAX_BOOK_SIZE } from './epub';

interface LibraryDB extends DBSchema {
  books: { key: string; value: Book };
  originals: { key: string; value: Uint8Array };
  settings: { key: string; value: unknown };
}
const db = openDB<LibraryDB>('kobo-book-manager', 1, { upgrade(db) {
  db.createObjectStore('books', { keyPath: 'id' }); db.createObjectStore('originals'); db.createObjectStore('settings');
} });
export async function listBooks() { return (await db).getAll('books'); }
export async function saveBook(book: Book, bytes?: Uint8Array) {
  const tx = (await db).transaction(['books', 'originals'], 'readwrite');
  await tx.objectStore('books').put(book); if (bytes) await tx.objectStore('originals').put(bytes, book.id); await tx.done;
}
export async function saveBooks(books: Book[]) {
  if (books.some(book => !book.title.trim())) throw new Error('titleRequired');
  const transaction = (await db).transaction('books', 'readwrite');
  const pending: Promise<unknown>[] = [transaction.done];
  try {
    for (const book of books) pending.push(transaction.store.put(book));
    await Promise.all(pending);
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await Promise.allSettled(pending);
    throw error;
  }
}
export async function original(id: string) {
  const bytes = await (await db).get('originals', id); if (!bytes) throw new Error('Arquivo original não encontrado.'); return bytes;
}
export async function removeBook(id: string) {
  const tx = (await db).transaction(['books', 'originals'], 'readwrite');
  await tx.objectStore('books').delete(id); await tx.objectStore('originals').delete(id); await tx.done;
}
export async function setting<T>(key: string): Promise<T | undefined> { return (await db).get('settings', key) as Promise<T | undefined>; }
export async function setSetting(key: string, value: unknown) { await (await db).put('settings', value, key); }
export async function backup() {
  const books = await listBooks(); const zip = new JSZip();
  zip.file('library.json', JSON.stringify({ version: 1, books }, null, 2));
  for (const book of books) zip.file('originals/' + book.id, await original(book.id));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}
export async function restore(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const manifest = zip.file('library.json'); if (!manifest) throw new Error('Este ZIP não é um backup do Kobo Book Manager.');
  const data = JSON.parse(await manifest.async('string')) as { version: number; books: Book[] };
  if (data.version !== 1 || !Array.isArray(data.books) || data.books.length > 10000) throw new Error('Backup inválido ou versão incompatível.');
  const originals = new Map<string, Uint8Array>();
  let total = 0;
  for (const book of data.books) {
    if (!/^[a-f0-9]{64}$/.test(book.id) || typeof book.title !== 'string' || !Array.isArray(book.authors) || !Array.isArray(book.tags) || !['epub', 'pdf'].includes(book.format)) throw new Error('O backup contém dados inválidos.');
    const file = zip.file('originals/' + book.id); if (!file) throw new Error('O backup está incompleto. Nenhum livro foi restaurado.');
    const size = (file as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    total += size; if (size > MAX_BOOK_SIZE || total > 512 * 1024 * 1024) throw new Error('Backup grande demais para restaurar de uma vez nesta versão.');
    for (const key of ['cover', 'customCover'] as const) if (book[key] && !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(book[key]!)) throw new Error('Capa inválida no backup.');
    originals.set(book.id, await file.async('uint8array'));
  }
  const tx = (await db).transaction(['books', 'originals'], 'readwrite');
  // Restore merges missing books; it does not replace existing edits or delete the current library.
  let count = 0;
  for (const book of data.books) if (!await tx.objectStore('books').get(book.id)) {
    await tx.objectStore('books').put(book); await tx.objectStore('originals').put(originals.get(book.id)!, book.id); count++;
  }
  await tx.done; return count;
}
