import { emptyMetadata, MAX_BOOK_SIZE, readEpub } from './epub';
import type { Book } from './types';

/** Names and MIME types from file providers are hints; the bytes decide. */
export function bookFormat(bytes: Uint8Array): Book['format'] | undefined {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return 'epub';
}

export async function readBook(name: string, bytes: Uint8Array) {
  if (bytes.length > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
  const format = bookFormat(bytes);
  if (!format) throw new Error('invalidBook');
  const fallback = name.replace(/\.(kepub\.)?(epub|pdf)$/i, '');
  if (format === 'pdf') return { format, metadata: emptyMetadata(fallback), cover: undefined };
  // A ZIP signature is only a candidate: validate the container, OPF and DRM too.
  const result = await readEpub(bytes);
  if (!result.metadata.title) result.metadata.title = fallback;
  return { format, ...result };
}
