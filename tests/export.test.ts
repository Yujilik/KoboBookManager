// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Filesystem } from '@capacitor/filesystem';
import { native, fromBase64 } from '../src/native';
import { original } from '../src/library';
import { convert } from '../src/converter';
import { emptyMetadata, readEpub } from '../src/epub';
import { exportCollection, filename } from '../src/export';
import { pdfToEpub } from '../src/pdf';
import { translator } from '../src/messages';
import type { Book, ExportFormat } from '../src/types';
import { fixture } from './fixtures';
import { pdfFixture } from './pdf-fixture';
import { coverDataURL, coverFixture } from './cover-fixture';
import { PDFDocument } from 'pdf-lib';

vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: { writeFile: vi.fn() } }));
vi.mock('../src/native', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native')>(),
  isAndroid: true,
  native: { saveDocument: vi.fn(), startDelivery: vi.fn() },
}));
vi.mock('../src/library', () => ({ original: vi.fn() }));
vi.mock('../src/converter', () => ({ convert: vi.fn() }));
vi.mock('../src/pdf', () => ({ pdfToEpub: vi.fn() }));

const converted = new Uint8Array([75, 69, 80, 85, 66]);
const book = (id = 'one'): Book => ({ ...emptyMetadata('Edited title'), id, filename: 'original.epub', format: 'epub', size: 100, added: '', updated: '' });
const send = (books: Book[], format: ExportFormat = 'kepub') => exportCollection(books, format, true, 'en-GB', translator('en-GB'), vi.fn());

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(original).mockResolvedValue(await fixture('3.0', false));
  vi.mocked(convert).mockResolvedValue(converted);
  vi.mocked(pdfToEpub).mockResolvedValue(await fixture('3.0', false));
  vi.mocked(native.startDelivery).mockResolvedValue({ urls: ['http://localhost:8080'], code: '123456', port: 8080 });
});

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
      expect(convert).toHaveBeenCalledWith(await fixture('3.0', false), expect.any(Function));
      expect(saved).toEqual(converted);
    } else {
      expect(convert).not.toHaveBeenCalled();
      expect(saved).toEqual(await fixture('3.0', false));
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
});
