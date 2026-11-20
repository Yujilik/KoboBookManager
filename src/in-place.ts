import { isNative } from './native';
import type { Book } from './types';

/** Name for a KEPUB that takes the original's place: `Book.epub` → `Book.kepub.epub`. Native code applies the same rule to the file's current name. */
export function inPlaceName(book: Pick<Book, 'filename'>) {
  const name = book.filename.trim() || 'book';
  if (isKepub(book)) return name;
  return name.replace(/\.epub$/i, '') + '.kepub.epub';
}

export function isKepub(book: Pick<Book, 'filename'>) { return /\.kepub\.epub$/i.test(book.filename.trim()); }

/** Only EPUBs read from a connected folder can be replaced: imported copies have no original, and a KEPUB has no EPUB to replace. */
export function canReplace(book: Book) {
  return isNative && book.format === 'epub' && !isKepub(book) && !!book.sourceUri && !!book.sourceFolder;
}
