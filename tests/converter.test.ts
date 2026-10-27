// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { convert } from '../src/converter';
import { validateEpubOutput } from '../src/conversion-output';
import { fixture } from './fixtures';
import { kepubWithWasm } from './kepub-fixture';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  message(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const latest = () => FakeWorker.instances.at(-1)!;
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('accepts an actual EPUB result, verifies its package and retains the source bytes', async () => {
  const bytes = await fixture('3.0', false), before = bytes.slice();
  const promise = convert(bytes, vi.fn());
  const worker = latest();
  expect(worker.postMessage.mock.calls[0][0].buffer).not.toBe(bytes.buffer);
  worker.message({ type: 'success', kepub: bytes.slice().buffer });
  await expect(promise).resolves.toEqual(bytes);
  expect(bytes).toEqual(before);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('validates and accepts output from the real bundled KEPUB WASM converter', async () => {
  const input = await fixture('3.0', false);
  const converted = await kepubWithWasm(input);
  const promise = convert(input, vi.fn());
  latest().message({ type: 'success', kepub: converted.slice().buffer });
  const output = await promise;
  const zip = await JSZip.loadAsync(output);
  expect(await zip.file('OEBPS/chapter.xhtml')!.async('string')).toContain('koboSpan');
}, 30_000);

it.each([
  ['missing', undefined], ['empty', new ArrayBuffer(0)],
  ['PDF', new TextEncoder().encode('%PDF-1.7 original').buffer],
  ['broken ZIP', new Uint8Array([80, 75, 3, 4, 0, 0]).buffer],
  ['wrong payload type', new Uint8Array([80, 75, 3, 4])],
])('rejects a %s success payload rather than accepting zero or wrong-format bytes', async (_name, payload) => {
  const promise = convert(await fixture(), vi.fn());
  const worker = latest();
  worker.message({ type: 'success', kepub: payload });
  await expect(promise).rejects.toThrow('conversionFailed');
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects an ordinary ZIP and an EPUB with a missing referenced package or reading file', async () => {
  const plain = new JSZip(); plain.file('document.txt', 'Not a book');
  await expect(validateEpubOutput(await plain.generateAsync({ type: 'uint8array' }))).rejects.toThrow('conversionFailed');
  const zip = await JSZip.loadAsync(await fixture());
  zip.remove('OEBPS/book.opf');
  await expect(validateEpubOutput(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('conversionFailed');
  const noChapter = await JSZip.loadAsync(await fixture('3.0', false));
  noChapter.remove('OEBPS/chapter.xhtml');
  await expect(validateEpubOutput(await noChapter.generateAsync({ type: 'uint8array' }))).rejects.toThrow('conversionFailed');
  noChapter.file('OEBPS/chapter.xhtml', '');
  await expect(validateEpubOutput(await noChapter.generateAsync({ type: 'uint8array' }))).rejects.toThrow('conversionFailed');
});

it('resolves namespaced container/package elements and OPF-relative reading paths', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><c:rootfiles><c:rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></c:rootfiles></c:container>');
  zip.file('EPUB/package.opf', '<o:package xmlns:o="http://www.idpf.org/2007/opf" version="3.0"><o:metadata/><o:manifest><o:item id="chapter" href="chapters/chapter.xhtml" media-type="application/xhtml+xml"/></o:manifest><o:spine><o:itemref idref="chapter"/></o:spine></o:package>');
  zip.file('EPUB/chapters/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body><p>Text</p></body></html>');
  await expect(validateEpubOutput(await zip.generateAsync({ type: 'uint8array' }))).resolves.toBeUndefined();
  zip.file('EPUB/package.opf', '<broken');
  await expect(validateEpubOutput(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('conversionFailed');
});

it('cleans up on message deserialisation errors and permits a subsequent conversion', async () => {
  const bytes = await fixture();
  const failed = convert(bytes, vi.fn());
  const worker = latest(); worker.onmessageerror?.();
  await expect(failed).rejects.toThrow('conversionFailed');
  expect(worker.terminate).toHaveBeenCalledOnce();
  const next = convert(bytes, vi.fn()); latest().message({ type: 'success', kepub: bytes.slice().buffer });
  await expect(next).resolves.toEqual(bytes);
});

it('rejects a worker error and releases the active conversion lock', async () => {
  const bytes = await fixture();
  const failed = convert(bytes, vi.fn()); latest().onerror?.();
  await expect(failed).rejects.toThrow('conversor KEPUB');
  const next = convert(bytes, vi.fn()); latest().message({ type: 'success', kepub: bytes.slice().buffer });
  await expect(next).resolves.toEqual(bytes);
});

it('handles construction and postMessage failures without retaining an active worker', async () => {
  const bytes = await fixture();
  vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker unavailable'); } });
  await expect(convert(bytes, vi.fn())).rejects.toThrow('conversor KEPUB');
  vi.stubGlobal('Worker', class extends FakeWorker { postMessage = vi.fn(() => { throw new Error('DataCloneError'); }); });
  await expect(convert(bytes, vi.fn())).rejects.toThrow('conversionFailed');
  expect(latest().terminate).toHaveBeenCalledOnce();
  vi.stubGlobal('Worker', FakeWorker);
  const next = convert(bytes, vi.fn()); latest().message({ type: 'success', kepub: bytes.slice().buffer });
  await expect(next).resolves.toEqual(bytes);
});

it('rejects on timeout instead of leaving the active conversion locked', async () => {
  const bytes = await fixture();
  vi.useFakeTimers();
  const promise = convert(bytes, vi.fn());
  const rejected = expect(promise).rejects.toThrow('três minutos');
  await vi.advanceTimersByTimeAsync(180_000);
  await rejected;
  expect(latest().terminate).toHaveBeenCalledOnce();
});
