import { AnnotationType, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { ReflowLink, ReflowTarget } from './pdf-reflow';

export interface NavigationEntry { title: string; href: string; children: NavigationEntry[] }
export interface PdfPageNavigation { links: ReflowLink[]; targets: ReflowTarget[]; title?: string; heading?: string; chapter?: string }
export interface PdfNavigation {
  chapters: NavigationEntry[];
  origin: 'printed' | 'outline' | 'headings';
  labels: string[] | null;
  page(number: number): PdfPageNavigation;
  text(number: number): TextContent | undefined;
}
type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>[number];
interface SourceLine { text: string; items: TextItem[]; x: number; y: number; height: number; rect: number[] }
interface PrintedEntry { title: string; label: string; source: number; rect: number[]; x: number }
interface LocatedEntry extends NavigationEntry { page: number }
const meaningful = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/\s+/g, ' ').trim();
const key = (value: string) => meaningful(value).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, '');
const contentsTitle = {
  // Character-spaced scan headings still identify the same short heading.
  test: (value: string) => /^(?:(?:tableof)?contents|índice|sum[aá]rio|sommaire|inhalt(?:sverzeichnis)?|目次|もくじ|目录|目錄|차례|목차|สารบัญ|содержание|оглавление)(?:continued)?$/iu.test(key(value)),
};
const noisyContentsTitle = /^.{0,8}(?:\b(?:contents|índice|sum[aá]rio|sommaire|inhalt(?:sverzeichnis)?|содержание|оглавление)\b|目次|もくじ|目录|目錄|차례|목차|สารบัญ).{0,8}$/iu;
const standaloneOrdinal = /^(?:(?:chapter|part|section)\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[ivxlcdm]+|\d+)$/iu;
const indexTitle = /^(?:index|索引)$/iu;
const pageHref = (page: number) => `page-${page}.xhtml#pdf-page-${page}`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Only navigable public URI schemes; PDF file/actions never become executable EPUB links. */
export function pdfLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return;
  try { const url = new URL(value); if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return url.href; } catch { /* Not an absolute supported URI. */ }
}

function lines(content: TextContent): SourceLine[] {
  const source = content.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim());
  const result: { items: TextItem[]; y: number; height: number }[] = [];
  for (const item of [...source].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const height = Math.abs(item.height) || 12, y = item.transform[5];
    let line = result.at(-1);
    if (!line || Math.abs(line.y - y) > Math.min(line.height, height) * 0.35) {
      line = { items: [], y, height }; result.push(line);
    }
    line.items.push(item); line.height = Math.max(line.height, height);
  }
  return result.map(line => {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '', end = -Infinity;
    for (const item of line.items) {
      if (text && !/\s$/.test(text) && !/^\s/.test(item.str) && item.transform[4] - end > line.height * 0.15) text += ' ';
      text += item.str; end = item.transform[4] + item.width;
    }
    const x = Math.min(...line.items.map(item => item.transform[4]));
    return { ...line, x, text: meaningful(text), rect: [x, line.y - line.height * 0.25, Math.max(...line.items.map(item => item.transform[4] + item.width)), line.y + line.height] };
  });
}

function printedEntries(source: number, pageLines: SourceLine[]): PrintedEntry[] {
  const result: PrintedEntry[] = [];
  let pending: SourceLine | undefined;
  let pendingOrdinal = false, ordinalSeen = false;
  const numberedRows = pageLines.filter(line => standaloneOrdinal.test(line.text)).length >= 2;
  const numberWords = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
  const noisyOrdinal = (value: string) => {
    if (!numberedRows || ordinalSeen) return false;
    const letters = [...value].filter(character => /[a-z]/i.test(character));
    if (letters.length < 3 || letters.length > 16 || letters.filter(character => character === character.toUpperCase()).length < letters.length * .6) return false;
    const token = letters.join('').toLowerCase(), limit = token.length >= 6 ? 3 : 1;
    return numberWords.some(word => {
      if (Math.abs(word.length - token.length) > limit) return false;
      let previous = Array.from({ length: word.length + 1 }, (_, i) => i);
      for (let i = 0; i < token.length; i++) {
        const row = [i + 1];
        for (let j = 0; j < word.length; j++) row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + Number(token[i] !== word[j])));
        previous = row;
      }
      return previous[word.length] <= limit;
    });
  };
  for (const line of pageLines) {
    if (standaloneOrdinal.test(line.text) || noisyOrdinal(line.text)) { pending = line; pendingOrdinal = true; ordinalSeen = true; continue; }
    const match = line.text.match(/^(.+?)(?:\s*[.·…_]{2,}\s*|\s+)(?:page\s*|p\.\s*)?([\p{Letter}]{1,6}[-–.]\d{1,5}|\d{1,5}[a-z]?|[ivxlcdm]{1,12})\s*$/iu);
    if (match) {
      let title = meaningful(match[1].replace(/[.·…_]+\s*$/, '').replace(/\s+[.·…_:–—-]+\s*$/u, '').replace(/^[.·…_:–—-]+\s+/u, ''));
      const preceding = pending && pending.y - line.y < Math.max(pending.height, line.height) * 1.8 && !contentsTitle.test(pending.text) && !indexTitle.test(pending.text) ? pending : undefined;
      // A wrapped title uses the same typography. Separate chapter numerals
      // (including noisy OCR of them) must not become part of the title.
      if (preceding && preceding.text.length > 3 && !pendingOrdinal && Math.abs(preceding.height - line.height) <= line.height * 0.25) title = `${preceding.text} ${title}`;
      if (title.length >= 2 && !/^\d+$/.test(title)) result.push({ title, label: match[2], source, x: preceding ? Math.min(preceding.x, line.x) : line.x, rect: preceding ? [Math.min(preceding.rect[0], line.rect[0]), line.rect[1], Math.max(preceding.rect[2], line.rect[2]), preceding.rect[3]] : line.rect });
      pending = undefined; pendingOrdinal = ordinalSeen = false;
    } else if (!contentsTitle.test(line.text) && !indexTitle.test(line.text) && !/^\d+$/.test(line.text) && line.text.length < 150) { pending = line; pendingOrdinal = false; }
    else { pending = undefined; pendingOrdinal = ordinalSeen = false; }
  }
  return result;
}

function sourcePage(href: string): number | undefined { const match = href.match(/^page-(\d+)\.xhtml(?:#|$)/); return match ? Number(match[1]) : undefined; }

/** Rebuild PDF outlines, annotation links and printed contents against reflowed XHTML documents. */
export async function buildPdfNavigation(document: PDFDocumentProxy, options: { readText?: (page: PDFPageProxy, number: number) => Promise<TextContent> } = {}): Promise<PdfNavigation> {
  const pages = new Map<number, PdfPageNavigation>(), texts = new Map<number, TextContent>(), pageLines = new Map<number, SourceLine[]>();
  const annotations = new Map<number, Record<string, unknown>[]>();
  const [outlineResult, labelResult] = await Promise.all([document.getOutline().catch(() => null), document.getPageLabels().catch(() => null)]);
  const outline = outlineResult ?? [], labels = labelResult?.length === document.numPages ? labelResult : null;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const [text, links] = await Promise.all([options.readText ? options.readText(page, number) : page.getTextContent({ disableNormalization: true }), page.getAnnotations().catch(() => [])]);
    texts.set(number, text); pageLines.set(number, lines(text)); annotations.set(number, links);
    pages.set(number, { links: [], targets: [] });
  }
  const refPages = new Map<string, number>(), coordinates = new Map<string, string>();
  let targetCount = 0;
  async function destination(value: unknown): Promise<string | undefined> {
    try {
      const target = typeof value === 'string' ? await document.getDestination(value) : value;
      if (!Array.isArray(target) || target.length < 2) return;
      const ref = target[0]; let page: number;
      if (Number.isInteger(ref)) page = ref + 1;
      else if (ref && Number.isInteger(ref.num) && Number.isInteger(ref.gen)) {
        const id = `${ref.num}:${ref.gen}`;
        if (!refPages.has(id)) refPages.set(id, await document.getPageIndex(ref) + 1);
        page = refPages.get(id)!;
      } else return;
      if (page < 1 || page > document.numPages) return;
      const mode = typeof target[1] === 'string' ? target[1] : target[1]?.name;
      let x: number | undefined, y: number | undefined;
      if (mode === 'XYZ') { if (finite(target[2])) x = target[2]; if (finite(target[3])) y = target[3]; }
      else if (mode === 'FitH' || mode === 'FitBH') { if (finite(target[2])) y = target[2]; }
      else if (mode === 'FitV' || mode === 'FitBV') { if (finite(target[2])) x = target[2]; }
      else if (mode === 'FitR') { if (finite(target[2])) x = target[2]; if (finite(target[5])) y = target[5]; }
      if (x === undefined && y === undefined) return pageHref(page);
      const coordinate = `${page}:${x ?? ''}:${y ?? ''}`;
      let id = coordinates.get(coordinate);
      if (!id) { id = `pdf-destination-${++targetCount}`; coordinates.set(coordinate, id); pages.get(page)!.targets.push({ id, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) }); }
      return `page-${page}.xhtml#${id}`;
    } catch { /* Broken destinations must not abort an otherwise readable book. */ }
  }
  let locatedOutline: LocatedEntry[] = [];
  async function outlineEntry(item: Outline): Promise<LocatedEntry | undefined> {
    const children = (await Promise.all((item.items ?? []).map(outlineEntry))).filter((entry): entry is LocatedEntry => !!entry);
    const href = await destination(item.dest) ?? children[0]?.href;
    const title = meaningful(item.title || '');
    const page = href && sourcePage(href);
    if (!title || !href || !page) return;
    return { title, href, children, page };
  }
  for (const item of outline) { const entry = await outlineEntry(item); if (entry) locatedOutline.push(entry); }
  const allOutlineEntries = (entries: LocatedEntry[]): LocatedEntry[] => entries.flatMap(entry => [entry, ...allOutlineEntries(entry.children as LocatedEntry[])]);
  const pageBookmark = (entry: LocatedEntry) => /^[\divxlcdm]+$/iu.test(entry.title.trim()) &&
    (key(entry.title) === key(labels?.[entry.page - 1] || '') || Number(entry.title) === entry.page);
  const pageBookmarks = allOutlineEntries(locatedOutline).filter(pageBookmark);
  const densePageBookmarks = pageBookmarks.length >= Math.max(12, document.numPages * 0.5);
  if (densePageBookmarks) {
    const prunePages = (entries: LocatedEntry[]): LocatedEntry[] => entries.flatMap(entry => {
      const children = prunePages(entry.children as LocatedEntry[]);
      return pageBookmark(entry) ? children : [{ ...entry, children }];
    });
    locatedOutline = prunePages(locatedOutline);
  }

  // Keep actual PDF link annotations, including named destinations and shared
  // links over multiple lines. Their rectangles address source text, not output coordinates.
  for (const [number, entries] of annotations) for (const item of entries) {
    if (item.subtype !== 'Link' && item.annotationType !== AnnotationType.LINK) continue;
    let href = await destination(item.dest) ?? pdfLinkUrl(item.url);
    if (!href && typeof item.action === 'string') {
      const page = { NextPage: number + 1, PrevPage: number - 1, FirstPage: 1, LastPage: document.numPages }[item.action];
      if (page && page > 0 && page <= document.numPages) href = pageHref(page);
    }
    if (!href) continue;
    const rect = item.rect;
    if (Array.isArray(rect) && rect.length === 4 && rect.every(finite)) pages.get(number)!.links.push({ rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])], href });
  }

  const labelPages = new Map<string, number>();
  labels?.forEach((label, index) => { const normalized = meaningful(label).toLocaleLowerCase(); if (!labelPages.has(normalized)) labelPages.set(normalized, index + 1); });
  const printed: PrintedEntry[] = [], referenceRows: PrintedEntry[] = [];
  const explicitContents = new Set<number>();
  function contentsLocations(entries: LocatedEntry[]) { for (const entry of entries) { if (contentsTitle.test(entry.title)) explicitContents.add(entry.page); contentsLocations(entry.children as LocatedEntry[]); } }
  contentsLocations(locatedOutline);
  let continued = false;
  for (const [number, sourceLines] of pageLines) {
    const rows = printedEntries(number, sourceLines);
    const index = sourceLines.slice(0, 4).some(line => indexTitle.test(line.text));
    const positions = rows.map(row => labelPages.get(row.label.toLocaleLowerCase()) ?? (/^\d+$/.test(row.label) ? Number(row.label) : undefined));
    const ordered = positions.every(value => value !== undefined) ? positions.every((value, i) => i === 0 || value! >= positions[i - 1]!) && new Set(positions).size >= 2 : true;
    const normal = sourceLines.map(line => line.height).sort((a, b) => a - b)[Math.floor(sourceLines.length / 2)] || 12;
    const coherentColumn = [0, 1, 2].some(axis => {
      const values = rows.map(row => axis === 0 ? row.rect[0] : axis === 1 ? (row.rect[0] + row.rect[2]) / 2 : row.rect[2]).sort((a, b) => a - b);
      let clusters = 1;
      for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] > normal * 4) clusters++;
      return clusters <= 2;
    });
    // Ordinal/title pairs and wrapped titles can occupy two or three lines per
    // entry. Consistent references and columns distinguish them from body prose.
    const contentsRows = rows.length >= 2 && rows.length * 3 >= sourceLines.length && coherentColumn && ordered;
    const heading = sourceLines.slice(0, 5).some(line => contentsTitle.test(line.text) || contentsRows && noisyContentsTitle.test(line.text));
    const isContents: boolean = heading || explicitContents.has(number) || continued && contentsRows;
    continued = isContents;
    if (isContents) printed.push(...rows);
    if (isContents || index) referenceRows.push(...rows);
  }
  function headingPage(title: string, after: number): number | undefined {
    const normalized = key(title);
    for (const [number, sourceLines] of pageLines) {
      if (number <= after) continue;
      if (sourceLines.slice(0, 6).some(line => key(line.text) === normalized)) return number;
    }
  }
  function printedPage(entry: PrintedEntry): number | undefined {
    const labeled = labelPages.get(entry.label.toLocaleLowerCase());
    if (labeled) return labeled;
    const matched = headingPage(entry.title, entry.source);
    if (matched) return matched;
    // Without page labels, a direct numeric reference is only a last resort.
    const numeric = /^\d+$/.test(entry.label) ? Number(entry.label) : 0;
    return !labels && numeric > entry.source && numeric <= document.numPages ? numeric : undefined;
  }
  const printedRoots: LocatedEntry[] = [], byPrinted = new Map<PrintedEntry, number>();
  for (const entry of referenceRows) {
    const page = printedPage(entry);
    if (!page || page === entry.source) continue;
    byPrinted.set(entry, page);
    pages.get(entry.source)!.links.push({ rect: entry.rect, href: pageHref(page) });
  }
  const uniquePrinted = new Set<string>();
  for (const entry of printed) {
    const page = byPrinted.get(entry);
    if (!page) continue;
    const identity = `${page}:${key(entry.title)}`;
    if (uniquePrinted.has(identity)) continue; uniquePrinted.add(identity);
    printedRoots.push({ title: entry.title, href: pageHref(page), children: [], page });
  }
  // A reliable printed contents title can be cleaner than an existing OCR
  // layer's decorative chapter header. Keep that chapter name visible at the
  // same destination instead of making the reader land on unreadable OCR noise.
  for (const chapter of printedRoots) {
    pages.get(chapter.page)!.chapter = chapter.title;
    const title = key(chapter.title);
    const opening = (pageLines.get(chapter.page) || []).slice(0, 12).map(line => key(line.text));
    // A title mentioned in a paragraph does not repair an unreadable OCR heading.
    // Allow short wrapped headings, but require the whole line group to match.
    const hasHeading = opening.some((_, index) => [1, 2, 3].some(count => opening.slice(index, index + count).join('') === title));
    if (title && !hasHeading) pages.get(chapter.page)!.heading = chapter.title;
  }
  // Fit-style bookmarks only identify a physical page. When their label is a
  // real heading, put the reader at that heading, rather than at the page's
  // running header or at an earlier section on the same page. Chapter bounds
  // prevent repeated labels such as "Part One" from matching another story.
  async function refine(entries: LocatedEntry[], start: number, end: number): Promise<void> {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      let ownerIndex = -1;
      for (let rootIndex = 0; rootIndex < printedRoots.length; rootIndex++) if (printedRoots[rootIndex].page <= entry.page) ownerIndex = rootIndex;
      const lower = Math.max(start, ownerIndex < 0 ? start : printedRoots[ownerIndex].page);
      const upper = Math.min(end, ownerIndex < 0 ? (printedRoots[0]?.page ?? end + 1) - 1 : (printedRoots[ownerIndex + 1]?.page ?? end + 1) - 1);
      if (entry.href.endsWith(`#pdf-page-${entry.page}`)) {
        const candidates: { page: number; line: SourceLine; score: number }[] = [];
        for (const [number, sourceLines] of pageLines) {
          if (number < lower || number > upper) continue;
          for (const line of sourceLines) if (key(line.text) === key(entry.title)) candidates.push({ page: number, line, score: Math.abs(number - entry.page) });
        }
        candidates.sort((a, b) => a.score - b.score || b.line.y - a.line.y);
        const best = candidates[0];
        if (best && !candidates.some(candidate => candidate !== best && candidate.score === best.score && candidate.page !== best.page)) {
          entry.page = best.page;
          entry.href = await destination([best.page - 1, { name: 'XYZ' }, best.line.x, best.line.y, null]) ?? entry.href;
        }
      }
      const nextPage = entries.slice(index + 1).find(next => next.page > entry.page)?.page;
      await refine(entry.children as LocatedEntry[], Math.max(lower, entry.page), Math.min(upper, nextPage ? nextPage - 1 : upper));
    }
  }
  await refine(locatedOutline, 1, document.numPages);
  let chapters: LocatedEntry[], origin: PdfNavigation['origin'];
  if (printedRoots.length >= 2) {
    origin = 'printed';
    // Printed chapter names are authoritative when the PDF's bookmark list is
    // incomplete. Keep supplementary bookmarks under the chapter they belong to.
    chapters = [...printedRoots];
    const mergeChildren = (target: NavigationEntry[], incoming: NavigationEntry[]) => {
      for (const child of incoming) {
        const existing = target.find(entry => key(entry.title) === key(child.title) && entry.href === child.href);
        if (existing) mergeChildren(existing.children, child.children);
        else target.push(child);
      }
    };
    for (const entry of locatedOutline) {
      const printedRoot = printedRoots.find(root => root.page === entry.page);
      if (printedRoot) { mergeChildren(printedRoot.children, entry.children); continue; }
      const owner = [...printedRoots].reverse().find(root => root.page <= entry.page);
      const backMatter = /^(?:about\s+.+|copyright|acknowledg(?:e)?ments|bibliography|index)$/i.test(entry.title);
      if (!owner || backMatter) chapters.push(entry);
      else owner.children.push(entry);
    }
    chapters.sort((a, b) => a.page - b.page);
  } else if (locatedOutline.length && !densePageBookmarks) { chapters = locatedOutline; origin = 'outline'; }
  else {
    origin = 'headings';
    const headings: LocatedEntry[] = [], used = new Set<string>();
    for (const [number, sourceLines] of pageLines) {
      const heights = texts.get(number)!.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim()).map(item => item.height).sort((a, b) => a - b);
      const normal = heights[Math.floor(heights.length / 2)] || 12;
      const heading = sourceLines.slice(0, 5).find(line => line.text.length >= 3 && line.text.length <= 140 && !/^\d+$/.test(line.text) && !/^https?:/i.test(line.text) && (line.height > normal * 1.25 || /^(?:chapter|part|section|cap[ií]tulo|chapitre|kapitel|secci[oó]n|se[cç][aã]o|глава|часть|الفصل)\s+\S|^第.{1,12}[章部節回卷篇]|^제\s*[\p{Number}\p{Script=Han}]+\s*[장부절편]|^(?:บทที่|ตอนที่)\s*\p{Number}/iu.test(line.text)));
      if (heading && !used.has(key(heading.text))) { headings.push({ title: heading.text, href: pageHref(number), children: [], page: number }); used.add(key(heading.text)); }
    }
    if (!headings.length) {
      const first = [...pageLines].flatMap(([page, sourceLines]) => sourceLines.filter(line => line.text.length >= 3 && line.text.length <= 140 && !/^\d+$/.test(line.text)).map(line => ({ page, title: line.text })))[0];
      headings.push({ title: first?.title || 'Beginning', href: pageHref(first?.page || 1), children: [], page: first?.page || 1 });
    }
    chapters = [...locatedOutline, ...headings.filter(heading => !locatedOutline.some(entry => entry.page === heading.page))].sort((a, b) => a.page - b.page);
  }
  function titles(entries: LocatedEntry[]) { for (const entry of entries) { const page = pages.get(entry.page); if (page && !page.title) page.title = entry.title; titles(entry.children as LocatedEntry[]); } }
  titles(chapters);
  return { chapters, origin, labels, page: number => pages.get(number) ?? { links: [], targets: [] }, text: number => texts.get(number) };
}
