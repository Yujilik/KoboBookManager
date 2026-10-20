// @vitest-environment node
import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import JSZip from 'jszip';
import { fixture } from './fixtures';

it('runs the bundled kepubify WASM and produces Kobo spans in the actual EPUB', async () => {
  const messages: { type: string; kepub?: ArrayBuffer; message?: string }[] = [];
  const sandbox = {
    crypto: globalThis.crypto, performance: globalThis.performance, TextEncoder, TextDecoder,
    console, setTimeout, clearTimeout, WebAssembly, ArrayBuffer, Uint8Array, DataView,
    postMessage: (data: typeof messages[number]) => messages.push(data),
    init: { epub: (await fixture()).buffer, config: [], progress: true },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(await readFile('public/vendor/wasm_exec.js', 'utf8'), context);
  const go = vm.runInContext('new Go()', context);
  go.argv = ['test', 'init'];
  const { instance } = await WebAssembly.instantiate(await readFile('public/vendor/kepubify.wasm'), go.importObject);
  await go.run(instance);
  const success = messages.find(x => x.type === 'success');
  expect(messages.filter(x => x.type === 'error' || x.type === 'panic')).toEqual([]);
  expect(success).toBeDefined();
  const zip = await JSZip.loadAsync(new Uint8Array(success!.kepub!));
  expect(await zip.file('OEBPS/chapter.xhtml')!.async('string')).toContain('koboSpan');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
}, 30000);
