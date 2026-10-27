import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { stageOutput } from '../src/output';

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { writeFile: vi.fn(), appendFile: vi.fn(), stat: vi.fn(), deleteFile: vi.fn() },
}));

const cache = new Map<string, Uint8Array>();
const decode = (data: string | Blob) => new Uint8Array(Buffer.from(data as string, 'base64'));
function largePdf(length = 2 * 256 * 1024 + 137) {
  const bytes = Uint8Array.from({ length }, (_, index) => (index * 17) % 256);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  return bytes;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  cache.clear();
  vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
    cache.set(path, decode(data));
    return { uri: `file:///cache/${path}` };
  });
  vi.mocked(Filesystem.appendFile).mockImplementation(async ({ path, data }) => {
    const existing = cache.get(path)!;
    const chunk = decode(data);
    const result = new Uint8Array(existing.length + chunk.length);
    result.set(existing); result.set(chunk, existing.length);
    cache.set(path, result);
  });
  vi.mocked(Filesystem.stat).mockImplementation(async ({ path }) => ({
    type: 'file', name: 'payload', size: cache.get(path)!.byteLength,
    uri: `file:///cache/${path}`, ctime: 0, mtime: 0,
  }));
  vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => { cache.delete(path); });
});

afterEach(() => vi.unstubAllGlobals());

describe('staging Android exports', () => {
  it('uses bounded bridge calls while preserving the full binary file and its hash', async () => {
    const source = largePdf();
    const result = await stageOutput(source, 'Large book.pdf', 'application/pdf');
    const saved = cache.get(result.path)!;
    expect(Buffer.from(saved)).toEqual(Buffer.from(source));
    expect(result).toMatchObject({
      name: 'Large book.pdf', mime: 'application/pdf', size: source.length,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    expect(Filesystem.writeFile).toHaveBeenCalledOnce();
    expect(Filesystem.appendFile).toHaveBeenCalledTimes(2);
    const calls = [...vi.mocked(Filesystem.writeFile).mock.calls, ...vi.mocked(Filesystem.appendFile).mock.calls];
    for (const [options] of calls) {
      expect(decode(options.data).length).toBeLessThanOrEqual(256 * 1024);
      expect(options.directory).toBe(Directory.Cache);
      expect(options.path).toBe(result.path);
      expect(options.encoding).toBeUndefined();
    }
    expect(Filesystem.deleteFile).not.toHaveBeenCalled();
  });

  it('waits for each append to finish before sending the next chunk', async () => {
    let finishFirst: (() => void) | undefined;
    vi.mocked(Filesystem.appendFile).mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; }));
    const pending = stageOutput(largePdf(), 'Large book.pdf', 'application/pdf');
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    expect(Filesystem.appendFile).toHaveBeenCalledOnce();
    expect(Filesystem.stat).not.toHaveBeenCalled();
    finishFirst!();
    // The delayed mock intentionally omitted one chunk; the final size check must reject it.
    await expect(pending).rejects.toThrow('outputInvalid');
    expect(Filesystem.appendFile).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('deletes the partial cache file when a later write fails and never returns it for saving', async () => {
    vi.mocked(Filesystem.appendFile).mockRejectedValueOnce(new Error('Disk full'));
    await expect(stageOutput(largePdf(), 'Large book.pdf', 'application/pdf')).rejects.toThrow('Disk full');
    expect(Filesystem.appendFile).toHaveBeenCalledOnce();
    expect(Filesystem.stat).not.toHaveBeenCalled();
    const { path } = vi.mocked(Filesystem.writeFile).mock.calls[0][0];
    expect(Filesystem.deleteFile).toHaveBeenCalledWith({ path, directory: Directory.Cache });
    expect(cache.size).toBe(0);
  });
});
