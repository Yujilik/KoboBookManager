// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { assemblePdfChapters } from '../src/pdf-chapters';
import type { NavigationEntry } from '../src/pdf-navigation';

const XHTML = 'http://www.w3.org/1999/xhtml', OPF = 'http://www.idpf.org/2007/opf';
const html = (number: number, content: string, language = 'en') => `<?xml version="1.0"?><html xmlns="${XHTML}" lang="${language}"><head><title>Physical page ${number}</title><link rel="stylesheet" href="style.css"/></head><body id="pdf-page-${number}">${content}</body></html>`;
const parse = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const entry = (page: number, title: string, children?: NavigationEntry[]): NavigationEntry => ({ title, href: `page-${page}.xhtml#pdf-page-${page}`, children: children || [] });
const paragraph = (text: string) => `<p>${text}</p>`;
const unfinished = 'An ordinary paragraph contains sufficient prose to continue across a physical page and splits a word in-';
const continuation = 'to a continuing sentence on the following physical page, retaining its links and formatting.';

async function fixture(options: { pages?: number; roots?: NavigationEntry[]; folder?: string; originals?: boolean; content?: Record<number, string> } = {}) {
  const count = options.pages ?? 6, roots = options.roots ?? [entry(2, 'First chapter', [{ title: 'Nested section', href: 'page-3.xhtml#%E7%AF%80%E4%BA%8C', children: [] }]), entry(5, 'Second chapter')];
  const folder = options.folder ?? 'OEBPS', zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${folder}/book.opf"/></rootfiles></container>`);
  const manifest = [`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`, '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', '<item id="style" href="style.css" media-type="text/css"/>', '<item id="picture" href="images/figure.jpg" media-type="image/jpeg"/>'];
  const spine: string[] = [], originalSpine: string[] = [];
  for (let number = 1; number <= count; number++) {
    manifest.push(`<item id="page-${number}" href="page-${number}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="page-${number}"/>`);
    const content = options.content?.[number] ?? (number === 2 ? `<h2 id="note">First chapter</h2>${paragraph(unfinished)}` : number === 3 ? `<p id="節二">${continuation} <a href="page-2.xhtml#note">Earlier heading</a></p><p id="note">A distinct note.</p>` : paragraph(`Ordinary text on physical page ${number}.`));
    const original = options.originals !== false ? `<p class="original-page-link"><a href="original-pages/page-${number}.xhtml#original-page-${number}">View original page ${number}</a></p>` : '';
    zip.file(`${folder}/page-${number}.xhtml`, html(number, content + original));
    if (options.originals !== false) {
      manifest.push(`<item id="original-page-${number}" href="original-pages/page-${number}.xhtml" media-type="application/xhtml+xml"/>`); originalSpine.push(`<itemref idref="original-page-${number}" linear="no"/>`);
      zip.file(`${folder}/original-pages/page-${number}.xhtml`, `<html xmlns="${XHTML}"><head><title>Original ${number}</title></head><body id="original-page-${number}"><a href="../page-${number}.xhtml#pdf-page-${number}">Return to text</a></body></html>`);
    }
  }
  zip.file(`${folder}/book.opf`, `<package xmlns="${OPF}" version="3.0"><metadata/><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}${originalSpine.join('')}</spine><guide><reference type="text" title="Start" href="page-2.xhtml#pdf-page-2"/></guide></package>`);
  zip.file(`${folder}/style.css`, 'p{text-indent:1.2em}'); zip.file(`${folder}/images/figure.jpg`, new Uint8Array([255, 216, 255, 217]));
  const nav = (nodes: NavigationEntry[]): string => '<ol>' + nodes.map(node => `<li><a href="${node.href}">${node.title}</a>${nav(node.children || [])}</li>`).join('') + '</ol>';
  zip.file(`${folder}/nav.xhtml`, `<html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Book</title></head><body><nav epub:type="toc">${nav(roots)}</nav><nav epub:type="page-list"><ol>${Array.from({ length: count }, (_, index) => `<li><a href="page-${index + 1}.xhtml#pdf-page-${index + 1}">${index + 1}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file(`${folder}/toc.ncx`, `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${roots.map((root, i) => `<navPoint id="n${i}"><navLabel><text>${root.title}</text></navLabel><content src="${root.href}"/></navPoint>`).join('')}</navMap></ncx>`);
  return { zip, roots, folder };
}

async function documentAt(zip: JSZip, file: string) {
  const content = zip.file(file); expect(content, file).not.toBeNull();
  const document = parse(await content!.async('string')); expect(document.querySelector('parsererror'), file).toBeNull(); return document;
}

async function verifyLinks(zip: JSZip) {
  for (const path of Object.keys(zip.files).filter(path => /\.(?:xhtml|ncx|opf)$/.test(path))) {
    const document = await documentAt(zip, path);
    const ids = Array.from(document.querySelectorAll('[id]')).map(element => element.id); expect(new Set(ids).size, path).toBe(ids.length);
    for (const element of Array.from(document.getElementsByTagName('*'))) for (const attr of ['href', 'src']) {
      const href = element.getAttribute(attr); if (!href || /^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      const target = new URL(href, 'https://book.test/' + path), name = decodeURIComponent(target.pathname.slice(1));
      expect(zip.file(name), path + ' -> ' + href).not.toBeNull();
      if (target.hash) expect((await documentAt(zip, name)).getElementById(decodeURIComponent(target.hash.slice(1))), href).not.toBeNull();
    }
  }
}

it('groups main physical pages into chapter spine items and leaves front matter and originals in order', async () => {
  const { zip, roots } = await fixture(); const tree = await assemblePdfChapters(zip, roots);
  expect(tree[0].href).toBe('chapter-1.xhtml#pdf-page-2'); expect(tree[1].href).toBe('chapter-2.xhtml#pdf-page-5');
  const opf = await documentAt(zip, 'OEBPS/book.opf');
  expect(Array.from(opf.querySelectorAll('spine>itemref')).map(e => [e.getAttribute('idref'), e.getAttribute('linear')])).toEqual([
    ['page-1', null], ['pdf-chapter-1', null], ['pdf-chapter-2', null], ...[1, 2, 3, 4, 5, 6].map(n => [`original-page-${n}`, 'no']),
  ]);
  expect(zip.file('OEBPS/page-1.xhtml')).not.toBeNull(); for (const n of [2, 3, 4, 5, 6]) expect(zip.file(`OEBPS/page-${n}.xhtml`)).toBeNull();
  const chapter = await documentAt(zip, 'OEBPS/chapter-1.xhtml'); expect(chapter.querySelector('title')?.textContent).toBe('First chapter');
  for (const n of [2, 3, 4]) expect(chapter.getElementById(`pdf-page-${n}`)).not.toBeNull();
  expect(roots[0].href).toBe('page-2.xhtml#pdf-page-2'); await verifyLinks(zip);
});

it('preserves nested headings, annotation fragments, non-ASCII IDs and page-list/NCX/source-return destinations', async () => {
  const { zip, roots } = await fixture(); const tree = await assemblePdfChapters(zip, roots);
  expect(tree[0].children?.[0].href).toBe('chapter-1.xhtml#%E7%AF%80%E4%BA%8C');
  const nav = await documentAt(zip, 'OEBPS/nav.xhtml');
  expect(nav.querySelector('a[href="chapter-1.xhtml#%E7%AF%80%E4%BA%8C"]')).not.toBeNull();
  expect(nav.querySelector('a[href="chapter-1.xhtml#pdf-page-4"]')).not.toBeNull();
  const ncx = await documentAt(zip, 'OEBPS/toc.ncx'); expect(ncx.querySelector('content')?.getAttribute('src')).toBe('chapter-1.xhtml#pdf-page-2');
  const original = await documentAt(zip, 'OEBPS/original-pages/page-3.xhtml'); expect(original.querySelector('a')?.getAttribute('href')).toBe('../chapter-1.xhtml#pdf-page-3');
  const guide = await documentAt(zip, 'OEBPS/book.opf'); expect(guide.querySelector('reference')?.getAttribute('href')).toBe('chapter-1.xhtml#pdf-page-2');
  await verifyLinks(zip);
});

it('merges unfinished prose without a forced PDF-page paragraph, retaining the page and subsection anchors at the seam', async () => {
  const { zip, roots } = await fixture(); await assemblePdfChapters(zip, roots);
  const chapter = await documentAt(zip, 'OEBPS/chapter-1.xhtml'), marker = chapter.getElementById('pdf-page-3')!;
  expect(marker.parentElement?.localName).toBe('p');
  expect(marker.parentElement?.textContent).toContain('splits a word into a continuing sentence');
  expect(marker.parentElement?.querySelector('[id="節二"]')).not.toBeNull();
  expect(chapter.querySelector('style')?.textContent).not.toMatch(/page-break|break-before|break-after/);
  expect(chapter.querySelector('.original-page-link')).toBeNull();
  const references = chapter.querySelector('.pdf-original-pages')!; expect(Array.from(references.querySelectorAll('a')).map(a => a.textContent)).toEqual(['2', '3', '4']);
  expect(chapter.querySelector('body')?.lastElementChild).toBe(references); await verifyLinks(zip);
});

it('does not merge a new paragraph, dialogue, chapter heading, illustration or link-heavy contents row', async () => {
  for (const next of [paragraph('A new paragraph starts with an uppercase word and has sufficient prose to remain separate.'), paragraph('“a separate dialogue paragraph remains a dialogue paragraph.”'), '<h2>A subsection</h2>' + paragraph(continuation), '<figure><img src="images/figure.jpg" alt="art"/></figure>' + paragraph(continuation), `<p><a href="page-5.xhtml#pdf-page-5">a linked contents row with sufficient text that belongs to a separate entry</a></p>`]) {
    const { zip, roots } = await fixture({ roots: [entry(2, 'First chapter'), entry(5, 'Second chapter')], content: { 3: next } }); await assemblePdfChapters(zip, roots);
    const chapter = await documentAt(zip, 'OEBPS/chapter-1.xhtml'); expect(chapter.getElementById('pdf-page-3')?.parentElement?.localName).toBe('section'); await verifyLinks(zip);
  }
});

it('renames colliding IDs within a combined chapter and keeps links to each original target distinct', async () => {
  const roots = [entry(2, 'One', [{ title: 'Note on page three', href: 'page-3.xhtml#note', children: [] }]), entry(5, 'Two')];
  const { zip } = await fixture({ roots, content: { 4: '<p><a href="page-2.xhtml#note">First note</a> <a href="page-3.xhtml#note">Other note</a></p>' } });
  const tree = await assemblePdfChapters(zip, roots); const chapter = await documentAt(zip, 'OEBPS/chapter-1.xhtml');
  const newTarget = decodeURIComponent(tree[0].children![0].href.split('#')[1]); expect(newTarget).not.toBe('note'); expect(chapter.getElementById(newTarget)?.textContent).toBe('A distinct note.');
  expect(chapter.querySelector('a[href="chapter-1.xhtml#note"]')?.textContent).toBe('Earlier heading'); await verifyLinks(zip);
});

it('keeps external URLs byte-for-byte and resolves encoded paths under a non-ASCII package folder', async () => {
  const url = 'https://example.org/a?lang=ja&amp;x=1#section';
  const { zip, roots } = await fixture({ folder: 'EPUB/日本語', content: { 4: `<p><a href="${url}">Website</a><a href="./page-3.xhtml#%E7%AF%80%E4%BA%8C">Text section</a></p>` } });
  await assemblePdfChapters(zip, roots); const chapter = await documentAt(zip, 'EPUB/日本語/chapter-1.xhtml');
  expect(chapter.querySelector('a[href^="https:"]')?.getAttribute('href')).toBe('https://example.org/a?lang=ja&x=1#section');
  expect(chapter.querySelector('a[href="chapter-1.xhtml#%E7%AF%80%E4%BA%8C"]')?.textContent).toBe('Text section'); await verifyLinks(zip);
});

it('preserves an empty physical page as an addressable zero-content anchor without inserting an empty paragraph', async () => {
  const { zip, roots } = await fixture({ originals: false, content: { 4: '' } }); await assemblePdfChapters(zip, roots);
  const chapter = await documentAt(zip, 'OEBPS/chapter-1.xhtml'); expect(chapter.getElementById('pdf-page-4')).not.toBeNull();
  expect(Array.from(chapter.querySelectorAll('p')).some(p => !p.textContent?.trim())).toBe(false); await verifyLinks(zip);
});

it('does not invent chapters when only one distinct root page is known', async () => {
  const { zip } = await fixture(); const before = await zip.generateAsync({ type: 'uint8array' });
  const roots = [entry(2, 'One'), { title: 'Same physical page', href: 'page-2.xhtml#note', children: [] }];
  expect(await assemblePdfChapters(zip, roots)).toBe(roots);
  expect(await zip.generateAsync({ type: 'uint8array' })).toEqual(before);
});

it('is safe to call again after physical pages have already been assembled', async () => {
  const { zip, roots } = await fixture(); const tree = await assemblePdfChapters(zip, roots);
  const before = await zip.generateAsync({ type: 'uint8array' }); expect(await assemblePdfChapters(zip, tree)).toBe(tree);
  expect(await zip.generateAsync({ type: 'uint8array' })).toEqual(before);
});
