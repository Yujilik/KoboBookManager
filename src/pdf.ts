import JSZip from 'jszip';
import { getDocument, GlobalWorkerOptions, PermissionFlag, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { MAX_BOOK_SIZE } from './epub';
import type { Cover, Metadata } from './types';
import { coverMime } from './cover';
import { languageTag, textLanguage } from './pdf-language';
import { repairPdfUnicode } from './pdf-fonts';
import { reflowText } from './pdf-reflow';
import { extractPageImages, hasOcrTextLayer } from './pdf-images';
import { buildPdfNavigation, type NavigationEntry } from './pdf-navigation';
import { createPdfTextSource, type PdfTextSource } from './pdf-text';
import { createOriginalPage } from './pdf-originals';
import { chapterHeading, readingItems, repeatedFurniture } from './pdf-reading';
import type { PdfConversionOptions } from './pdf-ocr-options';

const browser = typeof window !== 'undefined';
if (browser) GlobalWorkerOptions.workerSrc = workerUrl;
const assets = browser ? new URL('vendor/pdfjs/', document.baseURI) : new URL('../node_modules/pdfjs-dist/', import.meta.url);
function assetPath(directory: string) {
  const url = new URL(directory + '/', assets);
  return browser ? url.href : decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const optionalDc = (name: string, value: string, prefix = '') => {
  const content = xml(value).trim();
  return content ? `<dc:${name}>${prefix}${content}</dc:${name}>` : '';
};

function navigationList(entries: NavigationEntry[]): string {
  return `<ol>${entries.map(entry => `<li><a href="${xml(entry.href)}">${xml(entry.title)}</a>${entry.children?.length ? navigationList(entry.children) : ''}</li>`).join('')}</ol>`;
}

function ncxNavigation(entries: NavigationEntry[]): string {
  let order = 0, id = 0;
  const locations = new Map<string, number>();
  const points = (nodes: NavigationEntry[]): string => nodes.map(entry => {
    if (!locations.has(entry.href)) locations.set(entry.href, ++order);
    const number = ++id;
    return `<navPoint id="nav-${number}" playOrder="${locations.get(entry.href)}"><navLabel><text>${xml(entry.title)}</text></navLabel><content src="${xml(entry.href)}"/>${points(entry.children || [])}</navPoint>`;
  }).join('');
  return points(entries);
}

export function writePdfNavigation(zip: JSZip, chapters: NavigationEntry[], metadata: Pick<Metadata, 'title' | 'language'>, identifier: string, pageLinks: string): void {
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(metadata.language)}"><head><title>${xml(metadata.title)}</title></head><body><nav epub:type="toc" id="toc"><h1>${xml(metadata.title)}</h1>${navigationList(chapters)}</nav><nav epub:type="page-list" hidden="hidden"><h2>Pages</h2><ol>${pageLinks}</ol></nav></body></html>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${xml(identifier)}"/></head><docTitle><text>${xml(metadata.title)}</text></docTitle><navMap>${ncxNavigation(chapters)}</navMap></ncx>`);
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

/** Convert text into reader-controlled paragraphs; keep raster figures separate from text. */
export async function pdfToEpub(bytes: Uint8Array, details: Metadata, progress: (value: number, stage?: 'ocr') => void, cover?: Cover, options: PdfConversionOptions = {}): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
  if (cover && coverMime(cover.bytes) !== cover.mime) throw new Error('coverInvalid');
  progress(0);
  // Repair known missing character maps before PDF.js performs normalization or
  // bidi ordering. Work on a copy; the library's original PDF stays unchanged.
  const repaired = await repairPdfUnicode(bytes);
  const task = getDocument({ data: repaired.slice(), cMapPacked: true,
    cMapUrl: assetPath('cmaps'), standardFontDataUrl: assetPath('standard_fonts'),
    wasmUrl: assetPath('wasm'), iccUrl: assetPath('iccs'), useWorkerFetch: browser });
  let expired = false;
  const timeout = setTimeout(() => { expired = true; void task.destroy(); }, 180_000);
  let textSource: PdfTextSource | undefined;
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
    textSource = await createPdfTextSource(document, metadata, options, progress);
    // OCR can take minutes for a scanned book. Its worker and page rendering
    // have individual timeouts instead of the text-loader's three-minute limit.
    clearTimeout(timeout);
    const navigation = await buildPdfNavigation(document, { readText: textSource.read });
    const initialPages = new Set<number>();
    const collectInitialPages = (entries: NavigationEntry[]) => {
      for (const entry of entries) {
        const number = entry.href.match(/^page-(\d+)\.xhtml(?:#|$)/)?.[1];
        const explicitHeading = /^(?:chapter|part|cap[ií]tulo|chapitre|kapitel|глава|第.{1,10}[章部節回]|제.{1,10}[장부절]|บทที่)/iu.test(entry.title);
        if (number && (navigation.origin !== 'headings' || explicitHeading)) initialPages.add(Number(number));
        if (entry.children) collectInitialPages(entry.children);
      }
    };
    collectInitialPages(navigation.chapters);
    textSource.restrictInitials(initialPages);
    textSource.verify();
    const furniturePages = [];
    if (navigation.origin !== 'headings' && textSource.usesOcr) {
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), text = navigation.text(number);
        furniturePages.push({ number, items: (text?.items || []).filter((item): item is TextItem => 'str' in item), view: page.view, scanned: true });
      }
    }
    const furniture = repeatedFurniture(furniturePages);
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/style.css', 'body{overflow-wrap:break-word}p{text-indent:1.2em;margin:.35em 0}h2{margin:1em 0 .6em}figure{margin:1em 0;text-align:center}img{max-width:100%;height:auto}.pdf-facsimile{margin:0;break-inside:avoid}.pdf-facsimile img{width:100%;height:auto}rt{font-size:.5em}');
    const manifest = ['<item id="style" href="style.css" media-type="text/css"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'];
    const spine: string[] = [], originalSpine: string[] = [], pageNavigation: string[] = [];
    const languages = new Set<string>();
    let textCharacters = 0;
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
        const text = navigation.text(number) || await page.getTextContent({ disableNormalization: true });
        const sourceItems = text.items.filter((item): item is TextItem => 'str' in item);
        const facsimile = textSource.facsimile(number);
        const operations = textSource.recognized(number) || facsimile ? undefined : await page.getOperatorList();
        const ocrTextLayer = operations ? hasOcrTextLayer(operations) : false;
        const items = readingItems(sourceItems, page.view, textSource.recognized(number) || ocrTextLayer, furniture.get(number));
        if (items.some(item => /[\uFFFD\p{Private_Use}\p{Surrogate}\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(item.str))) {
          throw new Error('pdfTextUnreliable', { cause: new Error(`Unreadable text on PDF page ${number}`) });
        }
        const declaredLanguage = languageTag(details.language || text.lang || sourceLanguage);
        const pageLanguage = declaredLanguage === 'und' ? textLanguage(items.map(item => item.str).join(''), 'und') : declaredLanguage;
        const pageNavigationInfo = navigation.page(number);
        const inlineImages = [];
        for (const [index, initial] of textSource.inlineFigures(number).entries()) {
          const href = `images/initial-${number}-${index + 1}.png`;
          expanded += initial.bytes.byteLength;
          if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
          zip.file(`OEBPS/${href}`, initial.bytes, { compression: 'STORE' });
          manifest.push(`<item id="initial-${number}-${index + 1}" href="${href}" media-type="image/png"/>`);
          inlineImages.push({ item: initial.item, replace: initial.replace, src: href, alt: initial.alt, aspect: initial.width / initial.height,
            ...(initial.hangingUntil !== undefined ? { hangingUntil: initial.hangingUntil } : {}) });
        }
        let content = reflowText(items, pageLanguage, languages, { ...pageNavigationInfo, inlineImages, ocr: textSource.recognized(number) || ocrTextLayer });
        const canonicalTitle = pageNavigationInfo.chapter || pageNavigationInfo.heading;
        if (canonicalTitle && !facsimile) content = chapterHeading(content, canonicalTitle);
        const pageTextCharacters = items.reduce((count, item) => count + item.str.replace(/\s/g, '').length, 0);
        textCharacters += pageTextCharacters;
        if (content) {
          if (metadata.language === 'und') metadata.language = pageLanguage;
          if (pageLanguage !== 'und') languages.add(pageLanguage);
        }
        // A cover thumbnail is allowed to be a page image. Reading text is never
        // replaced by that image, even when the source page contains drawings.
        if (number === 1 && !cover) {
          const image = await pageImage(page);
          expanded += image.byteLength;
          if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
          zip.file('OEBPS/images/page-1.jpg', image, { compression: 'STORE' });
          manifest.push('<item id="image-1" href="images/page-1.jpg" media-type="image/jpeg" properties="cover-image"/>');
        }
        const images = operations
          ? await extractPageImages(page, operations, { omitPageBackground: ocrTextLayer })
          : textSource.figures(number);
        const leadingFigures: string[] = [];
        for (let index = 0; index < images.length; index++) {
          const image = images[index];
          expanded += image.bytes.byteLength;
          if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
          const href = `images/figure-${number}-${index + 1}.${image.mime === 'image/png' ? 'png' : 'jpg'}`;
          zip.file(`OEBPS/${href}`, image.bytes, { compression: 'STORE' });
          manifest.push(`<item id="figure-${number}-${index + 1}" href="${href}" media-type="${image.mime}"/>`);
          const figure = `<figure><img src="${href}" alt="${xml(metadata.title)} — ${number}"/></figure>`;
          if (image.beforeText) leadingFigures.push(figure); else content += figure;
        }
        content = leadingFigures.join('') + content;
        // Vector-only artwork can still be kept on genuine picture pages. A
        // mixed text/drawing page always keeps its body as selectable text.
        if (!images.length && !pageTextCharacters && !textSource.recognized(number)) {
          if (number === 1 && !cover) content += `<figure${facsimile ? ' class="pdf-facsimile"' : ''}><img src="images/page-1.jpg" alt="${xml(metadata.title)}"/></figure>`;
          else {
            const image = await pageImage(page);
            expanded += image.byteLength;
            if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
            zip.file(`OEBPS/images/page-${number}.jpg`, image, { compression: 'STORE' });
            manifest.push(`<item id="image-${number}" href="images/page-${number}.jpg" media-type="image/jpeg"/>`);
            content += `<figure${facsimile ? ' class="pdf-facsimile"' : ''}><img src="images/page-${number}.jpg" alt="${xml(metadata.title)} — ${number}"/></figure>`;
          }
        }
        // A PDF link can cover an illustration or a drawing instead of text.
        // Keep it usable even when its original hitbox has no text run to wrap.
        const linkHrefs = [...new Set(pageNavigationInfo.links.map(link => link.href))];
        const unmatchedLinks = linkHrefs.filter(href => !content.includes(`href="${xml(href)}"`));
        if (!pageTextCharacters && unmatchedLinks.length === 1 && (content.match(/<figure>/g)?.length ?? 0) === 1) {
          content = content.replace(/<figure>(<img[^>]*\/>)<\/figure>/, (_, image: string) => `<figure><a href="${xml(unmatchedLinks[0])}">${image}</a></figure>`);
        } else for (const href of unmatchedLinks) {
          const targetPage = href.match(/^page-(\d+)\.xhtml(?:#|$)/)?.[1];
          const label = targetPage ? navigation.page(Number(targetPage)).title || `${metadata.title} — ${navigation.labels?.[Number(targetPage) - 1] || targetPage}` : href;
          content += `<p><a href="${xml(href)}">${xml(label)}</a></p>`;
        }
        if (pageTextCharacters && (textSource.recognized(number) || ocrTextLayer)) {
          const original = await createOriginalPage(zip, page, number, metadata);
          expanded += original.bytes;
          if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
          manifest.push(...original.manifest);
          originalSpine.push(original.spine);
          content += original.link;
        }
        const href = `page-${number}.xhtml`;
        const pageTitle = xml(pageNavigationInfo.title || `${metadata.title} — ${number}`);
        zip.file(`OEBPS/${href}`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="${xml(pageLanguage)}" xml:lang="${xml(pageLanguage)}"><head><title>${pageTitle}</title><link rel="stylesheet" href="style.css"/></head><body id="pdf-page-${number}">${content}</body></html>`);
        expanded += new TextEncoder().encode(content).byteLength;
        if (expanded > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
        manifest.push(`<item id="page-${number}" href="${href}" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="page-${number}"/>`);
        pageNavigation.push(`<li><a href="${href}#pdf-page-${number}">${xml(navigation.labels?.[number - 1] || String(number))}</a></li>`);
      } finally { page.cleanup(); }
      const start = textSource.usesOcr ? 70 : 5;
      progress(Math.round(start + number / document.numPages * (95 - start)));
      // Let progress paint and release per-page rendering resources on mobile.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!textCharacters) throw new Error('pdfTextUnavailable');
    const identifier = 'urn:uuid:' + crypto.randomUUID();
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    let chapters = navigation.chapters;
    if (textSource.usesOcr && navigation.origin === 'headings') {
      writePdfNavigation(zip, chapters, metadata, identifier, pageNavigation.join(''));
      const { improveOcrNavigation } = await import('./pdf-ocr-navigation');
      const improved = await improveOcrNavigation(zip, metadata.language);
      if (improved) chapters = improved.chapters;
    }
    writePdfNavigation(zip, chapters, metadata, identifier, pageNavigation.join(''));
    const languageMetadata = [...new Set([metadata.language, ...languages])].map(language => `<dc:language>${xml(language)}</dc:language>`).join('');
    const optionalMetadata = metadata.authors.map(author => optionalDc('creator', author)).join('') +
      optionalDc('description', metadata.description) + optionalDc('publisher', metadata.publisher) +
      optionalDc('date', metadata.published) + metadata.tags.map(tag => optionalDc('subject', tag)).join('') +
      optionalDc('identifier', metadata.isbn, 'urn:isbn:');
    const series = xml(metadata.series).trim();
    const seriesMetadata = series ? `<meta name="calibre:series" content="${series}"/><meta name="calibre:series_index" content="${xml(metadata.seriesIndex).trim() || '1'}"/>` : '';
    zip.file('OEBPS/book.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid"><metadata><dc:identifier id="uid">${identifier}</dc:identifier><dc:title>${xml(metadata.title)}</dc:title>${languageMetadata}${optionalMetadata}${seriesMetadata}<meta property="dcterms:modified">${modified}</meta><meta name="cover" content="${coverId}"/></metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}${originalSpine.join('')}</spine></package>`);
    if (chapters.length >= 2) {
      const { assemblePdfChapters } = await import('./pdf-chapters');
      chapters = await assemblePdfChapters(zip, chapters);
    }
    const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    if (output.byteLength > MAX_BOOK_SIZE) throw new Error('pdfConversionTooLarge');
    progress(100);
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('pdfPasswordRequired');
    if (error instanceof Error && ['fileTooLarge', 'pdfConversionTooLarge', 'pdfTextUnavailable', 'pdfTextUnreliable', 'pdfOcrFailed', 'DRM'].includes(error.message)) throw error;
    throw new Error('conversionFailed', { cause: error });
  } finally { clearTimeout(timeout); await textSource?.close(); await task.destroy(); }
}
