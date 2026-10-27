import JSZip from 'jszip';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { languageTag } from './pdf-language';

interface OriginalMetadata { title: string; language: string }
export interface OriginalPage { bytes: number; manifest: string[]; spine: string; link: string }
const OPF = 'http://www.idpf.org/2007/opf';
const XHTML = 'http://www.w3.org/1999/xhtml';
const MAX_PIXELS = 3_000_000, MAX_EDGE = 2200;
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const length = (value: string) => new TextEncoder().encode(value).byteLength;

function labels(language: string, number: number) {
  const tag = languageTag(language), primary = tag.split('-')[0];
  const values: Record<string, [string, string, string]> = {
    en: [`Original page ${number}`, `View original page ${number}`, 'Return to text'],
    pt: [`Página original ${number}`, `Ver página original ${number}`, 'Voltar ao texto'],
    ru: [`Исходная страница ${number}`, `Открыть исходную страницу ${number}`, 'Вернуться к тексту'],
    ko: [`원본 ${number}쪽`, `원본 ${number}쪽 보기`, '텍스트로 돌아가기'],
    zh: [`原始页面 ${number}`, `查看原始页面 ${number}`, '返回正文'],
    es: [`Página original ${number}`, `Ver página original ${number}`, 'Volver al texto'],
    ja: [`元のページ ${number}`, `元のページ ${number} を見る`, '本文に戻る'],
    th: [`หน้าต้นฉบับ ${number}`, `ดูหน้าต้นฉบับ ${number}`, 'กลับไปที่ข้อความ'],
  };
  if (/^zh-(?:Hant|TW|HK|MO)(?:-|$)/i.test(tag)) values.zh = [`原始頁面 ${number}`, `查看原始頁面 ${number}`, '返回正文'];
  const [title, view, back] = values[primary] ?? values.en;
  return { title, view, back, language: tag };
}

function references(number: number, metadata: OriginalMetadata): OriginalPage {
  const text = labels(metadata.language, number);
  return {
    bytes: 0,
    manifest: [
      `<item id="original-image-${number}" href="original-pages/page-${number}.jpg" media-type="image/jpeg"/>`,
      `<item id="original-page-${number}" href="original-pages/page-${number}.xhtml" media-type="application/xhtml+xml"/>`,
    ],
    spine: `<itemref idref="original-page-${number}" linear="no"/>`,
    link: `<p class="original-page-link"><a href="original-pages/page-${number}.xhtml#original-page-${number}">${xml(text.view)}</a></p>`,
  };
}

/** Keep illustrations and the source layout available without flattening the reading text. */
export async function createOriginalPage(zip: JSZip, page: PDFPageProxy, number: number, metadata: OriginalMetadata): Promise<OriginalPage> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('conversionFailed');
  const result = references(number, metadata), folder = 'OEBPS/original-pages/';
  const imagePath = `${folder}page-${number}.jpg`, documentPath = `${folder}page-${number}.xhtml`;
  const existingImage = zip.file(imagePath), existingDocument = zip.file(documentPath);
  if (existingImage && existingDocument && (await existingImage.async('uint8array')).length && (await existingDocument.async('uint8array')).length) return result;
  const base = page.getViewport({ scale: 1 });
  if (![base.width, base.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('conversionFailed');
  const scale = Math.min(4, MAX_EDGE / Math.max(base.width, base.height), Math.sqrt(MAX_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('conversionFailed');
    const render = page.render({ canvas, canvasContext: context, viewport, background: 'white' });
    const timeout = setTimeout(() => render.cancel(), 60_000);
    try { await render.promise; } finally { clearTimeout(timeout); }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('conversionFailed')), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('conversionFailed');
    const text = labels(metadata.language, number);
    const back = `<p><a href="../page-${number}.xhtml#pdf-page-${number}">${xml(text.back)}</a></p>`;
    const content = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${XHTML}" lang="${xml(text.language)}" xml:lang="${xml(text.language)}"><head><title>${xml(metadata.title)} — ${xml(text.title)}</title><style>body{margin:0;padding:.75em}h1{font-size:1.2em}figure{margin:0}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body id="original-page-${number}"><h1>${xml(text.title)}</h1>${back}<figure><img src="page-${number}.jpg" alt="${xml(metadata.title)} — ${xml(text.title)}"/></figure>${back}</body></html>`;
    zip.file(imagePath, bytes, { compression: 'STORE' }); zip.file(documentPath, content);
    return { ...result, bytes: bytes.byteLength + length(content) };
  } finally { canvas.width = canvas.height = 0; }
}

function parse(value: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('conversionFailed');
  const document = new DOMParser().parseFromString(value, 'application/xml');
  if (document.getElementsByTagNameNS('*', 'parsererror').length) throw new Error('conversionFailed');
  return document;
}

function serialize(document: XMLDocument): string {
  return '<?xml version="1.0" encoding="utf-8"?>' + new XMLSerializer().serializeToString(document).replace(/^<\?xml[^>]*\?>\s*/i, '');
}

/** Add source-page access to an already converted book, without repeating OCR. Mutates the supplied ZIP. */
export async function appendOriginalPages(zip: JSZip, pdf: PDFDocumentProxy, numbers: number[], metadata: OriginalMetadata, progress?: (completed: number, total: number) => void): Promise<{ bytes: number; pages: number }> {
  const selected = [...new Set(numbers)].sort((a, b) => a - b);
  if (selected.some(number => !Number.isSafeInteger(number) || number < 1 || number > pdf.numPages)) throw new Error('conversionFailed');
  const packageFile = zip.file('OEBPS/book.opf'); if (!packageFile) throw new Error('conversionFailed');
  const oldPackage = await packageFile.async('string'), packageDocument = parse(oldPackage);
  const manifest = packageDocument.getElementsByTagNameNS(OPF, 'manifest')[0], spine = packageDocument.getElementsByTagNameNS(OPF, 'spine')[0];
  if (!manifest || !spine) throw new Error('conversionFailed');
  const manifestIds = new Set(Array.from(manifest.getElementsByTagNameNS(OPF, 'item')).map(item => item.getAttribute('id')));
  const spineIds = new Set(Array.from(spine.getElementsByTagNameNS(OPF, 'itemref')).map(item => item.getAttribute('idref')));
  let bytes = 0;
  for (let index = 0; index < selected.length; index++) {
    const number = selected[index], path = `OEBPS/page-${number}.xhtml`, file = zip.file(path);
    if (!file) throw new Error('conversionFailed');
    const oldContent = await file.async('string'), document = parse(oldContent), body = document.getElementsByTagNameNS(XHTML, 'body')[0];
    if (!body) throw new Error('conversionFailed');
    const page = await pdf.getPage(number);
    let original: OriginalPage;
    try { original = await createOriginalPage(zip, page, number, metadata); } finally { page.cleanup(); }
    bytes += original.bytes;
    const additions = parse(`<manifest xmlns="${OPF}">${original.manifest.join('')}${original.spine}</manifest>`);
    for (const item of Array.from(additions.getElementsByTagNameNS(OPF, 'item'))) {
      const id = item.getAttribute('id'); if (manifestIds.has(id)) continue;
      manifest.appendChild(packageDocument.importNode(item, true)); manifestIds.add(id);
    }
    if (!spineIds.has(`original-page-${number}`)) {
      const item = additions.getElementsByTagNameNS(OPF, 'itemref')[0];
      spine.appendChild(packageDocument.importNode(item, true)); spineIds.add(`original-page-${number}`);
    }
    const href = `original-pages/page-${number}.xhtml#original-page-${number}`;
    if (!Array.from(body.getElementsByTagNameNS(XHTML, 'a')).some(link => link.getAttribute('href') === href)) {
      const link = parse(`<body xmlns="${XHTML}">${original.link}</body>`).documentElement.firstElementChild!;
      body.appendChild(document.importNode(link, true));
      const updated = serialize(document); zip.file(path, updated); bytes += Math.max(0, length(updated) - length(oldContent));
    }
    progress?.(index + 1, selected.length);
  }
  // Supplemental image documents never interrupt Next/Previous through the main text.
  const originalItems = Array.from(spine.getElementsByTagNameNS(OPF, 'itemref')).filter(item => /^original-page-\d+$/.test(item.getAttribute('idref') || ''))
    .sort((a, b) => Number(a.getAttribute('idref')!.slice(14)) - Number(b.getAttribute('idref')!.slice(14)));
  for (const item of originalItems) { item.setAttribute('linear', 'no'); spine.appendChild(item); }
  const updated = serialize(packageDocument); zip.file('OEBPS/book.opf', updated); bytes += Math.max(0, length(updated) - length(oldPackage));
  return { bytes, pages: selected.length };
}
