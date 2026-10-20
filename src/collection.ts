import type { Book } from './types';

export interface Draft { book: Book; authorsText: string; tagsText: string }
export const draftOf = (book: Book): Draft => ({ book: structuredClone(book), authorsText: book.authors.join('\n'), tagsText: book.tags.join(', ') });
export function materialise(draft: Draft): Book {
  return { ...draft.book, authors: draft.authorsText.split('\n').map(x => x.trim()).filter(Boolean), tags: draft.tagsText.split(',').map(x => x.trim()).filter(Boolean) };
}
export interface SharedDetails {
  authors?: string[];
  series?: string;
  language?: string;
  publisher?: string;
  tags?: string[];
  appendTags?: boolean;
  startNumber?: number;
}
export function applySharedDetails(books: Book[], shared: SharedDetails): Book[] {
  if (shared.startNumber !== undefined && (!Number.isFinite(shared.startNumber) || shared.startNumber < 0)) throw new Error('numberInvalid');
  return books.map((book, index) => ({
    ...book,
    ...(shared.authors !== undefined ? { authors: [...shared.authors] } : {}),
    ...(shared.series !== undefined ? { series: shared.series } : {}),
    ...(shared.language !== undefined ? { language: shared.language } : {}),
    ...(shared.publisher !== undefined ? { publisher: shared.publisher } : {}),
    ...(shared.tags !== undefined ? { tags: [...new Set([...(shared.appendTags ? book.tags : []), ...shared.tags])] } : {}),
    ...(shared.startNumber !== undefined ? { seriesIndex: String(shared.startNumber + index) } : {}),
  }));
}
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const result = [...items]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
}
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(name => {
    let candidate = name, index = 2;
    const match = /^(.*?)(\.kepub\.epub|\.epub|\.pdf)$/i.exec(name);
    while (used.has(candidate.toLowerCase())) candidate = match ? `${match[1]}-${index++}${match[2]}` : `${name}-${index++}`;
    used.add(candidate.toLowerCase()); return candidate;
  });
}
