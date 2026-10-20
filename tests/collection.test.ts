import { describe, expect, it } from 'vitest';
import { applySharedDetails, draftOf, materialise, moveItem, uniqueNames } from '../src/collection';
import { emptyMetadata } from '../src/epub';
import type { Book } from '../src/types';
const book = (id: string): Book => ({ ...emptyMetadata('Volume ' + id), id, filename: id + '.epub', format: 'epub', size: 12, added: '', updated: '', authors: ['Individual author'], cover: 'cover-' + id, tags: ['original'] });
describe('collection editing', () => {
  it('only applies explicitly selected shared fields and preserves individual titles and covers', () => {
    const originals = [book('1'), book('2')];
    const result = applySharedDetails(originals, { series: 'Shared series', tags: ['new', 'original'], appendTags: true });
    expect(result.map(item => item.title)).toEqual(['Volume 1', 'Volume 2']);
    expect(result.map(item => item.cover)).toEqual(['cover-1', 'cover-2']);
    expect(result.map(item => item.authors)).toEqual([['Individual author'], ['Individual author']]);
    expect(result[0].tags).toEqual(['original', 'new']);
    expect(originals[0].series).toBe(''); expect(originals[0].tags).toEqual(['original']);
  });
  it('numbers the books in the current order, after reordering', () => {
    const result = applySharedDetails(moveItem([book('1'), book('2'), book('3')], 2, 0), { series: 'Saga', startNumber: 1 });
    expect(result.map(item => [item.id, item.seriesIndex])).toEqual([['3', '1'], ['1', '2'], ['2', '3']]);
  });
  it('lets a deliberately empty shared value clear a field without clearing unchecked fields', () => {
    const result = applySharedDetails([book('1')], { authors: [], tags: [], appendTags: false });
    expect(result[0].authors).toEqual([]); expect(result[0].tags).toEqual([]); expect(result[0].title).toBe('Volume 1');
  });
  it('rejects invalid sequence numbers before changing any books', () => {
    for (const startNumber of [NaN, Infinity, -1]) expect(() => applySharedDetails([book('1')], { startNumber })).toThrow('numberInvalid');
  });
  it('retains per-book draft text while normalising only when saving', () => {
    const draft = draftOf(book('1')); draft.authorsText = 'Alice\nBob\n'; draft.tagsText = 'fiction, favourites, ';
    expect(materialise(draft).authors).toEqual(['Alice', 'Bob']); expect(materialise(draft).tags).toEqual(['fiction', 'favourites']);
    expect(draft.authorsText).toBe('Alice\nBob\n');
  });
  it('keeps every file when titles collide, including case and pre-existing numbered names', () => {
    const names = uniqueNames(['Saga.kepub.epub', 'saga.kepub.epub', 'Saga-2.kepub.epub', 'Saga.kepub.epub']);
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(4);
    expect(names.every(name => name.endsWith('.kepub.epub'))).toBe(true);
  });
});
