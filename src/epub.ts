import JSZip from 'jszip';
import type { Cover, Metadata } from './types';

const DC = 'http://purl.org/dc/elements/1.1/';
const OPF = 'http://www.idpf.org/2007/opf';
const MAX_EXPANDED = 768 * 1024 * 1024;
export const MAX_BOOK_SIZE = 192 * 1024 * 1024;

export function emptyMetadata(title = ''): Metadata {
  return { title, authors: [], language: '', publisher: '', description: '', tags: [], series: '', seriesIndex: '', isbn: '', published: '' };
}

function parse(raw: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    // EPUBs commonly use a plain XHTML DOCTYPE. Internal/external entity declarations are unnecessary here.
    if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(raw)) throw new Error('XML com entidades não é suportado.');
    raw = raw.replace(/<!DOCTYPE[^>]*>/gi, '');
  }
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('O EPUB contém um XML inválido.');
  return doc;
}
function elements(root: Document | Element, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', local));
}
function dc(root: Element, local: string) { return Array.from(root.getElementsByTagNameNS(DC, local)); }
function text(root: Element, local: string) { return dc(root, local)[0]?.textContent?.trim() ?? ''; }
function creatorRole(root: Element, creator: Element) {
  return creator.getAttributeNS(OPF, 'role') || elements(root, 'meta').find(m => creator.id && m.getAttribute('refines') === '#' + creator.id && m.getAttribute('property') === 'role')?.textContent?.trim() || 'aut';
}
function resolvePath(base: string, href: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(href.split('#')[0]); } catch { throw new Error('Caminho inválido no EPUB.'); }
  if (/^[a-z]+:|^\/|\\/i.test(decoded)) throw new Error('Caminho externo inválido no EPUB.');
  const parts = base.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('Caminho fora do EPUB.'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
async function open(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
  const zip = await JSZip.loadAsync(bytes);
  // Check sizes before decompressing content, including a highly compressed archive.
  let total = 0;
  for (const file of Object.values(zip.files)) {
    const entry = file as unknown as { _data?: { uncompressedSize?: number } };
    total += entry._data?.uncompressedSize ?? 0;
    if (total > MAX_EXPANDED) throw new Error('EPUB muito grande após descompressão (limite: 768 MB).');
    if (/^\/|\\|(^|\/)\.\.(\/|$)/.test(file.unsafeOriginalName ?? file.name)) throw new Error('Caminho inseguro no EPUB.');
  }
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Este arquivo não é um EPUB válido: falta container.xml.');
  const container = parse(await containerFile.async('string'));
  const opfPath = elements(container, 'rootfile').map(x => x.getAttribute('full-path') ?? '').find(x => zip.file(x));
  if (!opfPath || !zip.file(opfPath)) throw new Error('Pacote de metadados do EPUB não encontrado.');
  const doc = parse(await zip.file(opfPath)!.async('string'));
  const metadata = elements(doc, 'metadata')[0];
  const manifest = elements(doc, 'manifest')[0];
  if (!metadata || !manifest) throw new Error('Metadados ou manifesto ausentes no EPUB.');
  const encryption = zip.file('META-INF/encryption.xml');
  if (encryption) {
    const enc = parse(await encryption.async('string'));
    const allowed = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
    if (elements(enc, 'EncryptionMethod').some(x => !allowed.includes(x.getAttribute('Algorithm') ?? ''))) {
      throw new Error('Este EPUB tem conteúdo protegido por DRM e não pode ser editado ou convertido.');
    }
  }
  const metas = elements(metadata, 'meta');
  const coverId = metas.find(x => x.getAttribute('name') === 'cover')?.getAttribute('content');
  const items = elements(manifest, 'item');
  const coverItem = items.find(x => (x.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image'))
    ?? items.find(x => x.getAttribute('id') === coverId);
  const coverPath = coverItem ? resolvePath(opfPath, coverItem.getAttribute('href') ?? '') : undefined;
  return { zip, opfPath, doc, metadata, manifest, metas, coverItem, coverPath };
}

export async function readEpub(bytes: Uint8Array): Promise<{ metadata: Metadata; cover?: Cover }> {
  const book = await open(bytes);
  const { metadata: root, metas, coverItem, coverPath, zip } = book;
  const named = (name: string) => metas.find(x => x.getAttribute('name') === name)?.getAttribute('content') ?? '';
  const collections = metas.filter(x => x.getAttribute('property') === 'belongs-to-collection');
  const series = collections.find(x => metas.some(m => m.getAttribute('refines') === '#' + x.id && m.getAttribute('property') === 'collection-type' && m.textContent === 'series'));
  const isbn = dc(root, 'identifier').find(x => x.getAttributeNS(OPF, 'scheme')?.toLowerCase() === 'isbn' || /^urn:isbn:/i.test(x.textContent ?? ''))?.textContent?.replace(/^urn:isbn:/i, '').trim() ?? '';
  const metadata: Metadata = {
    title: text(root, 'title'),
    authors: dc(root, 'creator').filter(x => creatorRole(root, x) === 'aut').map(x => x.textContent?.trim() ?? '').filter(Boolean),
    language: text(root, 'language'), publisher: text(root, 'publisher'), description: text(root, 'description'),
    tags: dc(root, 'subject').map(x => x.textContent?.trim() ?? '').filter(Boolean),
    series: named('calibre:series') || series?.textContent?.trim() || '',
    seriesIndex: named('calibre:series_index') || metas.find(m => series && m.getAttribute('refines') === '#' + series.id && m.getAttribute('property') === 'group-position')?.textContent?.trim() || '',
    isbn, published: text(root, 'date'),
  };
  const cover = coverPath && zip.file(coverPath) ? {
    bytes: await zip.file(coverPath)!.async('uint8array'), mime: coverItem?.getAttribute('media-type') || 'image/jpeg',
  } : undefined;
  // Never render SVG/HTML from an imported book as a privileged app document.
  return { metadata, cover: cover && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(cover.mime) ? cover : undefined };
}

export async function editEpub(bytes: Uint8Array, metadata: Metadata, cover?: Cover): Promise<Uint8Array> {
  if (!metadata.title.trim()) throw new Error('Preencha o título do livro.');
  const b = await open(bytes);
  const { doc, zip, opfPath, manifest } = b;
  const root = b.metadata;
  const setDC = (name: string, value: string) => {
    const existing = dc(root, name);
    let node = existing[0];
    if (!value && !node) return;
    if (!node) { node = doc.createElementNS(DC, 'dc:' + name); root.appendChild(node); }
    node.textContent = value;
  };
  setDC('title', metadata.title.trim()); setDC('language', metadata.language.trim());
  setDC('publisher', metadata.publisher); setDC('description', metadata.description); setDC('date', metadata.published);
  const removeWithRefinements = (node: Element) => {
    if (node.id) elements(root, 'meta').filter(m => m.getAttribute('refines') === '#' + node.id).forEach(m => m.remove());
    node.remove();
  };
  const creators = dc(root, 'creator').filter(x => creatorRole(root, x) === 'aut');
  creators.forEach(removeWithRefinements);
  for (const author of metadata.authors.map(x => x.trim()).filter(Boolean)) {
    const creator = doc.createElementNS(DC, 'dc:creator');
    if (Number(doc.documentElement.getAttribute('version')) < 3) creator.setAttributeNS(OPF, 'opf:role', 'aut');
    creator.textContent = author; root.appendChild(creator);
  }
  dc(root, 'subject').forEach(x => x.remove());
  for (const tag of metadata.tags.map(x => x.trim()).filter(Boolean)) {
    const node = doc.createElementNS(DC, 'dc:subject'); node.textContent = tag; root.appendChild(node);
  }
  const setMeta = (name: string, value: string) => {
    elements(root, 'meta').filter(x => x.getAttribute('name') === name).forEach(x => x.remove());
    if (value) { const node = doc.createElementNS(OPF, 'meta'); node.setAttribute('name', name); node.setAttribute('content', value); root.appendChild(node); }
  };
  setMeta('calibre:series', metadata.series); setMeta('calibre:series_index', metadata.series ? metadata.seriesIndex || '1' : '');
  const isV3 = Number(doc.documentElement.getAttribute('version')) >= 3;
  for (const col of elements(root, 'meta').filter(x => x.getAttribute('property') === 'belongs-to-collection')) {
    if (elements(root, 'meta').some(m => m.getAttribute('refines') === '#' + col.id && m.getAttribute('property') === 'collection-type' && m.textContent === 'series')) removeWithRefinements(col);
  }
  if (isV3 && metadata.series) {
    const id = 'kbm-series-' + crypto.randomUUID();
    for (const [property, value, refines] of [['belongs-to-collection', metadata.series, ''], ['collection-type', 'series', '#' + id], ['group-position', metadata.seriesIndex || '1', '#' + id]]) {
      const node = doc.createElementNS(OPF, 'meta'); node.setAttribute('property', property); node.textContent = value;
      if (refines) node.setAttribute('refines', refines); else node.setAttribute('id', id);
      root.appendChild(node);
    }
  }
  // Keep the package's unique identifier intact, including when it is an ISBN (font obfuscation can depend on it).
  const uniqueId = doc.documentElement.getAttribute('unique-identifier');
  const isbnNodes = dc(root, 'identifier').filter(x => x.getAttributeNS(OPF, 'scheme')?.toLowerCase() === 'isbn' || /^urn:isbn:/i.test(x.textContent ?? ''));
  isbnNodes.filter(x => x.id !== uniqueId).forEach(x => x.remove());
  const preservedIsbn = isbnNodes.find(x => x.id === uniqueId)?.textContent?.replace(/^urn:isbn:/i, '').trim();
  if (metadata.isbn && metadata.isbn !== preservedIsbn) {
    const node = doc.createElementNS(DC, 'dc:identifier');
    if (!isV3) node.setAttributeNS(OPF, 'opf:scheme', 'ISBN');
    node.textContent = 'urn:isbn:' + metadata.isbn.replace(/^urn:isbn:/i, ''); root.insertBefore(node, root.firstChild);
  }
  if (isV3) {
    elements(root, 'meta').filter(x => x.getAttribute('property') === 'dcterms:modified').forEach(x => x.remove());
    const node = doc.createElementNS(OPF, 'meta'); node.setAttribute('property', 'dcterms:modified'); node.textContent = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); root.appendChild(node);
  }
  if (cover) {
    if (!['image/jpeg', 'image/png'].includes(cover.mime)) throw new Error('Use uma capa JPEG ou PNG.');
    const ext = cover.mime === 'image/png' ? 'png' : 'jpg';
    const coverHref = 'kbm-cover-' + crypto.randomUUID() + '.' + ext;
    const newPath = resolvePath(opfPath, coverHref);
    zip.file(newPath, cover.bytes);
    let item = b.coverItem;
    if (!item) { item = doc.createElementNS(OPF, 'item'); item.setAttribute('id', 'kbm-cover-' + crypto.randomUUID()); manifest.appendChild(item); }
    item.setAttribute('href', coverHref); item.setAttribute('media-type', cover.mime);
    if (isV3) item.setAttribute('properties', [...new Set((item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean).concat('cover-image'))].join(' '));
    setMeta('cover', item.getAttribute('id')!);
    let coverPageUpdated = false;
    if (b.coverPath) {
      for (const entry of Object.values(zip.files).filter(x => /\.(xhtml|html|htm|svg)$/i.test(x.name))) {
        const raw = await entry.async('string');
        let page: XMLDocument;
        try { page = parse(raw); } catch { continue; }
        let changed = false;
        for (const element of Array.from(page.getElementsByTagName('*'))) {
          for (const attr of Array.from(element.attributes)) {
            if (!['src', 'href'].includes(attr.localName)) continue;
            try {
              if (resolvePath(entry.name, attr.value) !== b.coverPath) continue;
              const from = entry.name.split('/').slice(0, -1); const to = newPath.split('/');
              while (from.length && from[0] === to[0]) { from.shift(); to.shift(); }
              attr.value = '../'.repeat(from.length) + to.join('/'); changed = true;
            } catch { /* External links and data URLs are not cover references. */ }
          }
        }
        if (changed) { zip.file(entry.name, new XMLSerializer().serializeToString(page)); coverPageUpdated = true; }
      }
      for (const reference of elements(doc, 'reference')) {
        try { if (resolvePath(opfPath, reference.getAttribute('href') ?? '') === b.coverPath) reference.setAttribute('href', coverHref); } catch { /* Keep unrelated links. */ }
      }
    }
    if (!coverPageUpdated) {
      const pageId = 'kbm-titlepage-' + crypto.randomUUID(); const href = pageId + '.xhtml';
      zip.file(resolvePath(opfPath, href), '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capa</title></head><body style="margin:0;text-align:center"><img style="max-width:100%;max-height:100%" alt="Capa" src="' + coverHref + '" /></body></html>');
      const page = doc.createElementNS(OPF, 'item'); page.setAttribute('id', pageId); page.setAttribute('href', href); page.setAttribute('media-type', 'application/xhtml+xml'); manifest.appendChild(page);
      const spine = elements(doc, 'spine')[0];
      if (spine) { const ref = doc.createElementNS(OPF, 'itemref'); ref.setAttribute('idref', pageId); spine.insertBefore(ref, spine.firstChild); }
      let guide = elements(doc, 'guide')[0]; if (!guide) { guide = doc.createElementNS(OPF, 'guide'); doc.documentElement.appendChild(guide); }
      elements(guide, 'reference').filter(x => x.getAttribute('type') === 'cover').forEach(x => x.remove());
      const ref = doc.createElementNS(OPF, 'reference'); ref.setAttribute('type', 'cover'); ref.setAttribute('title', 'Capa'); ref.setAttribute('href', href); guide.appendChild(ref);
    }
  }
  zip.file(opfPath, new XMLSerializer().serializeToString(doc));
  // EPUB requires mimetype to be the first ZIP entry, stored without compression.
  const out = new JSZip(); out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  for (const entry of Object.values(zip.files)) if (entry.name !== 'mimetype' && !entry.dir) out.file(entry.name, await entry.async('uint8array'));
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
