// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { readBook } from '../src/book-import';
import { editEpub } from '../src/epub';
import { original, restore } from '../src/library';
import { fixture } from './fixtures';

it('imports, edits and restores a real EPUB larger than the previous 64 MB limit', async () => {
  const zip = await JSZip.loadAsync(await fixture('3.0', false));
  zip.file('OEBPS/images/large-illustration.bin', new Uint8Array(65 * 1024 * 1024));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024 * 1024);
  const imported = await readBook('Illustrated grammar', bytes);
  expect(imported.format).toBe('epub');
  const edited = await editEpub(bytes, { ...imported.metadata, title: 'Edited illustrated grammar' });
  expect((await readBook('Illustrated grammar', edited)).metadata.title).toBe('Edited illustrated grammar');

  const id = 'c'.repeat(64);
  const backup = new JSZip();
  backup.file('library.json', JSON.stringify({ version: 1, books: [{ ...imported.metadata, id, filename: 'grammar.epub', format: 'epub', size: bytes.byteLength, added: '', updated: '' }] }));
  backup.file('originals/' + id, bytes);
  expect(await restore(await backup.generateAsync({ type: 'uint8array', compression: 'STORE' }))).toBe(1);
  const restored = await original(id);
  expect(restored.byteLength).toBe(bytes.byteLength);
  expect((await readBook('Restored grammar', restored)).metadata.title).toBe(imported.metadata.title);
}, 30000);

it('still rejects an EPUB that declares excessive decompressed data before inflating it', async () => {
  const zip = await JSZip.loadAsync(await fixture('3.0', false));
  zip.file('large.bin', new Uint8Array([0]));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = new TextDecoder();
  let patched = false;
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const length = view.getUint16(offset + 28, true);
    if (name.decode(bytes.subarray(offset + 46, offset + 46 + length)) !== 'large.bin') continue;
    view.setUint32(offset + 24, 769 * 1024 * 1024, true); patched = true; break;
  }
  expect(patched).toBe(true);
  await expect(readBook('Oversized expansion', bytes)).rejects.toThrow('768 MB');
});
