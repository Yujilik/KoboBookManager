// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { Filesystem } from '@capacitor/filesystem';
import { native, fromBase64 } from '../src/native';
import { original } from '../src/library';
import { convert } from '../src/converter';
import { emptyMetadata, readEpub } from '../src/epub';
import { exportCollection, filename, type ExportOptions } from '../src/export';
import { pdfToEpub } from '../src/pdf';
import { translator } from '../src/messages';
import type { Book, ExportFormat } from '../src/types';
import { fixture } from './fixtures';
import { pdfFixture } from './pdf-fixture';
import { coverDataURL, coverFixture } from './cover-fixture';
import { PDFDocument } from 'pdf-lib';
import type { PdfConversionOptions } from '../src/pdf-ocr-options';

vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: { writeFile: vi.fn(), stat: vi.fn(), deleteFile: vi.fn() } }));
vi.mock('../src/native', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native')>(),
  isAndroid: true,
  native: { saveDocument: vi.fn(), startDelivery: vi.fn(), stopDelivery: vi.fn() },
}));
vi.mock('../src/library', () => ({ original: vi.fn() }));
vi.mock('../src/converter', () => ({ convert: vi.fn() }));
vi.mock('../src/pdf', () => ({ pdfToEpub: vi.fn() }));

let converted: Uint8Array, extracted: Uint8Array;
const cache = new Map<string, Uint8Array>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const book = (id = 'one'): Book => ({ ...emptyMetadata('Edited title'), id, filename: 'original.epub', format: 'epub', size: 100, added: '', updated: '' });
const send = (books: Book[], format: ExportFormat = 'kepub') => exportCollection(books, format, true, 'en-GB', translator('en-GB'), vi.fn());

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  cache.clear();
  extracted = await fixture('3.0', false);
  converted = await fixture('3.0', true);
  vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
    cache.set(path, fromBase64(data as string));
    return { uri: `file:///cache/${path}` };
  });
  vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => ({
    type: 'file', name: 'payload', size: cache.get(path)!.byteLength, uri: `file:///cache/${path}`, ctime: 0, mtime: 0,
  }));
  vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => { cache.delete(path); });
  vi.mocked(original).mockResolvedValue(await fixture('3.0', false));
  vi.mocked(convert).mockResolvedValue(converted);
  vi.mocked(pdfToEpub).mockResolvedValue(extracted);
  vi.mocked(native.saveDocument).mockImplementation(async ({ size, sha256 }) => ({ uri: 'content://saved/book', size, sha256 }));
  vi.mocked(native.startDelivery).mockImplementation(async ({ files }) => ({
    urls: ['http://localhost:8080'], code: '123456', port: 8080,
    files: files.map(({ name, mime, size, sha256 }) => ({ name, mime, size, sha256 })),
  }));
  vi.mocked(native.stopDelivery).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('convert and send in one operation', () => {
  it('applies edits, converts and delivers the converted bytes without opening a save dialog', async () => {
    const delivery = await send([book()]);
    const input = vi.mocked(convert).mock.calls[0][0];
    expect((await readEpub(input)).metadata.title).toBe('Edited title');
    const saved = vi.mocked(Filesystem.writeFile).mock.calls[0][0];
    expect(fromBase64(saved.data as string)).toEqual(converted);
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ path: saved.path, name: 'Edited title.kepub.epub', mime: 'application/epub+zip' })],
    }));
    expect(native.saveDocument).not.toHaveBeenCalled();
    expect(delivery?.code).toBe('123456');
  });

  it('converts every selected EPUB before opening a single delivery session', async () => {
    await send([book('one'), book('two')]);
    expect(convert).toHaveBeenCalledTimes(2);
    const files = vi.mocked(native.startDelivery).mock.calls[0][0].files!;
    expect(files.map(file => file.name)).toEqual(['Edited title.kepub.epub', 'Edited title-2.kepub.epub']);
    expect(native.startDelivery).toHaveBeenCalledTimes(1);
    for (const [saved] of vi.mocked(Filesystem.writeFile).mock.calls) expect(fromBase64(saved.data as string)).toEqual(converted);
    expect(native.saveDocument).not.toHaveBeenCalled();
  });

  it('does not open delivery if conversion fails', async () => {
    vi.mocked(convert).mockRejectedValue(new Error('conversion failed'));
    await expect(send([book()])).rejects.toThrow('conversion failed');
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it('sends existing KEPUBs without reconverting and still applies metadata edits', async () => {
    await send([{ ...book(), filename: 'original.kepub.epub' }]);
    expect(convert).not.toHaveBeenCalled();
    const saved = vi.mocked(Filesystem.writeFile).mock.calls[0][0];
    expect((await readEpub(fromBase64(saved.data as string))).metadata.title).toBe('Edited title');
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ name: 'Edited title.kepub.epub' })],
    }));
  });

  it('continues to send PDF bytes unchanged', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 example');
    vi.mocked(original).mockResolvedValue(pdf);
    await send([{ ...book(), format: 'pdf', filename: 'original.pdf' }], 'original');
    expect(convert).not.toHaveBeenCalled();
    expect(Array.from(fromBase64(vi.mocked(Filesystem.writeFile).mock.calls[0][0].data as string))).toEqual(Array.from(pdf));
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ name: 'Edited title.pdf', mime: 'application/pdf' })],
    }));
  });

  it.each(['epub', 'kepub'] as const)('converts a PDF to %s before delivery with the correct extension and MIME', async format => {
    const pdf = new TextEncoder().encode('%PDF-1.7 original');
    vi.mocked(original).mockResolvedValue(pdf);
    const source = { ...book(), format: 'pdf' as const, filename: 'original.pdf' };
    await send([source], format);
    expect(pdfToEpub).toHaveBeenCalledWith(pdf, source, expect.any(Function));
    const saved = fromBase64(vi.mocked(Filesystem.writeFile).mock.calls[0][0].data as string);
    if (format === 'kepub') {
      expect(convert).toHaveBeenCalledWith(extracted, expect.any(Function));
      expect(saved).toEqual(converted);
    } else {
      expect(convert).not.toHaveBeenCalled();
      expect(saved).toEqual(extracted);
    }
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ name: `Edited title.${format === 'kepub' ? 'kepub.epub' : 'epub'}`, mime: 'application/epub+zip' })],
    }));
  });

  it.each(['epub', 'kepub'] as const)('saves a converted PDF as %s rather than silently exporting the original PDF', async format => {
    const source = { ...book(), format: 'pdf' as const, filename: 'original.pdf' };
    await exportCollection([source], format, false, 'en-GB', translator('en-GB'), vi.fn());
    expect(native.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
      name: `Edited title.${format === 'kepub' ? 'kepub.epub' : 'epub'}`, mime: 'application/epub+zip',
    }));
    const options = vi.mocked(native.saveDocument).mock.calls[0][0];
    const bytes = format === 'kepub' ? converted : extracted;
    expect(options).toEqual({
      path: expect.stringMatching(/^exports\/[^/]+\/payload$/),
      name: `Edited title.${format === 'kepub' ? 'kepub.epub' : 'epub'}`,
      mime: 'application/epub+zip', size: bytes.length, sha256: hash(bytes),
    });
    expect(options).not.toHaveProperty('data');
    expect(Filesystem.deleteFile).toHaveBeenCalledWith({ directory: 'CACHE', path: options.path });
    expect(cache.size).toBe(0);
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it('does not save or deliver a PDF when conversion fails', async () => {
    vi.mocked(pdfToEpub).mockRejectedValue(new Error('conversionFailed'));
    await expect(send([{ ...book(), format: 'pdf', filename: 'original.pdf' }])).rejects.toThrow('conversionFailed');
    expect(convert).not.toHaveBeenCalled();
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.saveDocument).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it('sends a PDF with the selected cover as its first page while keeping the original PDF bytes intact', async () => {
    const source = pdfFixture(), copy = source.slice();
    vi.mocked(original).mockResolvedValue(source);
    await send([{ ...book(), format: 'pdf', filename: 'original.pdf', customCover: coverDataURL() }], 'original');
    const output = fromBase64(vi.mocked(Filesystem.writeFile).mock.calls[0][0].data as string);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
    expect(source).toEqual(copy);
    expect(pdfToEpub).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.objectContaining({ name: 'Edited title.pdf', mime: 'application/pdf' })] }));
  });

  it.each(['epub', 'kepub'] as const)('passes the chosen cover to the PDF-to-%s conversion', async format => {
    const cover = coverFixture();
    const source = { ...book(), format: 'pdf' as const, filename: 'source.pdf', customCover: coverDataURL(cover) };
    await send([source], format);
    expect(pdfToEpub).toHaveBeenCalledWith(expect.any(Uint8Array), source, expect.any(Function), cover);
  });

  it.each(['epub', 'kepub'] as const)('forwards recognition languages to PDF-to-%s for saving and sending, with or without a custom cover', async format => {
    const options: PdfConversionOptions = { ocrLanguages: ['eng', 'jpn', 'tha'] };
    for (const delivery of [false, true]) for (const customCover of [undefined, coverDataURL()]) {
      const source = { ...book(), format: 'pdf' as const, filename: 'source.pdf', customCover };
      await exportCollection([source], format, delivery, 'en-GB', translator('en-GB'), vi.fn(), options);
      expect(pdfToEpub).toHaveBeenLastCalledWith(expect.any(Uint8Array), source, expect.any(Function), customCover ? coverFixture() : undefined, options);
    }
  });

  it.each(['epub', 'kepub'] as const)('reports text recognition distinctly while preserving the PDF-to-%s progress scale', async format => {
    vi.mocked(pdfToEpub).mockImplementation(async (_bytes, _metadata, progress) => {
      progress(40, 'ocr'); progress(100);
      return extracted;
    });
    const status = vi.fn(), t = translator('en-GB');
    await exportCollection([{ ...book(), format: 'pdf', filename: 'scan.pdf' }], format, false, 'en-GB', t, status, { ocrLanguages: ['eng'] });
    expect(status).toHaveBeenCalledWith(t('recognizing', { index: 1, count: 1, progress: format === 'kepub' ? 28 : 40 }));
    expect(status).toHaveBeenCalledWith(t('converting', { index: 1, count: 1, progress: format === 'kepub' ? 70 : 100 }));
  });

  it.each([false, true])('uses each PDF recognition languages in a mixed collection (send: %s)', async delivery => {
    const japanese = { ...book('japanese'), format: 'pdf' as const, filename: 'japanese.pdf', language: 'ja' };
    const thai = { ...book('thai'), format: 'pdf' as const, filename: 'thai.pdf', language: 'th' };
    const options: ExportOptions = { ocrLanguages: ['eng'], pdfByBook: {
      japanese: { ocrLanguages: ['eng', 'jpn'] }, thai: { ocrLanguages: ['tha'] },
    } };
    await exportCollection([book(), japanese, thai], 'kepub', delivery, 'en-GB', translator('en-GB'), vi.fn(), options);
    expect(pdfToEpub).toHaveBeenCalledTimes(2);
    expect(pdfToEpub).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), japanese, expect.any(Function), undefined, options.pdfByBook!.japanese);
    expect(pdfToEpub).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), thai, expect.any(Function), undefined, options.pdfByBook!.thai);
    expect(convert).toHaveBeenCalledTimes(3);
  });

  it('uses base options only for PDFs without their own override and does not pass the collection map to the PDF engine', async () => {
    const first = { ...book('one'), format: 'pdf' as const, filename: 'one.pdf' };
    const second = { ...book('two'), format: 'pdf' as const, filename: 'two.pdf' };
    const options: ExportOptions = { ocrLanguages: ['eng'], pdfByBook: { two: { ocrLanguages: ['tha'] } } };
    await exportCollection([first, second], 'epub', true, 'en-GB', translator('en-GB'), vi.fn(), options);
    expect(pdfToEpub).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), first, expect.any(Function), undefined, { ocrLanguages: ['eng'] });
    expect(pdfToEpub).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), second, expect.any(Function), undefined, { ocrLanguages: ['tha'] });
  });

  it('rejects an empty recognition selection on any converted PDF before reading or staging the collection', async () => {
    const scan = { ...book('scan'), format: 'pdf' as const, filename: 'scan.pdf' };
    const options: ExportOptions = { pdfByBook: { scan: { ocrLanguages: [] } } };
    await expect(exportCollection([book(), scan], 'kepub', true, 'en-GB', translator('en-GB'), vi.fn(), options)).rejects.toThrow('pdfOcrFailed');
    expect(original).not.toHaveBeenCalled();
    expect(pdfToEpub).not.toHaveBeenCalled();
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it('does not run text recognition when original PDF output is selected', async () => {
    const pdf = pdfFixture(); vi.mocked(original).mockResolvedValue(pdf);
    await exportCollection([{ ...book(), format: 'pdf', filename: 'scan.pdf' }], 'original', false, 'en-GB', translator('en-GB'), vi.fn(), { ocrLanguages: ['eng'] });
    expect(pdfToEpub).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it.each(['original.epub', 'original.kepub.epub'])('embeds the chosen cover before sending %s to Kobo', async name => {
    const cover = coverFixture();
    await send([{ ...book(), filename: name, customCover: coverDataURL(cover) }]);
    const bytes = name.endsWith('.kepub.epub')
      ? fromBase64(vi.mocked(Filesystem.writeFile).mock.calls[0][0].data as string)
      : vi.mocked(convert).mock.calls[0][0];
    expect((await readEpub(bytes)).cover).toEqual(cover);
  });

  it('preserves the KEPUB filename when exporting the edited source format', () => {
    expect(filename({ ...book(), filename: 'source.kepub.epub' }, 'original')).toBe('Edited title.kepub.epub');
  });

  it('does not deliver an unchanged PDF when applying its cover fails', async () => {
    vi.mocked(original).mockResolvedValue(new TextEncoder().encode('%PDF-1.7 broken'));
    await expect(send([{ ...book(), format: 'pdf', customCover: coverDataURL() }], 'original')).rejects.toThrow('pdfCoverFailed');
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
    expect(native.saveDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', new Uint8Array()],
    ['PDF', new TextEncoder().encode('%PDF-1.7 original source')],
    ['corrupt ZIP', new Uint8Array([80, 75, 3, 4, 0, 0])],
  ] as const)('rejects %s PDF-to-EPUB output for both saving and delivery without a source fallback', async (_label, bytes) => {
    vi.mocked(original).mockResolvedValue(pdfFixture());
    vi.mocked(pdfToEpub).mockResolvedValue(bytes);
    const source = { ...book(), format: 'pdf' as const, filename: 'original.pdf' };
    for (const delivery of [false, true]) {
      await expect(exportCollection([source], 'epub', delivery, 'en-GB', translator('en-GB'), vi.fn())).rejects.toThrow();
    }
    expect(convert).not.toHaveBeenCalled();
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.saveDocument).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', new Uint8Array()],
    ['PDF', new TextEncoder().encode('%PDF-1.7 original source')],
    ['corrupt ZIP', new Uint8Array([80, 75, 3, 4, 0, 0])],
  ] as const)('rejects %s KEPUB output for both saving and delivery without a source fallback', async (_label, bytes) => {
    vi.mocked(original).mockResolvedValue(pdfFixture());
    vi.mocked(convert).mockResolvedValue(bytes);
    const source = { ...book(), format: 'pdf' as const, filename: 'original.pdf' };
    for (const delivery of [false, true]) {
      await expect(exportCollection([source], 'kepub', delivery, 'en-GB', translator('en-GB'), vi.fn())).rejects.toThrow();
    }
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(native.saveDocument).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it.each([0, 1])('rejects a %s-byte staged file and discards it before opening save or delivery', async size => {
    vi.mocked(Filesystem.stat).mockResolvedValue({ type: 'file', name: 'payload', size, uri: 'file:///cache/payload', ctime: 0, mtime: 0 });
    for (const delivery of [false, true]) {
      await expect(exportCollection([book()], 'kepub', delivery, 'en-GB', translator('en-GB'), vi.fn())).rejects.toThrow('outputInvalid');
    }
    expect(native.saveDocument).not.toHaveBeenCalled();
    expect(native.startDelivery).not.toHaveBeenCalled();
    expect(Filesystem.deleteFile).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it.each(['size', 'sha256', 'uri'] as const)('rejects an invalid save %s receipt and releases the staged copy', async field => {
    vi.mocked(native.saveDocument).mockImplementation(async ({ size, sha256 }) => ({
      size: field === 'size' ? 0 : size,
      sha256: field === 'sha256' ? '0'.repeat(64) : sha256,
      uri: field === 'uri' ? '' : 'content://saved/book',
    }));
    await expect(exportCollection([book()], 'kepub', false, 'en-GB', translator('en-GB'), vi.fn())).rejects.toThrow('outputInvalid');
    expect(cache.size).toBe(0);
    expect(Filesystem.deleteFile).toHaveBeenCalledOnce();
  });

  it.each(['size', 'sha256', 'mime', 'name', 'missing'] as const)('stops delivery and releases staged files on an invalid %s receipt', async field => {
    vi.mocked(native.startDelivery).mockImplementation(async ({ files }) => ({
      urls: ['http://localhost:8080'], code: '123456', port: 8080,
      files: field === 'missing' ? [] : files.map(({ name, mime, size, sha256 }) => ({
        name: field === 'name' ? 'source.pdf' : name,
        mime: field === 'mime' ? 'application/pdf' : mime,
        size: field === 'size' ? 0 : size,
        sha256: field === 'sha256' ? '0'.repeat(64) : sha256,
      })),
    }));
    await expect(send([book()])).rejects.toThrow('outputInvalid');
    expect(native.stopDelivery).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it('cleans up previously staged books if a later conversion fails', async () => {
    vi.mocked(convert).mockResolvedValueOnce(converted).mockRejectedValueOnce(new Error('conversionFailed'));
    await expect(send([book('one'), book('two')])).rejects.toThrow('conversionFailed');
    expect(Filesystem.writeFile).toHaveBeenCalledOnce();
    expect(Filesystem.deleteFile).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
    expect(native.startDelivery).not.toHaveBeenCalled();
  });

  it('releases the staged copy if the document picker is cancelled', async () => {
    vi.mocked(native.saveDocument).mockRejectedValue(new Error('cancelled'));
    await expect(exportCollection([book()], 'kepub', false, 'en-GB', translator('en-GB'), vi.fn())).rejects.toThrow('cancelled');
    expect(cache.size).toBe(0);
    expect(native.startDelivery).not.toHaveBeenCalled();
  });
});
