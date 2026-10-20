import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { listBooks, original, saveBook, saveBooks } from '../src/library';
import { emptyMetadata } from '../src/epub';
import type { Book } from '../src/types';
const makeBook = (id: string): Book => ({ ...emptyMetadata('Original ' + id), id, filename: id + '.epub', format: 'epub', size: 3, added: '', updated: '' });
describe('atomic collection save', () => {
  beforeEach(async () => { await saveBook(makeBook('a'), new Uint8Array([1, 2, 3])); await saveBook(makeBook('b'), new Uint8Array([4, 5, 6])); });
  it('saves every edited volume and leaves original book bytes unchanged', async () => {
    await saveBooks([{ ...makeBook('a'), title: 'Edited A' }, { ...makeBook('b'), title: 'Edited B' }]);
    expect((await listBooks()).map(book => book.title)).toEqual(['Edited A', 'Edited B']);
    expect(await original('a')).toEqual(new Uint8Array([1, 2, 3])); expect(await original('b')).toEqual(new Uint8Array([4, 5, 6]));
  });
  it('rejects missing titles without saving even the valid first volume', async () => {
    await expect(saveBooks([{ ...makeBook('a'), title: 'Edited A' }, { ...makeBook('b'), title: ' ' }])).rejects.toThrow('titleRequired');
    expect((await listBooks()).map(book => book.title)).toEqual(['Original a', 'Original b']);
  });
  it('rolls back earlier writes if a later record fails to clone', async () => {
    const invalid = { ...makeBook('b'), notCloneable: () => {} } as Book;
    await expect(saveBooks([{ ...makeBook('a'), title: 'Edited A' }, invalid])).rejects.toThrow();
    expect((await listBooks()).map(book => book.title)).toEqual(['Original a', 'Original b']);
  });
});
