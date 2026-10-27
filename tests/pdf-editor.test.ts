// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectionEditor } from '../src/CollectionEditor';
import { I18nProvider } from '../src/i18n';
import { emptyMetadata } from '../src/epub';
import type { Book } from '../src/types';
import { coverDataURL } from './cover-fixture';

vi.mock('../src/native', () => ({ isAndroid: true, dataURL: vi.fn() }));
let root: Root, container: HTMLDivElement;
const onExport = vi.fn();
const book: Book = { ...emptyMetadata('PDF book'), id: '123', filename: 'book.pdf', format: 'pdf', size: 100, added: '', updated: '' };
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => (item.querySelector('strong')?.textContent ?? item.textContent) === label)!;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(source = book) {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(CollectionEditor, {
    books: [source], busy: false, onClose: vi.fn(), onSave: vi.fn(), onRemove: vi.fn(), onExport,
  }))));
  await act(async () => button('Export & send').click());
}

it('offers KEPUB, EPUB and the original PDF with an explanation of font/layout preservation', async () => {
  await mount();
  const select = container.querySelector('select[aria-label="Output format"]')!;
  expect(Array.from(select.querySelectorAll('option')).map(item => item.textContent)).toEqual(['KEPUB', 'EPUB', 'PDF (original)']);
  expect(container.textContent).toContain('Unicode characters and language tags');
  expect(button('Convert and save KEPUB')).toBeDefined();
});

it.each([
  ['kepub', 'Convert and save KEPUB', 'Convert to KEPUB & send to Kobo'],
  ['epub', 'Convert and save EPUB', 'Convert to EPUB & send to Kobo'],
  ['original', 'Save original PDF', 'Send to Kobo'],
])('uses the selected %s format for both save and send', async (format, save, send) => {
  await mount();
  const select = container.querySelector('select')!;
  await act(async () => { select.value = format; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button(save).click());
  expect(onExport).toHaveBeenLastCalledWith([book], format);
  await act(async () => button(send).click());
  expect(onExport).toHaveBeenLastCalledWith([book], format, true);
});

it.each([
  { ...book, format: 'pdf' as const, filename: 'book.pdf' },
  { ...book, format: 'epub' as const, filename: 'book.epub' },
  { ...book, format: 'epub' as const, filename: 'book.kepub.epub' },
])('always offers Change cover for $filename', async source => {
  await mount(source);
  expect(button('Change cover')).toBeDefined();
  expect(container.querySelector('input[type="file"][accept="image/jpeg,image/png"]')).not.toBeNull();
});

it('offers PDF with chosen cover for both save and send and explains the first-page and sleep-screen behaviour', async () => {
  const source = { ...book, cover: coverDataURL(), customCover: coverDataURL() };
  await mount(source);
  const select = container.querySelector('select')!;
  expect(select.querySelector('option[value="original"]')?.textContent).toBe('PDF (chosen cover)');
  await act(async () => { select.value = 'original'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('first page of the exported PDF');
  expect(container.textContent).toContain('Show current read');
  await act(async () => button('Save PDF with chosen cover').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'original');
  await act(async () => button('Send to Kobo').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'original', true);
});
