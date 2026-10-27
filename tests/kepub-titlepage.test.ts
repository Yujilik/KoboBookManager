// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { fixture } from './fixtures';
import { kepubWithWasm } from './kepub-fixture';

async function book(title: string | undefined) {
  const zip = await JSZip.loadAsync(await fixture('3.0', false));
  const encode = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  zip.file('OEBPS/book.opf', (await zip.file('OEBPS/book.opf')!.async('string')).replace('Um livro de exemplo', title === undefined ? ' ' : encode(title)));
  zip.file('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Reading chapter</title></head><body><p>' + 'Paragraph material long enough for an ordinary reading page. '.repeat(12) + '</p><p id="target">A real target</p><a href="#target">Follow this link</a></body></html>');
  zip.file('OEBPS/preserved.bin', new Uint8Array([0, 255, 128, 80, 75, 9, 0]));
  return zip.generateAsync({ type: 'uint8array' });
}

it('gives the generated Kobo dummy page a nonempty escaped book title while retaining the layout fix and other ZIP data', async () => {
  const title = '日本語 & notes <for readers>';
  const converted = await kepubWithWasm(await book(title));
  const zip = await JSZip.loadAsync(converted, { checkCRC32: true });
  const dummy = zip.file('OEBPS/kepubify-titlepage-dummy.xhtml');
  expect(dummy).not.toBeNull();
  const document = new DOMParser().parseFromString(await dummy!.async('string'), 'application/xhtml+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  expect(document.querySelector('title')?.textContent).toBe(title);
  expect(document.querySelector('body')?.textContent).toContain('Page intentionally left blank by kepubify.');
  const opf = await zip.file('OEBPS/book.opf')!.async('string');
  expect(opf).toContain('idref="kepubify-titlepage-dummy"');
  expect(await zip.file('OEBPS/chapter.xhtml')!.async('string')).toContain('href="#target"');
  expect(await zip.file('OEBPS/chapter.xhtml')!.async('string')).toContain('koboSpan');
  expect(await zip.file('OEBPS/preserved.bin')!.async('uint8array')).toEqual(new Uint8Array([0, 255, 128, 80, 75, 9, 0]));
  const header = new DataView(converted.buffer, converted.byteOffset, converted.byteLength);
  expect(header.getUint16(8, true)).toBe(0); // First EPUB entry remains uncompressed mimetype.
  expect(new TextDecoder().decode(converted.subarray(30, 38))).toBe('mimetype');
}, 30_000);

it('uses a valid fallback when the source metadata supplies no usable title', async () => {
  const zip = await JSZip.loadAsync(await kepubWithWasm(await book(undefined)));
  const document = new DOMParser().parseFromString(await zip.file('OEBPS/kepubify-titlepage-dummy.xhtml')!.async('string'), 'application/xhtml+xml');
  expect(document.querySelector('title')?.textContent).toBe('Title page');
}, 30_000);
