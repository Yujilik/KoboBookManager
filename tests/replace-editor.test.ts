// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectionEditor } from '../src/CollectionEditor';
import { I18nProvider } from '../src/i18n';
import { emptyMetadata } from '../src/epub';
import type { Book } from '../src/types';

vi.mock('../src/native', () => ({ isAndroid: true, isNative: true, dataURL: vi.fn() }));
let root: Root, container: HTMLDivElement;
const onExport = vi.fn(), onReplace = vi.fn();
let folders = ['content://tree/books'];
const folderBook = (id = 'one', filename = 'Book.epub'): Book => ({
  ...emptyMetadata('Title ' + id), id, filename, format: 'epub', size: 100, added: '', updated: '',
  sourceUri: 'content://tree/doc/' + id, sourceFolder: 'content://tree/books',
});
const buttons = () => Array.from(container.querySelectorAll('button'));
const button = (label: string) => buttons().find(item => (item.querySelector('strong')?.textContent ?? item.textContent) === label);
const click = (label: string) => act(async () => button(label)!.click());
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  folders = ['content://tree/books'];
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(books: Book[]) {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(CollectionEditor, {
    books, busy: false, onClose: vi.fn(), onSave: vi.fn(), onRemove: vi.fn(), onExport, onReplace, folders,
  }))));
  await click('Export');
}

it('names the tab Export and keeps convert-and-send as its own option', async () => {
  await mount([folderBook()]);
  expect(button('Export')!.className).toBe('selected');
  expect(button('Export & send')).toBeUndefined();
  await click('Convert to KEPUB & send to Kobo');
  expect(onExport).toHaveBeenLastCalledWith([folderBook()], 'kepub', true);
});

it('opens save-a-copy and replace-the-original choices under Convert and save', async () => {
  await mount([folderBook()]);
  expect(button('Save a copy')).toBeUndefined();
  await click('Convert and save KEPUB');
  expect(button('Convert and save KEPUB')!.getAttribute('aria-expanded')).toBe('true');
  expect(button('Save a copy')!.textContent).toContain('The original stays as it is.');
  expect(button('Replace the original')!.textContent).toContain('Book.epub becomes Book.kepub.epub in the same folder.');
  await click('Save a copy');
  expect(onExport).toHaveBeenLastCalledWith([folderBook()], 'kepub');
  expect(onReplace).not.toHaveBeenCalled();
});

it('asks before deleting the original and can be cancelled', async () => {
  await mount([folderBook()]);
  await click('Convert and save KEPUB');
  await click('Replace the original');
  expect(onReplace).not.toHaveBeenCalled();
  expect(container.querySelector('.save-choices [role="alert"]')!.textContent).toContain('Book.epub will be deleted from its folder once the KEPUB is saved and checked next to it.');
  await click('Cancel');
  expect(container.querySelector('.save-choices [role="alert"]')).toBeNull();
  await click('Replace the original');
  await click('Replace');
  expect(onReplace).toHaveBeenCalledOnce();
  expect(onReplace).toHaveBeenLastCalledWith([folderBook()]);
  expect(onExport).not.toHaveBeenCalled();
});

it('explains why a book added as a file cannot replace its original', async () => {
  const imported = { ...folderBook(), sourceUri: undefined, sourceFolder: undefined };
  await mount([imported]);
  await click('Convert and save KEPUB');
  const replace = button('Replace the original')!;
  expect(replace.disabled).toBe(true);
  expect(replace.textContent).toContain('Only for EPUBs added from a folder.');
  expect(button('Save a copy')!.disabled).toBe(false);
});

it('replaces a whole collection only when every book came from a folder', async () => {
  const books = [folderBook('one', 'a.epub'), folderBook('two', 'b.epub')];
  await mount(books);
  await click('Convert and save KEPUB');
  expect(button('Save a copy')!.textContent).toContain('one ZIP with every book');
  expect(button('Replace the originals')!.textContent).toContain('Each EPUB becomes a KEPUB in its own folder.');
  await click('Replace the originals');
  expect(container.querySelector('.save-choices [role="alert"]')!.textContent).toContain('The 2 EPUB files will be deleted');
  await click('Replace');
  expect(onReplace).toHaveBeenLastCalledWith(books);

  await act(async () => root.unmount()); root = createRoot(container);
  await mount([folderBook('one'), { ...folderBook('two'), sourceUri: undefined }]);
  await click('Convert and save KEPUB');
  expect(button('Replace the originals')!.disabled).toBe(true);
});

it('explains that a KEPUB has no EPUB to replace, alone or in a collection', async () => {
  await mount([folderBook('one', 'Already.kepub.epub')]);
  await click('Convert and save KEPUB');
  expect(button('Replace the original')!.disabled).toBe(true);
  expect(button('Replace the original')!.textContent).toContain('already KEPUB files have no EPUB to replace');

  await act(async () => root.unmount()); root = createRoot(container);
  await mount([folderBook('one', 'a.epub'), folderBook('two', 'b.KEPUB.epub')]);
  await click('Convert and save KEPUB');
  expect(button('Replace the originals')!.disabled).toBe(true);
  expect(button('Replace the originals')!.textContent).toContain('already KEPUB files');
});

it('asks for the folder to be connected again before replacing its books', async () => {
  folders = [];
  await mount([folderBook()]);
  await click('Convert and save KEPUB');
  expect(button('Replace the original')!.disabled).toBe(true);
  expect(button('Replace the original')!.textContent).toContain('is no longer connected');
  expect(button('Save a copy')!.disabled).toBe(false);
});

it('never offers to replace a PDF original', async () => {
  await mount([{ ...folderBook(), format: 'pdf', filename: 'Book.pdf' }]);
  expect(button('Replace the original')).toBeUndefined();
  expect(buttons().some(item => item.getAttribute('aria-expanded') !== null && item.textContent?.includes('Convert and save'))).toBe(false);
});
