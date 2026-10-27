// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { chapterHeading, readingItems, repeatedFurniture } from '../src/pdf-reading';
const item = (str: string, x: number, y: number): TextItem => ({ str, transform: [12, 0, 0, 12, x, y], width: str.length * 5, height: 12, dir: 'ltr', fontName: 'scan', hasEOL: true });
const parse = (content: string) => new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">${content}</body>`, 'application/xhtml+xml');

it('removes repeated marginal scan headers and page numbers while retaining prose and ordinary digital text', () => {
  const pages = [1, 2, 3].map(number => ({ number, scanned: true, view: [0, 0, 400, 600], items: [item('SAME RUNNING HEADER', 70, 570), item('Real prose body', 40, 400), item(`* ${number} *`, 190, 10)] }));
  const result = repeatedFurniture([...pages, { number: 4, scanned: false, view: [0, 0, 400, 600], items: [item('SAME RUNNING HEADER', 70, 570)] }]);
  for (const page of pages) expect(readingItems(page.items, page.view, true, result.get(page.number)).map(item => item.str)).toEqual(['Real prose body']);
  expect(result.get(4)?.size).toBe(0);
});

it('recognizes a repeated marginal header despite OCR errors in its decorative sides', () => {
  const pages = ['ye CHAPTER ONE eg', 'oe CHAPTER ONE 1', 'CHAPTER ONE', 'CHAPTER 0NE'].map((title, index) => ({ number: index + 1, scanned: true, view: [0, 0, 400, 600], items: [item(title, 40, 570), item('Actual prose.', 40, 450)] }));
  const result = repeatedFurniture(pages);
  for (const page of pages) expect(readingItems(page.items, page.view, true, result.get(page.number)).map(item => item.str)).toEqual(['Actual prose.']);
});

it.each(['x* Q *¥', '* DO *', '* bi x', '* Dg »', '* BB x ed'])('removes a tiny scanned page counter misrecognized as %s while keeping readable footnotes', counter => {
  const body = Array.from({ length: 24 }, (_, index) => item(`word${index}`, 40 + index % 5 * 45, 500 - Math.floor(index / 5) * 20));
  const footer = { ...item(counter, 150, 8), height: 6, transform: [6, 0, 0, 6, 150, 8] };
  const note = { ...item('See the complete explanation in the appendix.', 40, 24), height: 8, transform: [8, 0, 0, 8, 40, 24] };
  const page = { number: 1, scanned: true, view: [0, 0, 400, 600], items: [...body, note, footer] };
  const removed = repeatedFurniture([page]).get(1)!;
  expect(removed.has(footer)).toBe(true); expect(removed.has(note)).toBe(false);
});

it('ignores isolated border marks without deleting a dropcap or punctuation inside the real prose column', () => {
  const words = Array.from({ length: 30 }, (_, index) => item(`word${index}`, 40 + index % 5 * 45, 500 - Math.floor(index / 5) * 20));
  const cap = item('M', 40, 500), punctuation = item('!', 170, 440), noise = item('a', 0, 350);
  expect(readingItems([...words, cap, punctuation, noise], [0, 0, 400, 600], true)).toEqual([...words, cap, punctuation]);
  expect(readingItems([...words, noise], [0, 0, 400, 600], false)).toContain(noise);
});

it('replaces an OCR display heading and chapter label with one canonical title, preserving every destination ID', () => {
  const content = '<p id="chapter-label">CHAPTER ONE</p><h2><span id="source-heading">THE BOY WHO IIVED</span></h2><p>Ordinary chapter prose remains intact.</p>';
  const doc = parse(chapterHeading(content, 'The Boy Who Lived'));
  expect(Array.from(doc.querySelectorAll('h2')).map(node => node.textContent)).toEqual(['The Boy Who Lived']);
  expect(Array.from(doc.querySelectorAll('p')).map(node => node.textContent)).toEqual(['Ordinary chapter prose remains intact.']);
  expect(doc.getElementById('chapter-label')).not.toBeNull(); expect(doc.getElementById('source-heading')).not.toBeNull();
  expect(doc.querySelector('parsererror')).toBeNull();
});

it('replaces a badly read uppercase display title without printing it beneath the canonical heading', () => {
  const doc = parse(chapterHeading('<h2>THY kPEDER OF TET KEYS</h2><p>The ordinary narrative begins here.</p>', 'The Keeper of the Keys'));
  expect(Array.from(doc.querySelectorAll('h2')).map(node => node.textContent)).toEqual(['The Keeper of the Keys']);
  expect(doc.body?.textContent || doc.documentElement.textContent).not.toContain('kPEDER');
});

it('preserves an epigraph, links and ruby when introducing a canonical chapter title', () => {
  const content = '<p>A short epigraph.</p><p><a href="page-2.xhtml#back">CHAPTER ONE</a></p><p><ruby>漢字<rt>かんじ</rt></ruby></p><p>The following prose mentions The Boy Who Lived.</p>';
  const doc = parse(chapterHeading(content, 'The Boy Who Lived'));
  expect(doc.querySelectorAll('h2')).toHaveLength(1); expect(doc.querySelectorAll('p')).toHaveLength(4);
  expect(doc.querySelector('a')?.getAttribute('href')).toBe('page-2.xhtml#back'); expect(doc.querySelector('rt')?.textContent).toBe('かんじ');
});
