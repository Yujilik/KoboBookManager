// @vitest-environment node
import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { fixture } from './fixtures';
import { kepubWithWasm } from './kepub-fixture';

it('runs the bundled kepubify WASM and produces Kobo spans in the actual EPUB', async () => {
  const zip = await JSZip.loadAsync(await kepubWithWasm(await fixture()));
  expect(await zip.file('OEBPS/chapter.xhtml')!.async('string')).toContain('koboSpan');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
}, 30000);
