import { validateEpubOutput } from './conversion-output';

let active: Worker | undefined;

export async function convert(bytes: Uint8Array, onProgress: (value: number) => void): Promise<Uint8Array> {
  if (active) throw new Error('Aguarde a conversão em andamento.');
  let worker: Worker;
  try { worker = new Worker(new URL('./kepub.worker.js', import.meta.url)); }
  catch (error) { throw new Error('Não foi possível iniciar o conversor KEPUB.', { cause: error }); }
  active = worker;
  return new Promise((resolve, reject) => {
    let settled = false, validating = false;
    const finish = () => {
      settled = true; clearTimeout(timeout);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate(); active = undefined;
    };
    const fail = (error: unknown) => { if (!settled) { finish(); reject(error); } };
    const timeout = setTimeout(() => fail(new Error('A conversão excedeu três minutos. Tente um livro menor.')), 180000);
    worker.onerror = () => fail(new Error('Não foi possível iniciar o conversor KEPUB.'));
    worker.onmessageerror = () => fail(new Error('conversionFailed'));
    worker.onmessage = event => {
      if (settled) return;
      const data = event.data;
      if (!data || typeof data !== 'object') { fail(new Error('conversionFailed')); return; }
      if (data.type === 'progress' && !validating && Number.isFinite(data.n) && Number.isFinite(data.total) && data.total > 0) {
        onProgress(Math.max(0, Math.min(100, Math.round(data.n / data.total * 100))));
      }
      if (data.type === 'success' && !validating) {
        validating = true;
        // The worker protocol transfers an ArrayBuffer. Missing data used to
        // become Uint8Array(undefined), incorrectly reporting a zero-byte success.
        if (Object.prototype.toString.call(data.kepub) !== '[object ArrayBuffer]' || !data.kepub.byteLength) {
          fail(new Error('conversionFailed')); return;
        }
        const output = new Uint8Array(data.kepub);
        void validateEpubOutput(output).then(() => {
          if (!settled) { finish(); resolve(output); }
        }, fail);
      }
      if (data.type === 'error' || data.type === 'panic') fail(new Error(data.message || 'Falha ao converter o EPUB.'));
    };
    // Send a copy; the library's bytes must not be detached by transfer.
    try {
      const buffer = bytes.slice().buffer; worker.postMessage({ buffer }, [buffer]);
    } catch (error) { fail(new Error('conversionFailed', { cause: error })); }
  });
}
