import JSZip from 'jszip';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { toBase64, type OutputReceipt, type StagedFile } from './native';
import { validateEpubOutput } from './conversion-output';
import { MAX_BOOK_SIZE } from './epub';

// Keep bridge messages small: Android may retain plugin arguments during lifecycle changes.
const WRITE_CHUNK_SIZE = 256 * 1024;

/** Check the bytes against the requested output, before any save dialog or transfer. */
export async function validateOutput(bytes: Uint8Array, mime: string): Promise<void> {
  if (!bytes || !ArrayBuffer.isView(bytes) || !bytes.byteLength) throw new Error('outputInvalid');
  if (bytes.byteLength > (mime === 'application/zip' ? 512 * 1024 * 1024 : MAX_BOOK_SIZE)) throw new Error('fileTooLarge');
  if (mime === 'application/epub+zip') { await validateEpubOutput(bytes); return; }
  if (mime === 'application/pdf') {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('outputInvalid');
    return;
  }
  if (mime === 'application/zip') {
    try { await JSZip.loadAsync(bytes); return; } catch { throw new Error('outputInvalid'); }
  }
  throw new Error('outputInvalid');
}

export async function stageOutput(bytes: Uint8Array, name: string, mime: string): Promise<StagedFile> {
  await validateOutput(bytes, mime);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), value => value.toString(16).padStart(2, '0')).join('');
  const file: StagedFile = { path: `exports/${crypto.randomUUID()}/payload`, name, mime, size: bytes.byteLength, sha256 };
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_SIZE) {
      const chunk = { path: file.path, directory: Directory.Cache, data: toBase64(bytes.subarray(offset, offset + WRITE_CHUNK_SIZE)) };
      if (offset === 0) await Filesystem.writeFile({ ...chunk, recursive: true });
      else await Filesystem.appendFile(chunk);
    }
    const saved = await Filesystem.stat({ path: file.path, directory: Directory.Cache });
    if (saved.size !== file.size) throw new Error('outputInvalid');
    return file;
  } catch (error) { await discardOutput(file); throw error; }
}

export function checkReceipt(file: StagedFile, receipt: OutputReceipt | undefined) {
  if (!receipt || receipt.size !== file.size || receipt.sha256 !== file.sha256) throw new Error('outputInvalid');
}

export async function discardOutput(file: StagedFile) {
  // This is a task-created cache path, never the user's source or destination.
  await Filesystem.deleteFile({ path: file.path, directory: Directory.Cache }).catch(() => undefined);
}
