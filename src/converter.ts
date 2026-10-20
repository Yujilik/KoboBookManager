let active: Worker | undefined;

export async function convert(bytes: Uint8Array, onProgress: (value: number) => void): Promise<Uint8Array> {
  if (active) throw new Error('Aguarde a conversão em andamento.');
  const worker = new Worker(new URL('./kepub.worker.js', import.meta.url));
  active = worker;
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); worker.terminate(); active = undefined; };
    const timeout = setTimeout(() => { finish(); reject(new Error('A conversão excedeu três minutos. Tente um livro menor.')); }, 180000);
    worker.onerror = () => { finish(); reject(new Error('Não foi possível iniciar o conversor KEPUB.')); };
    worker.onmessage = event => {
      const data = event.data;
      if (data.type === 'progress') onProgress(Math.round(data.n / Math.max(data.total, 1) * 100));
      if (data.type === 'success') { finish(); resolve(new Uint8Array(data.kepub)); }
      if (data.type === 'error' || data.type === 'panic') { finish(); reject(new Error(data.message || 'Falha ao converter o EPUB.')); }
    };
    // Send a copy; the library's bytes must not be detached by transfer.
    const buffer = bytes.slice().buffer; worker.postMessage({ buffer }, [buffer]);
  });
}
