import type JSZip from 'jszip';
import type { NavigationEntry } from './pdf-navigation';
import { lineSeparator } from './pdf-language';

const XHTML = 'http://www.w3.org/1999/xhtml';
const OPF = 'http://www.idpf.org/2007/opf';
const XML = 'http://www.w3.org/XML/1998/namespace';
interface SourcePage { path: string; number: number; item: Element; document: Document; body: Element }
interface Location { path: string; body: string; ids: Map<string, string> }
interface Chapter { path: string; id: string; title: string; pages: SourcePage[] }

function parse(value: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('conversionFailed');
  const document = new DOMParser().parseFromString(value, 'application/xml');
  if (document.getElementsByTagNameNS('*', 'parsererror').length) throw new Error('conversionFailed');
  return document;
}
const serialize = (document: Document) => '<?xml version="1.0" encoding="utf-8"?>' + new XMLSerializer().serializeToString(document).replace(/^<\?xml[^>]*\?>\s*/i, '');
const elements = (element: Element | Document, name: string) => Array.from(element.getElementsByTagNameNS('*', name));
const directory = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const encodedPath = (path: string) => path.split('/').map(part => encodeURIComponent(part)).join('/');

function localTarget(href: string, from: string): { path: string; fragment: string; search: string } | undefined {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return;
  try {
    const target = new URL(href, 'https://pdf.invalid/' + encodedPath(from));
    if (target.origin !== 'https://pdf.invalid') return;
    return { path: decodeURIComponent(target.pathname.slice(1)), fragment: decodeURIComponent(target.hash.slice(1)), search: target.search };
  } catch { return; }
}

function relativePath(from: string, to: string): string {
  const base = directory(from).split('/').filter(Boolean), target = to.split('/');
  while (base.length && target.length && base[0] === target[0]) { base.shift(); target.shift(); }
  return '../'.repeat(base.length) + target.map(part => encodeURIComponent(part)).join('/');
}

function rewritten(href: string, from: string, locations: Map<string, Location>): string {
  const target = localTarget(href, from), location = target && locations.get(target.path);
  if (!target || !location) return href;
  const fragment = target.fragment ? location.ids.get(target.fragment) || target.fragment : location.body;
  return relativePath(from, location.path) + target.search + '#' + encodeURIComponent(fragment);
}

function rewriteAttributes(document: Document, from: string, locations: Map<string, Location>): boolean {
  let changed = false;
  for (const element of Array.from(document.getElementsByTagName('*'))) for (const attribute of Array.from(element.attributes)) {
    if (attribute.localName !== 'href' && attribute.localName !== 'src') continue;
    const value = rewritten(attribute.value, from, locations);
    if (value === attribute.value) continue;
    element.setAttributeNS(attribute.namespaceURI, attribute.name, value); changed = true;
  }
  return changed;
}

function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const node of elements(clone, 'rt').concat(elements(clone, 'rp'))) node.remove();
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstBlock(body: Element): Element | undefined {
  return Array.from(body.children).find(element => visibleText(element) || elements(element, 'img').length || element.localName === 'img');
}

function lastBlock(body: Element): Element | undefined {
  for (const element of Array.from(body.children).reverse()) {
    if (element.localName === 'section') { const last = lastBlock(element); if (last) return last; }
    else if (visibleText(element) || elements(element, 'img').length || element.localName === 'img') return element;
  }
}

/** Without source coordinates, only an unfinished prose continuation is a safe
 * cross-page merge. Lists, headings, art, short labels and link rows stay intact. */
function continues(before: Element | undefined, after: Element | undefined): boolean {
  if (!before || !after || before.localName !== 'p' || after.localName !== 'p' ||
    before.getAttribute('dir') !== after.getAttribute('dir') || elements(before, 'img').length || elements(after, 'img').length) return false;
  const previous = visibleText(before), next = visibleText(after);
  if (previous.length < 60 || next.length < 30 || /[.!?。！？…;:]["'”’」』)]*$/u.test(previous) || /^[▪■●•\d]/u.test(next)) return false;
  const linked = (element: Element) => elements(element, 'a').reduce((count, a) => count + visibleText(a).length, 0);
  if (linked(before) > previous.length * .5 || linked(after) > next.length * .5) return false;
  return /^\p{Ll}/u.test(next) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next);
}

function removeWrapHyphen(paragraph: Element, after: string): boolean {
  const previous = visibleText(paragraph);
  if (!(/\u00ad$/u.test(previous) || /\p{Ll}-$/u.test(previous) && /^\p{Ll}/u.test(after))) return false;
  const texts: Text[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) { if (node.textContent?.trim()) texts.push(node as Text); }
    else if (node.nodeType !== 1 || !['rt', 'rp'].includes((node as Element).localName)) for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(paragraph);
  const last = texts.at(-1); if (!last) return false;
  const text = last.textContent || '', updated = text.replace(/[-\u00ad]\s*$/u, '');
  if (text === updated) return false;
  last.textContent = updated; return true;
}

function originalLabel(language: string): string {
  const primary = language.toLowerCase().split('-')[0];
  return ({ pt: 'Páginas originais', ja: '元のページ', zh: '原始页面', ko: '원본 페이지', th: 'หน้าต้นฉบับ', ru: 'Исходные страницы', es: 'Páginas originales' } as Record<string, string>)[primary] || 'Original pages';
}

function appendOriginalReferences(document: Document, body: Element, links: { number: number; anchor: Element }[], language: string) {
  if (!links.length) return;
  const aside = document.createElementNS(XHTML, 'aside'); aside.setAttribute('class', 'pdf-original-pages');
  const paragraph = document.createElementNS(XHTML, 'p'), label = document.createElementNS(XHTML, 'strong');
  label.textContent = originalLabel(language) + ': '; paragraph.appendChild(label);
  for (const [index, link] of links.entries()) {
    if (index) paragraph.appendChild(document.createTextNode(' · '));
    const anchor = document.importNode(link.anchor, true) as Element;
    anchor.setAttribute('title', anchor.textContent || ''); anchor.textContent = String(link.number); paragraph.appendChild(anchor);
  }
  aside.appendChild(paragraph); body.appendChild(aside);
}

function assemble(chapter: Chapter, locations: Map<string, Location>): Document {
  const document = parse(serialize(chapter.pages[0].document)), body = elements(document, 'body')[0], head = elements(document, 'head')[0];
  if (!body || !head) throw new Error('conversionFailed');
  body.replaceChildren(); body.setAttribute('id', chapter.id);
  let title = elements(head, 'title')[0]; if (!title) { title = document.createElementNS(XHTML, 'title'); head.appendChild(title); } title.textContent = chapter.title;
  const style = document.createElementNS(XHTML, 'style'); style.textContent = '.pdf-original-pages{margin-top:1em}.pdf-original-pages p{text-indent:0}'; head.appendChild(style);
  const references: { number: number; anchor: Element }[] = [];
  for (const page of chapter.pages) {
    const pageBody = page.body, location = locations.get(page.path)!;
    for (const reference of Array.from(pageBody.querySelectorAll('.original-page-link'))) {
      const anchor = elements(reference, 'a')[0]; if (anchor) references.push({ number: page.number, anchor }); reference.remove();
    }
    const language = pageBody.getAttribute('lang') || pageBody.getAttributeNS(XML, 'lang') || page.document.documentElement.getAttribute('lang') || '';
    const section = document.createElementNS(XHTML, 'section'); section.setAttribute('class', 'pdf-page');
    if (language) { section.setAttribute('lang', language); section.setAttributeNS(XML, 'xml:lang', language); }
    const marker = document.createElementNS(XHTML, 'span'); marker.setAttribute('id', location.body); marker.setAttribute('class', 'pdf-page-anchor'); marker.setAttribute('data-pdf-page', String(page.number));
    const previous = lastBlock(body), next = firstBlock(pageBody);
    if (continues(previous, next)) {
      const priorText = visibleText(previous!), nextText = visibleText(next!);
      const unwrapped = removeWrapHyphen(previous!, nextText);
      const separator = unwrapped ? '' : lineSeparator(priorText, nextText);
      if (separator) previous!.appendChild(document.createTextNode(separator));
      previous!.appendChild(marker);
      // Preserve anchors and per-page language when a paragraph crosses a PDF
      // page boundary; inline spans do not introduce a new reading paragraph.
      const continuation = document.createElementNS(XHTML, 'span');
      for (const attribute of Array.from(next!.attributes)) if (['id', 'lang', 'dir', 'class'].includes(attribute.localName)) continuation.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      if (language && !continuation.hasAttribute('lang')) { continuation.setAttribute('lang', language); continuation.setAttributeNS(XML, 'xml:lang', language); }
      while (pageBody.firstChild && pageBody.firstChild !== next) { previous!.appendChild(document.importNode(pageBody.firstChild, true)); pageBody.firstChild.remove(); }
      for (const child of Array.from(next!.childNodes)) continuation.appendChild(document.importNode(child, true));
      previous!.appendChild(continuation); next!.remove();
    } else section.appendChild(marker);
    for (const child of Array.from(pageBody.childNodes)) section.appendChild(document.importNode(child, true));
    if (section.childNodes.length) body.appendChild(section);
  }
  const language = document.documentElement.getAttribute('lang') || body.getAttribute('lang') || '';
  appendOriginalReferences(document, body, references, language);
  return document;
}

/** Assemble real chapters after PDF conversion. Physical-page anchors remain
 * available to the printed index, page list, annotations and source previews. */
export async function assemblePdfChapters(zip: JSZip, chapters: NavigationEntry[]): Promise<NavigationEntry[]> {
  const containerFile = zip.file('META-INF/container.xml'); if (!containerFile) throw new Error('conversionFailed');
  const container = parse(await containerFile.async('string')), packagePath = elements(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!packagePath || !zip.file(packagePath)) throw new Error('conversionFailed');
  const packageDocument = parse(await zip.file(packagePath)!.async('string')), manifest = elements(packageDocument, 'manifest')[0], spine = elements(packageDocument, 'spine')[0];
  if (!manifest || !spine) throw new Error('conversionFailed');
  const items = new Map(elements(manifest, 'item').map(item => [item.getAttribute('id'), item]));
  const pages: SourcePage[] = [];
  for (const ref of elements(spine, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = items.get(ref.getAttribute('idref')), target = item && localTarget(item.getAttribute('href') || '', packagePath);
    const number = target?.path.match(/(?:^|\/)page-(\d+)\.xhtml$/)?.[1];
    if (!item || !target || !number) continue;
    const file = zip.file(target.path); if (!file) throw new Error('conversionFailed');
    const document = parse(await file.async('string')), body = elements(document, 'body')[0]; if (!body) throw new Error('conversionFailed');
    if (!body.hasAttribute('id')) body.setAttribute('id', 'pdf-page-' + number);
    pages.push({ path: target.path, number: Number(number), item, document, body });
  }
  const starts = new Map<number, NavigationEntry>();
  for (const chapter of chapters) {
    const target = localTarget(chapter.href, packagePath), index = target ? pages.findIndex(page => page.path === target.path) : -1;
    if (index >= 0 && !starts.has(index)) starts.set(index, chapter);
  }
  const ordered = [...starts.keys()].sort((a, b) => a - b);
  if (ordered.length < 2) return chapters;
  const usedIds = new Set(elements(manifest, 'item').map(item => item.getAttribute('id') || ''));
  const planned: Chapter[] = [];
  for (const [index, start] of ordered.entries()) {
    let suffix = '', attempt = 1, path = '', id = '';
    do { suffix = attempt === 1 ? '' : '-' + attempt; path = directory(packagePath) + `chapter-${index + 1}${suffix}.xhtml`; id = `pdf-chapter-${index + 1}${suffix}`; attempt++; } while (zip.file(path) || usedIds.has(id));
    usedIds.add(id); planned.push({ path, id, title: starts.get(start)!.title, pages: pages.slice(start, ordered[index + 1] ?? pages.length) });
  }
  const locations = new Map<string, Location>(), replacements = new Map<string, Chapter>();
  for (const chapter of planned) {
    const ids = new Set<string>([chapter.id]); let collision = 0;
    for (const page of chapter.pages) {
      const renamed = new Map<string, string>();
      for (const element of [page.body, ...Array.from(page.body.getElementsByTagName('*'))]) {
        const previous = element.getAttribute('id'); if (!previous) continue;
        let id = previous; while (ids.has(id)) id = `pdf-page-${page.number}-anchor-${++collision}`;
        ids.add(id); renamed.set(previous, id); element.setAttribute('id', id);
      }
      locations.set(page.path, { path: chapter.path, body: page.body.getAttribute('id')!, ids: renamed });
      replacements.set(page.item.getAttribute('id')!, chapter);
    }
  }
  for (const page of pages) rewriteAttributes(page.document, page.path, locations);
  for (const chapter of planned) {
    zip.file(chapter.path, serialize(assemble(chapter, locations)));
    for (const page of chapter.pages) { zip.remove(page.path); page.item.remove(); }
    const item = packageDocument.createElementNS(OPF, 'item'); item.setAttribute('id', chapter.id); item.setAttribute('href', relativePath(packagePath, chapter.path)); item.setAttribute('media-type', 'application/xhtml+xml'); manifest.appendChild(item);
  }
  const emitted = new Set<string>();
  for (const ref of elements(spine, 'itemref')) {
    const chapter = replacements.get(ref.getAttribute('idref') || ''); if (!chapter) continue;
    if (emitted.has(chapter.id)) ref.remove();
    else { ref.setAttribute('idref', chapter.id); emitted.add(chapter.id); }
  }
  zip.file(packagePath, serialize(packageDocument));
  // This also retargets NCX, OPF guide entries, the hidden page list and the
  // return links in non-linear facsimiles. External URLs remain unchanged.
  for (const path of Object.keys(zip.files)) {
    if (!/\.(?:xhtml|html|htm|opf|ncx|svg)$/i.test(path) || zip.files[path].dir) continue;
    const file = zip.file(path)!;
    const document = parse(await file.async('string'));
    if (rewriteAttributes(document, path, locations)) zip.file(path, serialize(document));
  }
  const rewriteEntries = (entries: NavigationEntry[]): NavigationEntry[] => entries.map(entry => ({ ...entry, href: rewritten(entry.href, packagePath, locations), ...(entry.children ? { children: rewriteEntries(entry.children) } : {}) }));
  return rewriteEntries(chapters);
}
