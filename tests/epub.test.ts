// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { editEpub, emptyMetadata, readEpub } from '../src/epub';
import { fixture } from './fixtures';

describe('EPUB metadata and covers', () => {
  it('reads OPF metadata and keeps EPUB 3 translators out of the author list', async () => {
    const result = await readEpub(await fixture('3.0'));
    expect(result.metadata.title).toBe('Um livro de exemplo');
    expect(result.metadata.authors).toEqual(['Autor original']);
    expect(result.cover?.mime).toBe('image/png');
  });

  it.each(['2.0', '3.0'])('writes metadata and replaces the actual cover page in EPUB %s', async version => {
    const original = await fixture(version);
    const metadata = { ...emptyMetadata('Título & novo <seguro>'), authors: ['Autora A', 'Autor B'], language: 'pt-BR', publisher: 'Editora', series: 'Minha série', seriesIndex: '2.5', isbn: '9781234567890', tags: ['ficção', 'favoritos'], description: 'Descrição com & e <texto>.' };
    const bytes = await editEpub(original, metadata, { bytes: new Uint8Array([255, 216, 255, 0]), mime: 'image/jpeg' });
    const result = await readEpub(bytes);
    expect(result.metadata).toEqual(metadata);
    expect(result.cover?.mime).toBe('image/jpeg');
    expect(result.cover?.bytes).toEqual(new Uint8Array([255, 216, 255, 0]));
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file('OEBPS/book.opf')!.async('string');
    expect(opf).toContain('urn:uuid:original-identifier');
    expect(opf).toContain('Tradutor original');
    expect(opf).toContain('refines="#translator"');
    const page = await zip.file('OEBPS/cover.xhtml')!.async('string');
    expect(page).not.toContain('images/cover.png');
    expect(page).toMatch(/kbm-cover-.*\.jpg/);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(0);
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe('mimetype');
    expect((await readEpub(original)).metadata.title).toBe('Um livro de exemplo');
  });

  it('creates a cover page and inserts it into the spine when none exists', async () => {
    const bytes = await editEpub(await fixture('3.0', false), emptyMetadata('Sem capa antes'), { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const zip = await JSZip.loadAsync(bytes);
    const opf = new DOMParser().parseFromString(await zip.file('OEBPS/book.opf')!.async('string'), 'application/xml');
    const first = opf.getElementsByTagNameNS('*', 'itemref')[0].getAttribute('idref');
    expect(first).toMatch(/^kbm-titlepage-/);
    const manifest = Array.from(opf.getElementsByTagNameNS('*', 'item')).find(x => x.id === first)!;
    expect(zip.file('OEBPS/' + manifest.getAttribute('href'))).not.toBeNull();
    expect((await readEpub(bytes)).cover?.mime).toBe('image/png');
  });

  it('removes an old series without leaving dangling refinements', async () => {
    const first = await editEpub(await fixture('3.0'), { ...emptyMetadata('Livro'), series: 'Série', seriesIndex: '4' });
    const second = await editEpub(first, emptyMetadata('Livro'));
    const zip = await JSZip.loadAsync(second);
    const opf = await zip.file('OEBPS/book.opf')!.async('string');
    expect(opf).not.toContain('group-position');
    expect((await readEpub(second)).metadata.series).toBe('');
  });

  it('rejects protected content while accepting obfuscated fonts', async () => {
    const zip = await JSZip.loadAsync(await fixture());
    zip.file('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptionMethod xmlns="http://www.w3.org/2001/04/xmlenc#" Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></encryption>');
    await expect(readEpub(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('DRM');
    zip.file('META-INF/encryption.xml', '<encryption><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></encryption>');
    await expect(readEpub(await zip.generateAsync({ type: 'uint8array' }))).resolves.toBeDefined();
  });

  it('rejects non-EPUB archives and XML entity declarations', async () => {
    const zip = new JSZip(); zip.file('test.txt', 'Olá');
    await expect(readEpub(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('container.xml');
    zip.file('META-INF/container.xml', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><container/>');
    await expect(readEpub(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('entidades');
  });
});
