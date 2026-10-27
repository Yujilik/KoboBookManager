// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { buildPdfNavigation, pdfLinkUrl } from '../src/pdf-navigation';

const item = (str: string, x = 20, y = 700, height = 12): TextItem => ({ str, dir: 'ltr', width: str.length * height * .5, height, transform: [height, 0, 0, height, x, y], fontName: 'test', hasEOL: true });
const content = (items: TextItem[]): TextContent => ({ items, styles: {}, lang: null });
const outline = (title: string, dest: unknown, items: Record<string, unknown>[] = []): Record<string, unknown> => ({ title, dest, items, bold: false, italic: false, color: new Uint8ClampedArray(3), url: null });
function documentFixture(pageItems: TextItem[][], options: { labels?: string[] | null; outline?: Record<string, unknown>[]; named?: Record<string, unknown>; refs?: Record<string, number>; annotations?: Record<string, unknown>[][] } = {}) {
  const extracted = pageItems.map(items => content(items));
  const calls = pageItems.map((_, index) => ({ getTextContent: vi.fn(async () => extracted[index]), getAnnotations: vi.fn(async () => options.annotations?.[index] ?? []) }));
  const source = { numPages: pageItems.length, getOutline: vi.fn(async () => options.outline ?? null), getPageLabels: vi.fn(async () => options.labels ?? null), getPage: vi.fn(async (number: number) => calls[number - 1]), getDestination: vi.fn(async (name: string) => options.named?.[name] ?? null), getPageIndex: vi.fn(async (ref: { num: number }) => options.refs?.[ref.num] ?? -1) };
  return { document: source as unknown as PDFDocumentProxy, source, calls, extracted };
}

it('reconstructs a printed contents page against PDF labels rather than treating printed page numbers as physical pages', async () => {
  const fixture = documentFixture([[], [item('Contents', 20, 760, 20), item('First Chapter', 20, 700), item('1', 230, 700), item('Second Chapter', 20, 675), item('3', 230, 675)], [item('First Chapter')], [item('Body')], [item('Second Chapter')]], { labels: ['Cover', 'i', '1', '2', '3'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(({ title, href }) => ({ title, href }))).toEqual([{ title: 'First Chapter', href: 'page-3.xhtml#pdf-page-3' }, { title: 'Second Chapter', href: 'page-5.xhtml#pdf-page-5' }]);
  expect(result.page(2).links.map(link => link.href)).toEqual(['page-3.xhtml#pdf-page-3', 'page-5.xhtml#pdf-page-5']);
  expect(result.page(2).links[0].rect).toEqual([20, 697, 236, 712]);
  expect(result.text(3)).toBe(fixture.extracted[2]);
  for (const page of fixture.calls) expect(page.getTextContent).toHaveBeenCalledOnce();
});

it('finds the printed front-matter offset from chapter headings when the PDF has no page labels', async () => {
  const fixture = documentFixture([[], [item('Table of Contents'), item('Chapter One 1', 20, 650), item('Chapter Two 3', 20, 620)], [], [item('Chapter One')], [item('Continuation')], [item('Chapter Two')]]);
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(2).links.map(link => link.href)).toEqual(['page-4.xhtml#pdf-page-4', 'page-6.xhtml#pdf-page-6']);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['Chapter One', 'Chapter Two']);
});

it('keeps reliable printed chapter names visible when the existing OCR header is corrupt', async () => {
  const fixture = documentFixture([[item('Contents'), item('First Chapter 2', 20, 650), item('Second Chapter 3', 20, 620)], [item('C H A P T ER 0Nf'), item('First Chaptcr', 20, 650)], [item('Second Chapter')]], { labels: ['1', '2', '3'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(2).heading).toBe('First Chapter');
  expect(result.page(3).heading).toBeUndefined();
});

it('does not mistake a title mentioned in body text for a legible chapter heading', async () => {
  const fixture = documentFixture([[item('Contents'), item('First Chapter 2', 20, 650), item('Second Chapter 3', 20, 620)], [item('FlRST CHAPTFR'), item('This paragraph mentions First Chapter in the middle of the prose.', 20, 650)], [item('Second', 20, 700), item('Chapter', 20, 680)]], { labels: ['1', '2', '3'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(2).heading).toBe('First Chapter');
  expect(result.page(3).heading).toBeUndefined();
});

it('uses chapter headings instead of treating a dense numeric page bookmark list as chapters', async () => {
  const pages = Array.from({ length: 24 }, (_, i) => [item(i === 3 ? '第1章' : i === 15 ? '第2章' : 'Ordinary body text'), item('Continuation', 20, 650)]);
  const fixture = documentFixture(pages, { labels: pages.map((_, i) => String(i + 1)), outline: pages.map((_, i) => outline(String(i + 1), [i, { name: 'Fit' }])) });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['第1章', '第2章']);
});

it('recognises multilingual contents headings and Roman numeral page labels', async () => {
  const fixture = documentFixture([[item('目次'), item('序文 iv', 20, 650), item('第一章 1', 20, 620)], [item('序文')], [item('第一章')]], { labels: ['iii', 'iv', '1'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(1).links.map(link => link.href)).toEqual(['page-2.xhtml#pdf-page-2', 'page-3.xhtml#pdf-page-3']);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['序文', '第一章']);
});

it('resolves prefixed appendix page labels without turning them into physical page numbers', async () => {
  const fixture = documentFixture([[item('Contents'), item('Appendix A A-1', 20, 650), item('Appendix B B-3', 20, 620)], [], [item('Appendix A')], [item('Appendix B')]], { labels: ['Cover', 'ii', 'A-1', 'B-3'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(1).links.map(link => link.href)).toEqual(['page-3.xhtml#pdf-page-3', 'page-4.xhtml#pdf-page-4']);
});

it('does not mistake audio track numbers for printed book page references', async () => {
  const fixture = documentFixture([[item('AUDIO TRACK LIST'), item('First recording 1', 20, 650), item('Second recording 2', 20, 620)], [item('Ordinary reading text')]], { labels: ['1', '2'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(1).links).toEqual([]);
});

it.each(['Capítulo 1', '제1장', 'บทที่ ๑', '第一回'])('uses a same-size %s chapter heading instead of requiring English or larger typography', async title => {
  const fixture = documentFixture([[item(title), item('Body text', 20, 650), item('More body text', 20, 620)], [item('Continuation')]]);
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual([title]);
});

it('preserves outline hierarchy and resolves named, reference, zero-index and coordinate destinations', async () => {
  const fixture = documentFixture([[item('Front matter')], [item('Section One')], [item('Second Section')]], { outline: [outline('Named Chapter', 'chapter', [outline('Section', [2, { name: 'XYZ' }, 40, 300, null])])], named: { chapter: [{ num: 42, gen: 0 }, { name: 'Fit' }] }, refs: { 42: 1 } });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters[0]).toMatchObject({ title: 'Named Chapter', href: 'page-2.xhtml#pdf-page-2' });
  const child = result.chapters[0].children[0];
  expect(child.title).toBe('Section');
  expect(child.href).toMatch(/^page-3\.xhtml#pdf-destination-\d+$/);
  expect(result.page(3).targets).toEqual([{ id: child.href.split('#')[1], x: 40, y: 300 }]);
});

it('keeps the outline children when a printed chapter replaces an incomplete or differently worded bookmark title', async () => {
  const fixture = documentFixture([[item('Contents'), item('First Chapter 2', 20, 650), item('Second Chapter 4', 20, 620)], [item('First Chapter')], [item('Subsection')], [item('Second Chapter')]], { labels: ['1', '2', '3', '4'], outline: [outline('Alternate title', [1, { name: 'Fit' }], [outline('Subsection', [2, { name: 'Fit' }])])] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters[0].title).toBe('First Chapter');
  expect(result.chapters[0].children.map(child => child.title)).toEqual(['Subsection']);
  const href = result.chapters[0].children[0].href;
  expect(href).toMatch(/^page-3\.xhtml#pdf-destination-/);
  expect(result.page(3).targets.some(target => href.endsWith('#' + target.id))).toBe(true);
});

it('retargets repeated section labels only within their chapter and anchors a heading in the middle of the source page', async () => {
  const fixture = documentFixture([[item('Contents'), item('First Chapter 2', 20, 650), item('Second Chapter 5', 20, 620)], [item('First Chapter')], [item('Running text', 20, 700), item('PART ONE', 20, 400)], [item('More text')], [item('Second Chapter')], [item('Running text', 20, 700), item('PART ONE', 30, 350)]], { labels: ['1', '2', '3', '4', '5', '6'], outline: [outline('First Chapter', [1, { name: 'Fit' }], [outline('PART ONE', [3, { name: 'Fit' }])]), outline('Second Chapter', [4, { name: 'Fit' }], [outline('PART ONE', [5, { name: 'Fit' }])])] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters[0].children[0].href).toMatch(/^page-3\.xhtml#pdf-destination-/);
  expect(result.chapters[1].children[0].href).toMatch(/^page-6\.xhtml#pdf-destination-/);
  expect(result.page(3).targets).toContainEqual(expect.objectContaining({ x: 20, y: 400 }));
  expect(result.page(6).targets).toContainEqual(expect.objectContaining({ x: 30, y: 350 }));
});

it('rebuilds internal and public URI annotations while refusing executable or local-file actions', async () => {
  const fixture = documentFixture([[item('A chapter')], [item('Destination')]], { named: { spot: [1, { name: 'XYZ' }, 25, 240, null] }, annotations: [[
    { subtype: 'Link', dest: 'spot', rect: [100, 720, 20, 700] },
    { subtype: 'Link', dest: 'spot', rect: [20, 660, 100, 680] },
    { subtype: 'Link', url: 'https://example.org/book?q=a&b=c', rect: [20, 620, 100, 640] },
    { subtype: 'Link', url: 'mailto:reader@example.org', rect: [20, 580, 100, 600] },
    { subtype: 'Link', url: 'javascript:alert(1)', rect: [20, 540, 100, 560] },
    { subtype: 'Link', url: 'file:///private/book.pdf', rect: [20, 500, 100, 520] },
    { subtype: 'Link', action: 'NextPage', rect: [20, 460, 100, 480] },
  ], []] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.page(1).links).toHaveLength(5);
  expect(result.page(1).links[0].rect).toEqual([20, 700, 100, 720]);
  expect(result.page(1).links[0].href).toBe(result.page(1).links[1].href);
  expect(result.page(2).targets).toHaveLength(1);
  expect(result.page(1).links.map(link => link.href)).toEqual(expect.arrayContaining(['https://example.org/book?q=a&b=c', 'mailto:reader@example.org', 'page-2.xhtml#pdf-page-2']));
});

it('ignores missing or out-of-range destinations and uses a meaningful fallback rather than one chapter per physical page', async () => {
  const fixture = documentFixture([[item('A real title', 20, 700, 24), item('First body line', 20, 660), item('Second body line', 20, 640)], [item('Continuation')]], { outline: [outline('Missing', 'absent'), outline('Invalid page', [50, { name: 'Fit' }])], annotations: [[{ subtype: 'Link', dest: [50, { name: 'Fit' }], rect: [20, 20, 40, 40] }], []] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['A real title']);
  expect(result.page(1).links).toEqual([]);
});

it('allows ordinary web/contact URI schemes without laundering whitespace or unsafe schemes', () => {
  expect(pdfLinkUrl('https://example.org/a?b=1&c=2')).toBe('https://example.org/a?b=1&c=2');
  expect(pdfLinkUrl('tel:+123456')).toBe('tel:+123456');
  for (const uri of ['java\nscript:alert(1)', 'data:text/html,bad', 'file:///book.pdf', '/book.pdf', 'javascript:alert(1)']) expect(pdfLinkUrl(uri)).toBeUndefined();
});

it('rebuilds all seventeen entries of a two-page OCR contents table with separate ordinal and wrapped title lines', async () => {
  const numbers = 'ONE TWOO THREE FOUR FIVE SIX SEVEN FIGHT NINE TEN ELEVEN EW.BeVe THIRTEEN FOURTEEN FIFTEEN SIXTEEN 8EVENTEEN'.split(' ');
  const names = Array.from({ length: 17 }, (_, i) => `A journey through region ${String.fromCharCode(65 + i)}`);
  names[5] = 'The Way Through the Northern Valley';
  names[0] = 'FIRE The Light';
  const contents = [item('C O N T E N T S', 30, 780, 20)];
  const continued = [item('art: CONTENTS dx', 30, 780, 15)];
  for (let i = 0; i < 17; i++) {
    const rows = i < 8 ? contents : continued, y = 740 - (i < 8 ? i : i - 8) * 70;
    rows.push(item(numbers[i], 110, y, 11));
    if (i === 0) {
      rows.push(item('FIRE', 30, y - 14, 10), item(`The Light - ${1 + i * 4}`, 30, y - 28, 10));
    } else if (i === 5) {
      rows.push(item('The Way Through', 30, y - 14, 11), item(`the Northern Valley - ${1 + i * 4}`, 30, y - 28, 10));
    } else rows.push(item(`${names[i]} - ${1 + i * 4}`, 30, y - 14, 10));
  }
  const fixture = documentFixture([contents, continued, ...names.map(name => [item(name, 20, 740, 20), item('Ordinary reading text', 20, 700)])], { labels: ['i', 'ii', ...names.map((_, i) => String(1 + i * 4))] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(names);
  expect(result.page(1).links).toHaveLength(8);
  expect(result.page(2).links).toHaveLength(9);
  for (let i = 0; i < names.length; i++) expect(result.chapters[i].href).toBe(`page-${i + 3}.xhtml#pdf-page-${i + 3}`);
});

it('recognises a contents continuation without a repeated heading when ordinal/title rows have consistent references', async () => {
  const fixture = documentFixture([
    [item('Contents'), item('ONE', 30, 680), item('North 1', 20, 660), item('TWO', 30, 630), item('East 2', 20, 610)],
    [item('THREE', 30, 680), item('South 3', 20, 660), item('FOUR', 30, 630), item('West 4', 20, 610)],
    [item('North')], [item('East')], [item('South')], [item('West')],
  ], { labels: ['i', 'ii', '1', '2', '3', '4'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['North', 'East', 'South', 'West']);
  expect(result.page(2).links).toHaveLength(2);
});

it('recognises the hiragana contents heading without requiring kanji or English', async () => {
  const fixture = documentFixture([[item('もくじ'), item('第一課 1', 20, 650), item('第二課 2', 20, 620)], [item('第一課')], [item('第二課')]], { labels: ['i', '1', '2'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['第一課', '第二課']);
  expect(result.page(1).links).toHaveLength(2);
});

it('does not carry contents detection into ordinary prose with sparse or nonsequential numeric line endings', async () => {
  const fixture = documentFixture([
    [item('Contents'), item('North 1', 20, 650), item('South 2', 20, 620)],
    [item('North', 20, 750, 20), ...Array.from({ length: 12 }, (_, i) => item(i === 2 ? 'A measurement 4' : i === 6 ? 'Another value 3' : 'An ordinary line of the reading text.', 20, 700 - i * 20))],
    [item('South')],
  ], { labels: ['i', '1', '2'] });
  const result = await buildPdfNavigation(fixture.document);
  expect(result.chapters.map(chapter => chapter.title)).toEqual(['North', 'South']);
  expect(result.page(2).links).toEqual([]);
});
