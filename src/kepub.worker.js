/* The runtime and Go converter are bundled with the APK; no network download is needed. */
importScripts('/vendor/wasm_exec.js');
onmessage = async event => {
  try {
    const go = new Go();
    globalThis.init = { epub: event.data.buffer, config: [], progress: true };
    go.argv = ['kobo-book-manager', 'init'];
    const response = await fetch('/vendor/kepubify.wasm');
    if (!response.ok) throw new Error('O conversor KEPUB não foi encontrado no aplicativo.');
    const wasm = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    await go.run(wasm.instance);
  } catch (error) { postMessage({ type: 'error', message: String(error) }); }
};
