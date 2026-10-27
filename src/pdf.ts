import JSZip from 'jszip';
import { getDocument, GlobalWorkerOptions, OPS, PermissionFlag, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { MAX_BOOK_SIZE } from './epub';
import type { Cover, Metadata } from './types';
import { coverMime } from './cover';
import { languageRuns, languageTag, lineSeparator, textLanguage } from './pdf-language';

const browser = typeof window !== 'undefined';
if (browser) GlobalWorkerOptions.workerSrc = workerUrl;
const assets = browser ? new URL('vendor/pdfjs/', document.baseURI) : new URL('../node_modules/pdfjs-dist/', import.meta.url);
function assetPath(directory: string) {
  const url = new URL(directory + '/', assets);
  return browser ? url.href : decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}
const visualOperations = new Set([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
  OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask, OPS.constructPath, OPS.shadingFill,
]);
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const optionalDc = (name: string, value: string, prefix = '') => {
  const content = xml(value).trim();
  return content ? `<dc:${name}>${prefix}${content}</dc:${name}>` : '';
};

function requiresOriginalGlyphs(items: TextItem[]) {
  return items.some(item => item.dir === 'ttb' || [...item.str].some(character => {
    // Replacement/private-use characters can signal an absent or broken Unicode
    // map. Never write those as if they were reliable extracted book text.
    if (/[\uFFFD\p{Private_Use}\p{Surrogate}]/u.test(character)) return true;
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(character);
  }));
}

/** Reassemble PDF text runs into lines, then paragraphs, without hard page-width line breaks. */
function paragraphs(items: TextItem[], language: string, languages: Set<string>) {
  const lines: { text: string; x: number; y: number; height: number; end: number; dir: string }[] = [];
  let line: typeof lines[number] | undefined;
  const flush = () => { if (line?.text.trim()) lines.push(line); line = undefined; };
  for (const item of items) {
    const x = item.transform[4], y = item.transform[5], height = Math.abs(item.height) || 12;
    if (line && (Math.abs(line.y - y) > Math.max(line.height, height) * 0.4 || item.dir !== line.dir)) flush();
    if (!line) line = { text: '', x, y, height, end: x, dir: item.dir };
    if (line.text && !/\s$/.test(line.text) && !/^\s/.test(item.str) && x - line.end > height * 0.12) line.text += ' ';
    line.text += item.str; line.end = x + item.width; line.height = Math.max(line.height, height);
    if (item.hasEOL) flush();
  }
  flush();
  const sizes = lines.map(item => item.height).sort((a, b) => a - b);
  const normal = sizes[Math.floor(sizes.length / 2)] || 12;
  const blocks: { text: string; heading: boolean; dir: string }[] = [];
  let previous: typeof lines[number] | undefined;
  for (const current of lines) {
    const heading = current.height > normal * 1.25;
    const gap = previous ? previous.y - current.y : 0;
    const block = blocks.at(-1);
    if (block && previous && !heading && !block.heading && current.dir === block.dir && gap > 0 &&
        gap < Math.max(previous.height, current.height) * 1.8 && Math.abs(current.x - previous.x) < normal) {
      block.text += lineSeparator(block.text, current.text.trim()) + current.text.trim();
    } else blocks.push({ text: current.text.trim(), heading, dir: current.dir });
    previous = current;
  }
  return blocks.map(block => {
    const tag = block.heading ? 'h2' : 'p';
    const content = languageRuns(block.text, language).map(run => {
      if (!run.language || run.language === 'und') return xml(run.text);
      languages.add(run.language);
      return `<span lang="${xml(run.language)}" xml:lang="${xml(run.language)}">${xml(run.text)}</span>`;
    }).join('');
    return `<${tag}${block.dir === 'rtl' ? ' dir="rtl"' : ''}>${content}</${tag}>`;
  }).join('\n');
}

async function pageImage(page: PDFPageProxy): Promise<Uint8Array> {
  const original = page.getViewport({ scale: 1 });
  // One page at a time, capped at 2 MP to keep large PDFs usable on phones.
  const scale = Math.min(2, 1600 / Math.max(original.width, original.height), Math.sqrt(2_000_000 / (original.width * original.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('conversionFailed');
    await page.render({ canvasContext: context, canvas, viewport, background: 'white' }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('conversionFailed')), 'image/jpeg', 0.88));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { canvas.width = canvas.height = 0; }
}

/** Unicode text reflows with language tags; graphics and unreliable text maps retain page images. No OCR. */
export async function pdfToEpub(bytes: Uint8Array, details: Metadata, progress: (value: number) => void, cover?: Cover): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
  if (cover && coverMime(cover.bytes) !== cover.mime) throw new Error('coverInvalid');
  progress(0);
  // PDF.js transfers its input buffer; never detach the library's original bytes.
  const task = getDocument({ data: bytes.slice(), cMapPacked: true,
    cMapUrl: assetPath('cmaps'), standardFontDataUrl: assetPath('standard_fonts'),
    wasmUrl: assetPath('wasm'), iccUrl: assetPath('iccs'), useWorkerFetch: browser });
  let expired = false;
  const timeout = setTimeout(() => { expired = true; void task.destroy(); }, 180_000);
  try {
    const document = await task.promise;
    if (document.numPages > 2000) throw new Error('pdfConversionTooLarge');
    const permissions = await document.getPermissions();
    if (permissions && !permissions.has(PermissionFlag.COPY)) throw new Error('DRM');
    const { info } = await document.getMetadata();
    const value = (key: string) => typeof (info as Record<string, unknown>)[key] === 'string' ? String((info as Record<string, unknown>)[key]) : '';
    const metadata = { ...details, title: details.title.trim() || value('Title') || 'Book',
      authors: details.authors.length ? details.authors : value('Author') ? [value('Author')] : [],
      language: languageTag(details.language || value('Language')), description: details.description || value('Subject') };
    const sourceLanguage = metadata.language;
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/style.css', 'body{line-height:1.5;margin:0 5%;overflow-wrap:break-word}p{text-indent:1.2em;margin:.35em 0}h2{margin:1em 0 .6em}figure{margin:0;text-align:center}img{max-width:100%;height:auto}');
    const manifest = ['<item id="style" href="style.css" media-type="text/css"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
    const spine: string[] = [], navigation: string[] = [];
    const languages = new Set<string>();
    let expanded = cover?.bytes.byteLength ?? 0;
    const coverId = cover ? 'cover-image' : 'image-1';
    if (cover) {
      const href = cover.mime === 'image/png' ? 'images/cover.png' : 'images/cover.jpg';
      zip.file(`OEBPS/${href}`, cover.bytes, { compression: 'STORE' });
      manifest.push(`<item id="cover-image" href="${href}" media-type="${cover.mime}" properties="cover-image"/>`);
      manifest.push('<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="cover-page"/>');
      zip.file('OEBPS/cover.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xml(metadata.title)}</title></head><body style="margin:0;text-align:center"><img style="max-width:100%;max-height:100%" src="${href}" alt="${xml(metadata.title)}"/></body></html>`);
    }
    for (let number = 1; number <= document.numPages; number++) {
      if (expired) throw new Error('conversionFailed');
      const page = await document.getPage(number);
      try {
        const text = await page.getTextContent().catch(() => ({ items: [], lang: null }));
        const items: TextItem[] = [];
        for (const item of text.items) if ('str' in item) items.push(item);
        const operations = await page.getOperatorList();
        const illustrated = operations.fnArray.some(operation => visualOperations.has(operation)) || requiresOriginalGlyphs(items);
        const declaredLanguage = languageTag(details.language || text.lang || sourceLanguage);
        let pageLanguage = declaredLanguage;
        if (declaredLanguage !== 'und') {
          if (metadata.language === 'und') metadata.language = declaredLanguage;
          languages.add(declaredLanguage);
        }
        let content = '';
        // Image pages use the original glyphs. Their discarded text can have a
        // broken Unicode map, so only explicit language declarations apply.
        if (!illustrated) {
          const inferredLanguage = declaredLanguage === 'und' ? textLanguage(items.map(item => item.str).join(''), 'und') : declaredLanguage;
          content = paragraphs(items, inferredLanguage, languages);
          if (content) {
            pageLanguage = inferredLanguage;
            if (metadata.language === 'und') metadata.language = pageLanguage;
            if (pageLanguage !== 'und') languages.add(pageLanguage);
          }
        }
        // Also keep the first page as the EPUB cover, including text-only covers.
        if (number === 1 && !cover || illustrated || !content) {
          const image = await pageImage(page);
          expanded += image.byteLength;
          if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
          zip.file(`OEBPS/images/page-${number}.jpg`, image, { compression: 'STORE' });
          manifest.push(`<item id="image-${number}" href="images/page-${number}.jpg" media-type="image/jpeg"${number === 1 && !cover ? ' properties="cover-image"' : ''}/>`);
          if (illustrated || !content) content = `<figure><img src="images/page-${number}.jpg" alt="${xml(metadata.title)} — ${number}"/></figure>`;
        }
        const href = `page-${number}.xhtml`;
        const pageTitle = `${xml(metadata.title)} — ${number}`;
        zip.file(`OEBPS/${href}`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="${xml(pageLanguage)}" xml:lang="${xml(pageLanguage)}"><head><title>${pageTitle}</title><link rel="stylesheet" href="style.css"/></head><body>${content}</body></html>`);
        expanded += new TextEncoder().encode(content).byteLength;
        if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
        manifest.push(`<item id="page-${number}" href="${href}" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="page-${number}"/>`);
        navigation.push(`<li><a href="${href}">${number}</a></li>`);
      } finally { page.cleanup(); }
      progress(Math.round(number / document.numPages * 95));
      // Let progress paint and release per-page rendering resources on mobile.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const identifier = 'urn:uuid:' + crypto.randomUUID();
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    zip.file('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(metadata.language)}"><head><title>${xml(metadata.title)}</title></head><body><nav epub:type="toc"><h1>${xml(metadata.title)}</h1><ol>${navigation.join('')}</ol></nav></body></html>`);
    const languageMetadata = [...new Set([metadata.language, ...languages])].map(language => `<dc:language>${xml(language)}</dc:language>`).join('');
    const optionalMetadata = metadata.authors.map(author => optionalDc('creator', author)).join('') +
      optionalDc('description', metadata.description) + optionalDc('publisher', metadata.publisher) +
      optionalDc('date', metadata.published) + metadata.tags.map(tag => optionalDc('subject', tag)).join('') +
      optionalDc('identifier', metadata.isbn, 'urn:isbn:');
    const series = xml(metadata.series).trim();
    const seriesMetadata = series ? `<meta name="calibre:series" content="${series}"/><meta name="calibre:series_index" content="${xml(metadata.seriesIndex).trim() || '1'}"/>` : '';
    zip.file('OEBPS/book.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid"><metadata><dc:identifier id="uid">${identifier}</dc:identifier><dc:title>${xml(metadata.title)}</dc:title>${languageMetadata}${optionalMetadata}${seriesMetadata}<meta property="dcterms:modified">${modified}</meta><meta name="cover" content="${coverId}"/></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
    const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    if (output.byteLength > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
    progress(100);
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('pdfPasswordRequired');
    if (error instanceof Error && ['fileTooLarge', 'pdfConversionTooLarge', 'DRM'].includes(error.message)) throw error;
    throw new Error('conversionFailed', { cause: error });
  } finally { clearTimeout(timeout); await task.destroy(); }
}
