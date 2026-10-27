import { fromBase64 } from './native';
import type { Cover } from './types';

export const MAX_COVER_SIZE = 8 * 1024 * 1024;

/** File-provider MIME types can be empty or wrong; use the image signature. */
export function coverMime(bytes: Uint8Array): Cover['mime'] {
  if (!bytes.length || bytes.byteLength > MAX_COVER_SIZE) throw new Error('coverInvalid');
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  throw new Error('coverInvalid');
}

export function readCover(value?: string): Cover | undefined {
  if (!value) return;
  try {
    const match = /^data:(image\/(?:png|jpeg));base64,([a-zA-Z0-9+/=\s]+)$/.exec(value);
    if (!match || match[2].length > Math.ceil(MAX_COVER_SIZE / 3) * 4 + 4) throw new Error();
    const bytes = fromBase64(match[2]);
    const mime = coverMime(bytes);
    if (mime !== match[1]) throw new Error();
    return { bytes, mime };
  } catch { throw new Error('coverInvalid'); }
}
