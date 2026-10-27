import type { TextItem } from 'pdfjs-dist/types/src/display/api';

const XHTML = 'http://www.w3.org/1999/xhtml';
const key = (text: string) => text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
interface PageText { number: number; items: TextItem[]; view: number[]; scanned: boolean }
interface MarginLine { items: TextItem[]; text: string; band: 'top' | 'bottom' }
const height = (item: TextItem) => Math.abs(item.height) || Math.hypot(item.transform[0], item.transform[1]) || 12;

function marginLines(page: PageText): MarginLine[] {
  const bottom = Math.min(page.view[1], page.view[3]), top = Math.max(page.view[1], page.view[3]), extent = top - bottom;
  const candidates = page.items.filter(item => item.str.trim() && (item.transform[5] > top - extent * .09 || item.transform[5] + height(item) < bottom + extent * .07));
  const groups: TextItem[][] = [];
  for (const item of candidates.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const previous = groups.at(-1);
    if (previous && Math.abs(previous[0].transform[5] - item.transform[5]) < Math.max(height(previous[0]), height(item)) * .35) previous.push(item);
    else groups.push([item]);
  }
  return groups.map(items => ({ items, text: items.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join(' ').replace(/\s+/g, ' ').trim(), band: items[0].transform[5] > bottom + extent / 2 ? 'top' : 'bottom' }));
}

/** Repeated marginal furniture is safe to discard once chapter navigation has been established independently. */
export function repeatedFurniture(pages: PageText[]): Map<number, Set<TextItem>> {
  const observations = new Map<string, Set<number>>(), lines = new Map<number, MarginLine[]>();
  const signature = (line: MarginLine) => {
    const capitals = line.text.match(/\p{Lu}(?:[\p{Lu}\s'’.-]){5,}/gu)?.sort((a, b) => b.length - a.length)[0];
    const text = capitals && key(capitals).length >= key(line.text).length * .6 ? capitals : line.text;
    return `${line.band}:${key(text).replace(/\d+/g, '#')}`;
  };
  for (const page of pages) {
    if (!page.scanned) continue;
    const marginal = marginLines(page); lines.set(page.number, marginal);
    for (const line of marginal) {
      if (line.text.length > 100 || key(line.text).length < 3) continue;
      const id = signature(line); if (!observations.has(id)) observations.set(id, new Set());
      observations.get(id)!.add(page.number);
    }
  }
  const result = new Map<number, Set<TextItem>>();
  const supported = new Map<string, boolean>();
  const isRepeated = (id: string) => {
    if (supported.has(id)) return supported.get(id)!;
    const [band, text] = id.split(':');
    const seen = new Set(observations.get(id));
    if (text.length >= 7 && seen.size < 3) for (const [other, numbers] of observations) {
      const [otherBand, otherText] = other.split(':');
      if (otherBand !== band || Math.min(text.length, otherText.length) < 7) continue;
      const maximum = Math.max(text.length, otherText.length), minimum = Math.min(text.length, otherText.length);
      if ((text.includes(otherText) || otherText.includes(text)) && minimum / maximum >= .66 ||
        Math.abs(text.length - otherText.length) <= maximum * .24 && distance(text, otherText) / maximum <= .24) numbers.forEach(number => seen.add(number));
      if (seen.size >= 3) break;
    }
    const value = seen.size >= 3; supported.set(id, value); return value;
  };
  for (const page of pages) {
    const removed = new Set<TextItem>();
    const bodyWords = page.items.filter(item => key(item.str).length >= 3 && item.transform[5] > Math.min(page.view[1], page.view[3]) + Math.abs(page.view[3] - page.view[1]) * .07);
    const bodyHeights = bodyWords.map(height).sort((a, b) => a - b);
    const normal = bodyHeights[Math.floor(bodyHeights.length / 2)] || 0;
    const bottom = Math.min(page.view[1], page.view[3]), extent = Math.abs(page.view[3] - page.view[1]);
    for (const line of lines.get(page.number) || []) {
      const pageNumber = /^[\p{P}\p{S}\s]*\d{1,5}[\p{P}\p{S}\s]*$/u.test(line.text);
      // Old searchable scans often read a tiny ornamented page number as
      // letters. Its consistent footer position and size are stronger evidence
      // than the OCR's guessed characters; readable footnotes remain intact.
      const tinyCounter = line.band === 'bottom' && bodyWords.length >= 20 && line.text.length <= 28 &&
        (line.text.match(/\p{L}/gu)?.length || 0) <= 10 && line.items.every(item =>
          item.transform[5] + height(item) <= bottom + extent * .04 && height(item) <= normal * .8);
      if (pageNumber || tinyCounter || isRepeated(signature(line))) line.items.forEach(item => removed.add(item));
    }
    result.set(page.number, removed);
  }
  return result;
}

/** An isolated crop-edge OCR mark is not part of a consistently inset prose column. */
export function readingItems(items: TextItem[], view: number[], scanned: boolean, furniture = new Set<TextItem>()): TextItem[] {
  if (!scanned) return items;
  const words = items.filter(item => key(item.str).length >= 3 && item.width > 0);
  if (words.length < 20) return items.filter(item => !furniture.has(item));
  const starts = words.map(item => item.transform[4]).sort((a, b) => a - b);
  const ends = words.map(item => item.transform[4] + item.width).sort((a, b) => a - b);
  const left = starts[Math.floor(starts.length * .05)], right = ends[Math.floor(ends.length * .95)];
  const normal = words.map(height).sort((a, b) => a - b)[Math.floor(words.length / 2)];
  const tolerance = Math.max(normal * 1.5, Math.abs(view[2] - view[0]) * .04);
  return items.filter(item => !furniture.has(item) && !(item.str.trim() && key(item.str).length <= 2 &&
    (item.transform[4] + item.width < left - tolerance || item.transform[4] > right + tolerance)));
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = next;
  }
  return previous[b.length];
}

/** Replace a matching source display heading with one readable, authoritative contents title. */
export function chapterHeading(content: string, title: string): string {
  const doc = new DOMParser().parseFromString(`<body xmlns="${XHTML}">${content}</body>`, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) throw new Error('conversionFailed');
  const body = doc.documentElement, blocks = Array.from(body.children).filter(element => /^(?:p|h[1-6])$/i.test(element.localName)).slice(0, 6);
  const normalized = key(title);
  const matches = (text: string, displayHeading: boolean) => {
    const value = key(text);
    return value === normalized || Math.min(value.length, normalized.length) >= 8 &&
      Math.abs(value.length - normalized.length) <= normalized.length * .3 && distance(value, normalized) / Math.max(value.length, normalized.length) <= (displayHeading ? .35 : .2);
  };
  let first = -1, count = 0;
  for (let index = 0; index < blocks.length && first < 0; index++) for (let length = 1; length <= 3 && index + length <= blocks.length; length++) {
    const selected = blocks.slice(index, index + length);
    if (selected.some(block => block.querySelector('a[href],img,ruby')) || selected.some(block => (block.textContent || '').length > title.length * 1.5 + 20)) continue;
    const text = selected.map(block => block.textContent || '').join(' '), letters = text.match(/\p{L}/gu)?.length || 0;
    const displayHeading = selected.every(block => /^h[1-6]$/i.test(block.localName)) || letters > 3 && (text.match(/\p{Lu}/gu)?.length || 0) >= letters * .7;
    if (matches(text, displayHeading)) { first = index; count = length; break; }
  }
  const removing = new Set<Element>();
  if (first >= 0) {
    blocks.slice(first, first + count).forEach(block => removing.add(block));
    for (const block of blocks.slice(0, first)) {
      const text = (block.textContent || '').trim(), letters = text.match(/\p{L}/gu) || [], capitals = text.match(/\p{Lu}/gu) || [];
      const label = /^(?:chapter|part|cap[ií]tulo|chapitre|kapitel|глава|第.{1,10}[章部節回]|제.{1,10}[장부절]|บทที่)\b/iu.test(text);
      const noisy = (text.match(/[=:*+]/g)?.length || 0) >= 2;
      if (!block.querySelector('a[href],img,ruby') && text.length <= 80 && (label || noisy || letters.length > 3 && capitals.length >= letters.length * .8)) removing.add(block);
    }
  }
  const anchors: Element[] = [];
  for (const block of removing) {
    for (const element of [block, ...Array.from(block.querySelectorAll('[id]'))]) if (element.id) {
      const anchor = doc.createElementNS(XHTML, 'span'); anchor.id = element.id; anchors.push(anchor);
    }
    block.remove();
  }
  const heading = doc.createElementNS(XHTML, 'h2'); heading.textContent = title;
  body.prepend(...anchors, heading);
  const serializer = new XMLSerializer();
  return Array.from(body.childNodes).map(node => serializer.serializeToString(node)).join('');
}
