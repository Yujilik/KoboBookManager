import type JSZip from 'jszip';
import type { NavigationEntry } from './pdf-navigation';

interface Page { number: number; path: string; doc: Document; blocks: Element[]; text: string; length: number }
interface Marker { kind: string; number: number; label: string }
interface Section { marker: Marker; page: Page; queries: string[] }
const XHTML = 'http://www.w3.org/1999/xhtml';
const clean = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (value: string) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const number = (value: string) => /^\d+$/.test(value) ? Number(value) : '一二三四五六七八九十'.indexOf(value) + 1;

function markers(text: string, language: string): Marker[] {
  const value = clean(text).replace(/\s/g, ''), result: Marker[] = [];
  for (const match of value.matchAll(/第[-—]*(\d{1,2}|[一二三四五六七八九十])[\p{Script=Hiragana}]{0,4}(週|周|章|部|課)/gu)) {
    const n = number(match[1]), unit = match[2], kind = /週|周/.test(unit) ? 'week' : unit;
    if (n > 0 && n <= 32) result.push({ kind, number: n, label: `第${n}${kind === 'week' && language.startsWith('ja') ? '週' : unit}` });
  }
  for (const match of clean(text).matchAll(/\b(week|chapter|part|semana|cap[ií]tulo)\s+(\d{1,2})\b/giu)) {
    const n = Number(match[2]), kind = /week|semana/i.test(match[1]) ? 'week' : match[1].toLowerCase();
    if (n > 0 && n <= 32) result.push({ kind, number: n, label: `${match[1]} ${n}` });
  }
  for (const match of value.matchAll(/제?(\d{1,2})(주|장|과)/gu)) {
    const n = Number(match[1]);
    if (n > 0 && n <= 32) result.push({ kind: match[2] === '주' ? 'week' : match[2], number: n, label: `제${n}${match[2]}` });
  }
  return result;
}

function candidates(page: Page): string[] {
  return page.blocks.map(block => clean(block.textContent || '')).filter(text => {
    const letters = text.match(/\p{L}/gu)?.length || 0;
    return text.length >= 8 && text.length <= 180 && letters >= 6 && !/^https?:/i.test(text);
  });
}
function similarity(a: string, b: string): number {
  const x = key(a), y = key(b);
  if (Math.min(x.length, y.length) < 8) return 0;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) >= 12 ? .98 : .8;
  const grams = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)));
  const source = grams(x); let best = 0;
  const width = Math.max(8, Math.ceil(x.length * 1.3)), step = Math.max(1, Math.floor(x.length / 6));
  for (let offset = 0; offset < y.length; offset += step) {
    const target = grams(y.slice(offset, offset + width));
    const shared = [...source].filter(gram => target.has(gram)).length;
    best = Math.max(best, 2 * shared / (source.size + target.size || 1));
  }
  return best;
}

/** Recover sparse OCR chapter-title pages from repeated numbered running headers.
 * Caller restricts this to OCR books whose existing navigation is only inferred headings. */
export async function improveOcrNavigation(zip: JSZip, bookLanguage?: string): Promise<{ chapters: NavigationEntry[]; linksAdded: number } | undefined> {
  const packageFile = zip.file(/\.opf$/)[0];
  const packageDirectory = packageFile?.name.includes('/') ? packageFile.name.slice(0, packageFile.name.lastIndexOf('/')) : 'OEBPS';
  // Facsimile supplements can have the same page basename. They are separate,
  // non-linear documents and must never participate in reading-order inference.
  const pageFiles = Object.keys(zip.files).filter(path => path.startsWith(packageDirectory + '/') && /^page-\d+\.xhtml$/.test(path.slice(packageDirectory.length + 1)));
  const pages: Page[] = [];
  for (const path of pageFiles) {
    const doc = new DOMParser().parseFromString(await zip.file(path)!.async('string'), 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) return;
    const clone = doc.querySelector('body')?.cloneNode(true) as Element | undefined;
    clone?.querySelectorAll('rt,rp').forEach(node => node.remove());
    const blockText = clone ? Array.from(clone.querySelectorAll('p,h1,h2,h3,h4')).map(block => block.textContent || '').join(' ') : '';
    const text = clean(blockText || clone?.textContent || '');
    pages.push({ number: Number(path.match(/page-(\d+)/)![1]), path, doc, blocks: Array.from(doc.querySelectorAll('body p,body h1,body h2,body h3,body h4')), text, length: key(text).length });
  }
  pages.sort((a, b) => a.number - b.number);
  if (pages.length < 8) return;
  const packageDocument = packageFile ? new DOMParser().parseFromString(await packageFile.async('string'), 'application/xml') : undefined;
  const language = bookLanguage || packageDocument?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')[0]?.textContent || pages.find(page => page.doc.documentElement.getAttribute('lang'))?.doc.documentElement.getAttribute('lang') || '';
  const observations = new Map<string, Map<number, { marker: Marker; pages: number[] }>>();
  for (const page of pages) for (const marker of markers(page.text, language)) {
    // A page mentioning several numbers in the same series is an overview or
    // contents page, not evidence that all those sections start there.
    if (new Set(markers(page.text, language).filter(candidate => candidate.kind === marker.kind).map(candidate => candidate.number)).size > 1) continue;
    if (!observations.has(marker.kind)) observations.set(marker.kind, new Map());
    const series = observations.get(marker.kind)!;
    if (!series.has(marker.number)) series.set(marker.number, { marker, pages: [] });
    const seen = series.get(marker.number)!.pages;
    if (seen.at(-1) !== page.number) seen.push(page.number);
  }
  const allSeries = [...observations.values()].map(series => [...series.values()].filter(entry => entry.pages.length >= 2).sort((a, b) => a.marker.number - b.marker.number)).filter(series => series.length >= 3 && series.every((entry, i) => !i || entry.marker.number === series[i - 1].marker.number + 1));
  allSeries.sort((a, b) => b.length - a.length);
  const series = allSeries[0];
  if (!series) return;
  const maximumGap = Math.max(5, Math.ceil(pages.length / series.length));
  const clusters = series.map(entry => {
    const groups: number[][] = [];
    for (const page of entry.pages) { if (!groups.length || page - groups.at(-1)!.at(-1)! > maximumGap) groups.push([]); groups.at(-1)!.push(page); }
    groups.sort((a, b) => b.length - a.length);
    return { marker: entry.marker, pages: groups[0] };
  });
  if (clusters.some(entry => entry.pages.length < 2) || clusters.some((entry, i) => i && entry.pages[0] <= clusters[i - 1].pages.at(-1)!)) return;
  const lengths = pages.map(page => page.length).filter(length => length > 20).sort((a, b) => a - b);
  const sparseLimit = Math.min(350, Math.max(100, lengths[Math.floor(lengths.length / 2)] * .4));
  const sections: Section[] = [];
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index], lower = Math.max(index ? clusters[index - 1].pages.at(-1)! + 1 : 1, cluster.pages[0] - Math.min(10, Math.ceil(maximumGap / 2)));
    const sparse = pages.filter(page => page.number >= lower && page.number <= cluster.pages[0] && (page.length >= 15 || markers(page.text, language).some(marker => marker.kind === cluster.marker.kind && marker.number === cluster.marker.number)) && page.length <= sparseLimit && new Set(markers(page.text, language).filter(marker => marker.kind === cluster.marker.kind).map(marker => marker.number)).size <= 1);
    const cover = sparse.at(-1);
    if (!cover || sections.some(section => section.page.number === cover.number)) return;
    sections.push({ marker: cluster.marker, page: cover, queries: candidates(cover) });
  }
  const first = sections[0].page.number;
  const preface = pages.filter(page => page.number < first).flatMap(page => page.blocks.filter(block => !block.querySelector('a')).map(block => ({ page, block, text: clean(block.textContent || '') }))).filter(entry => entry.text.length >= 6);
  // Match the ordered contents rows to the independently established numbered
  // sections. Order disambiguates repeated translated titles in workbook series.
  const scores = sections.map(section => preface.map(entry => {
    const explicit = markers(entry.text, language).filter(marker => marker.kind === section.marker.kind);
    if (explicit.length) return explicit.some(marker => marker.number === section.marker.number) ? 1 : 0;
    return Math.max(0, ...section.queries.map(query => similarity(query, entry.text)));
  }));
  const memo = new Map<string, { score: number; indices: number[] }>();
  function choose(section: number, after: number): { score: number; indices: number[] } {
    if (section === sections.length) return { score: 0, indices: [] };
    const identity = `${section}:${after}`; if (memo.has(identity)) return memo.get(identity)!;
    let best = { score: -Infinity, indices: [] as number[] };
    for (let i = after; i < preface.length; i++) {
      if (scores[section][i] < .45) continue;
      const next = choose(section + 1, i + 1), score = scores[section][i] + next.score;
      if (score > best.score) best = { score, indices: [i, ...next.indices] };
    }
    memo.set(identity, best); return best;
  }
  const matched = choose(0, 0);
  const chapters: NavigationEntry[] = [];
  let linksAdded = 0;
  const navFile = zip.file(/(?:^|\/)nav\.xhtml$/)[0];
  if (navFile) {
    const nav = new DOMParser().parseFromString(await navFile.async('string'), 'application/xhtml+xml');
    for (const anchor of Array.from(nav.querySelectorAll('nav[epub\\:type="toc"] a'))) {
      const title = clean(anchor.textContent || ''), href = anchor.getAttribute('href') || '', target = Number(href.match(/page-(\d+)/)?.[1]);
      if (target < first && /^(?:cover(?: page)?|title(?: page)?|copyright|preface|introduction|封面|书名|版权|表紙|扉|著作権|はじめに)$/iu.test(title.replace(/\s/g, ''))) chapters.push({ title, href, children: [] });
    }
  }
  for (const [index, section] of sections.entries()) {
    const href = `page-${section.page.number}.xhtml#pdf-page-${section.page.number}`;
    const title = section.marker.kind === 'week' ? language.startsWith('ja') ? `第${section.marker.number}週` : language.startsWith('zh') ? `第${section.marker.number}周` : language.startsWith('ko') ? `제${section.marker.number}주` : section.marker.label : section.marker.label;
    const id = `pdf-ocr-chapter-${section.marker.kind}-${section.marker.number}`;
    if (!section.page.doc.getElementById(id)) {
      const heading = section.page.doc.createElementNS(XHTML, 'h2'); heading.id = id; heading.textContent = title;
      section.page.doc.querySelector('body')!.prepend(heading);
    }
    chapters.push({ title, href, children: [] });
    if (matched.indices.length === sections.length) {
      const entry = preface[matched.indices[index]], anchor = entry.page.doc.createElementNS(XHTML, 'a');
      anchor.setAttribute('href', href);
      while (entry.block.firstChild) anchor.append(entry.block.firstChild);
      entry.block.append(anchor); linksAdded++;
    }
  }
  for (const page of pages) zip.file(page.path, new XMLSerializer().serializeToString(page.doc));
  return { chapters, linksAdded };
}
