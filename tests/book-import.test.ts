// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { readBook } from '../src/book-import';
import { MAX_BOOK_SIZE } from '../src/epub';
import { translatedError } from '../src/i18n';
import { translator } from '../src/messages';
import { fixture } from './fixtures';

it.each(['Book without an extension', 'Book.pdf', 'Book.bin'])('imports EPUB content called %s', async name => {
  const result = await readBook(name, await fixture('3.0'));
  expect(result.format).toBe('epub');
  expect(result.metadata.title).toBe('Um livro de exemplo');
  expect(result.metadata.authors).toEqual(['Autor original']);
  expect(result.cover?.mime).toBe('image/png');
});

it.each(['Document without an extension', 'Document.epub', 'Document.bin'])('recognises PDF content called %s', async name => {
  const result = await readBook(name, new TextEncoder().encode('%PDF-1.7\nexample'));
  expect(result.format).toBe('pdf');
  expect(result.cover).toBeUndefined();
});

it('rejects unrelated files and ordinary ZIPs even when renamed to EPUB', async () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('not a book')]) {
    await expect(readBook('fake.epub', bytes)).rejects.toThrow('invalidBook');
  }
  const zip = new JSZip(); zip.file('document.txt', 'Not an EPUB');
  await expect(readBook('fake.epub', await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('container.xml');
  expect(translatedError(new Error('invalidBook'), translator('en-GB'))).toBe(translator('en-GB')('invalidBook'));
});

it('still checks DRM and size limits for extensionless books', async () => {
  const zip = await JSZip.loadAsync(await fixture());
  zip.file('META-INF/encryption.xml', '<encryption><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></encryption>');
  await expect(readBook('Protected book', await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('DRM');
  await expect(readBook('Large book', new Uint8Array(MAX_BOOK_SIZE + 1))).rejects.toThrow('fileTooLarge');
});
