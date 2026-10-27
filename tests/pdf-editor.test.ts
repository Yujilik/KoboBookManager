// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectionEditor } from '../src/CollectionEditor';
import { I18nProvider } from '../src/i18n';
import { emptyMetadata } from '../src/epub';
import type { Book } from '../src/types';
import { coverDataURL } from './cover-fixture';
import { defaultOcrLanguages, PDF_OCR_LANGUAGES, ocrLanguageNames, type PdfOcrLanguage } from '../src/pdf-ocr-options';

vi.mock('../src/native', () => ({ isAndroid: true, dataURL: vi.fn() }));
let root: Root, container: HTMLDivElement;
const onExport = vi.fn();
const book: Book = { ...emptyMetadata('PDF book'), id: '123', filename: 'book.pdf', format: 'pdf', size: 100, added: '', updated: '' };
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => (item.querySelector('strong')?.textContent ?? item.textContent) === label)!;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(source: Book | Book[] = book, busy = false) {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(CollectionEditor, {
    books: Array.isArray(source) ? source : [source], busy, onClose: vi.fn(), onSave: vi.fn(), onRemove: vi.fn(), onExport,
  }))));
  await act(async () => button('Export & send').click());
}

it('offers KEPUB, EPUB and the original PDF with an explanation of font/layout preservation', async () => {
  await mount();
  const select = container.querySelector('select[aria-label="Output format"]')!;
  expect(Array.from(select.querySelectorAll('option')).map(item => item.textContent)).toEqual(['KEPUB', 'EPUB', 'PDF (original)']);
  expect(container.textContent).toContain('adjustable text');
  expect(container.textContent).toContain('recognized automatically');
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
  if (format === 'original') expect(onExport).toHaveBeenLastCalledWith([book], format);
  else expect(onExport).toHaveBeenLastCalledWith([book], format, false, { ocrLanguages: defaultOcrLanguages(book) });
  await act(async () => button(send).click());
  if (format === 'original') expect(onExport).toHaveBeenLastCalledWith([book], format, true);
  else expect(onExport).toHaveBeenLastCalledWith([book], format, true, { ocrLanguages: defaultOcrLanguages(book) });
});

function recognitionInputs() { return [...container.querySelectorAll<HTMLInputElement>('.ocr-languages input')]; }
async function selectRecognitionLanguages(selected: PdfOcrLanguage[]) {
  await act(async () => {
    for (const input of recognitionInputs()) {
      const language = PDF_OCR_LANGUAGES.find(value => input.closest('label')!.textContent === ocrLanguageNames[value])!;
      if (input.checked !== selected.includes(language)) input.click();
    }
  });
}

it('offers offline OCR languages and forwards a mixed-language selection for saving and sending without editing metadata', async () => {
  const source = { ...book, language: 'ja', title: '日本語の本' };
  await mount(source);
  expect(recognitionInputs()).toHaveLength(9);
  const selected = recognitionInputs().filter(input => input.checked).map(input => input.closest('label')!.textContent);
  expect(selected).toEqual(defaultOcrLanguages(source).map(value => ocrLanguageNames[value]));
  expect(container.textContent).toContain('works offline');
  expect(container.textContent).toContain('never uploaded');
  await selectRecognitionLanguages(['eng', 'jpn', 'tha']);
  expect(button('Save details').disabled).toBe(true);
  await act(async () => button('Convert and save KEPUB').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'kepub', false, { ocrLanguages: ['eng', 'jpn', 'tha'] });
  await act(async () => button('Convert to KEPUB & send to Kobo').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'kepub', true, { ocrLanguages: ['eng', 'jpn', 'tha'] });
  expect(source.language).toBe('ja');
  expect(container.querySelector('.info-note')?.textContent).not.toContain('Save changes');
});

it('requires at least one OCR language for PDF conversion while leaving original-PDF export available', async () => {
  await mount();
  await selectRecognitionLanguages([]);
  expect(button('Convert and save KEPUB').disabled).toBe(true);
  expect(button('Convert to KEPUB & send to Kobo').disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Select at least one recognition language.');
  await act(async () => button('Convert and save KEPUB').click());
  expect(onExport).not.toHaveBeenCalled();
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'original'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('.ocr-options')).toBeNull();
  expect(button('Save original PDF').disabled).toBe(false);
  await act(async () => button('Save original PDF').click());
  expect(onExport).toHaveBeenLastCalledWith([book], 'original');
  await act(async () => { select.value = 'kepub'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(recognitionInputs().every(input => !input.checked)).toBe(true);
});

it('disables recognition language changes during a conversion', async () => {
  await mount(book, true);
  expect(recognitionInputs()).toHaveLength(9);
  expect(recognitionInputs().every(input => input.disabled)).toBe(true);
  expect(button('Convert and save KEPUB').disabled).toBe(true);
});

it('keeps existing EPUB export calls free of PDF recognition options', async () => {
  const source = { ...book, filename: 'book.epub', format: 'epub' as const };
  await mount(source);
  expect(container.querySelector('.ocr-options')).toBeNull();
  await act(async () => button('Convert and save KEPUB').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'kepub');
  await act(async () => button('Convert to KEPUB & send to Kobo').click());
  expect(onExport).toHaveBeenLastCalledWith([source], 'kepub', true);
});

it('keeps each PDF recognition selection when exporting a collection with an EPUB active', async () => {
  const japanese = { ...book, id: 'japanese', language: 'ja', title: 'Japanese PDF' };
  const thai = { ...book, id: 'thai', language: 'th', title: 'Thai PDF' };
  const epub = { ...book, id: 'epub', format: 'epub' as const, filename: 'other.epub', title: 'Other EPUB' };
  const sources = [japanese, thai, epub];
  await mount(sources);
  await selectRecognitionLanguages(['eng', 'jpn']);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.collection-item')[1].click());
  await selectRecognitionLanguages(['tha']);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.collection-item')[2].click());
  expect(container.querySelector('.ocr-options')).toBeNull();
  const options = { pdfByBook: { japanese: { ocrLanguages: ['eng', 'jpn'] }, thai: { ocrLanguages: ['tha'] } } };
  await act(async () => button('Convert collection to KEPUB ZIP').click());
  expect(onExport).toHaveBeenLastCalledWith(sources, 'kepub', false, options);
  await act(async () => button('Convert to KEPUB & send to Kobo').click());
  expect(onExport).toHaveBeenLastCalledWith(sources, 'kepub', true, options);
});

it('uses each unmodified PDF default rather than applying the active PDF languages to the collection', async () => {
  const japanese = { ...book, id: 'japanese', language: 'ja', title: 'Japanese PDF' };
  const thai = { ...book, id: 'thai', language: 'th', title: 'Thai PDF' };
  await mount([japanese, thai]);
  await act(async () => button('Convert and save KEPUB').click());
  expect(onExport).toHaveBeenCalledWith([japanese, thai], 'kepub', false, {
    pdfByBook: { japanese: { ocrLanguages: defaultOcrLanguages(japanese) }, thai: { ocrLanguages: defaultOcrLanguages(thai) } },
  });
});

it('blocks the converted collection when another PDF has no recognition languages while allowing original export', async () => {
  const other = { ...book, id: 'other', language: 'th', title: 'Other PDF' };
  const epub = { ...book, id: 'epub', format: 'epub' as const, filename: 'other.epub', title: 'Other EPUB' };
  const sources = [book, other, epub];
  await mount(sources);
  await selectRecognitionLanguages([]);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.collection-item')[1].click());
  expect(button('Convert and save KEPUB').disabled).toBe(true);
  expect(button('Convert to KEPUB & send to Kobo').disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Select at least one recognition language.');
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.collection-item')[2].click());
  expect(button('Convert collection to KEPUB ZIP').disabled).toBe(true);
  expect(button('Convert to KEPUB & send to Kobo').disabled).toBe(true);
  expect(button('Export edited EPUBs as ZIP').disabled).toBe(false);
  await act(async () => button('Convert collection to KEPUB ZIP').click());
  expect(onExport).not.toHaveBeenCalled();
  await act(async () => button('Export edited EPUBs as ZIP').click());
  expect(onExport).toHaveBeenLastCalledWith(sources, 'original');
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
