// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Filesystem } from '@capacitor/filesystem';
import { native, fromBase64 } from '../src/native';
import { original } from '../src/library';
import { convert } from '../src/converter';
import { emptyMetadata, readEpub } from '../src/epub';
import { exportCollection } from '../src/export';
import { translator } from '../src/messages';
import type { Book } from '../src/types';
import { fixture } from './fixtures';

vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: { writeFile: vi.fn() } }));
vi.mock('../src/native', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native')>(),
  isAndroid: true,
  native: { saveDocument: vi.fn(), startDelivery: vi.fn() },
}));
vi.mock('../src/library', () => ({ original: vi.fn() }));
vi.mock('../src/converter', () => ({ convert: vi.fn() }));

const converted = new Uint8Array([75, 69, 80, 85, 66]);
const book = (id = 'one'): Book => ({ ...emptyMetadata('Edited title'), id, filename: 'original.epub', format: 'epub', size: 100, added: '', updated: '' });
const send = (books: Book[], kepub = true) => exportCollection(books, kepub, true, 'en-GB', translator('en-GB'), vi.fn());

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(original).mockResolvedValue(await fixture('3.0', false));
  vi.mocked(convert).mockResolvedValue(converted);
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

  it('continues to send PDF bytes unchanged', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 example');
    vi.mocked(original).mockResolvedValue(pdf);
    await send([{ ...book(), format: 'pdf', filename: 'original.pdf' }], false);
    expect(convert).not.toHaveBeenCalled();
    expect(Array.from(fromBase64(vi.mocked(Filesystem.writeFile).mock.calls[0][0].data as string))).toEqual(Array.from(pdf));
    expect(native.startDelivery).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ name: 'Edited title.pdf', mime: 'application/pdf' })],
    }));
  });
});
