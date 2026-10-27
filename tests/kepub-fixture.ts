import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/** Execute the same bundled Go/WASM converter used by the app, not a mock. */
export async function kepubWithWasm(epub: Uint8Array): Promise<Uint8Array> {
  const messages: { type: string; kepub?: ArrayBuffer; message?: string }[] = [];
  const sandbox = {
    crypto: globalThis.crypto, performance: globalThis.performance, TextEncoder, TextDecoder,
    console, setTimeout, clearTimeout, WebAssembly, ArrayBuffer, Uint8Array, DataView,
    postMessage: (data: typeof messages[number]) => messages.push(data),
    init: { epub: epub.slice().buffer, config: [], progress: true },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(await readFile('public/vendor/wasm_exec.js', 'utf8'), context);
  const go = vm.runInContext('new Go()', context);
  go.argv = ['test', 'init'];
  const { instance } = await WebAssembly.instantiate(await readFile('public/vendor/kepubify.wasm'), go.importObject);
  await go.run(instance);
  const error = messages.find(message => message.type === 'error' || message.type === 'panic');
  if (error) throw new Error(error.message || 'WASM conversion failed');
  const success = messages.find(message => message.type === 'success');
  if (!success?.kepub) throw new Error('WASM returned no book');
  return new Uint8Array(success.kepub);
}
