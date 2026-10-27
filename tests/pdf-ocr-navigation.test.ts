// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { improveOcrNavigation } from '../src/pdf-ocr-navigation';

const longText = 'Readable practice material belongs to this learning section. '.repeat(30);
async function workbook(language: string, label: (n: number) => string) {
  const zip = new JSZip();
  zip.file('OEBPS/book.opf', `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>${language}</dc:language></metadata></package>`);
  zip.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="page-1.xhtml#pdf-page-1">Cover</a></li><li><a href="page-2.xhtml#pdf-page-2">Random OCR noise</a></li></ol></nav></body></html>');
  const html = (n: number, text: string) => `<html xmlns="http://www.w3.org/1999/xhtml" lang="${language}"><head><title>Source page</title></head><body id="pdf-page-${n}">${text}</body></html>`;
  zip.file('OEBPS/page-1.xhtml', html(1, '<p>Workbook cover and publishing data</p>'));
  const titles = ['A walk through the northern forest', 'A journey beside the southern lake', 'An arrival in the western valley'];
  zip.file('OEBPS/page-2.xhtml', html(2, titles.map((title, i) => `<p>${label(i + 1)} ${title}</p>`).join('')));
  for (let i = 0; i < 3; i++) {
    const first = 3 + i * 3;
    zip.file(`OEBPS/page-${first}.xhtml`, html(first, `<p>${titles[i]}</p>`));
    for (let p = first + 1; p <= first + 2; p++) zip.file(`OEBPS/page-${p}.xhtml`, html(p, `<p>${longText}</p><p>${label(i + 1)}</p>`));
  }
  return zip;
}

it.each([
  ['en', (n: number) => `Week ${n}`, ['Week 1', 'Week 2', 'Week 3']],
  ['ko', (n: number) => `제${n}주`, ['제1주', '제2주', '제3주']],
  ['ja', (n: number) => `第${n}周`, ['第1週', '第2週', '第3週']],
] as const)('recovers a repeated numbered %s series and links real printed rows without inventing page numbers', async (language, label, expected) => {
  const zip = await workbook(language, label);
  const result = await improveOcrNavigation(zip);
  expect(result?.chapters.map(chapter => chapter.title)).toEqual(['Cover', ...expected]);
  expect(result?.chapters.slice(1).map(chapter => chapter.href)).toEqual(['page-3.xhtml#pdf-page-3', 'page-6.xhtml#pdf-page-6', 'page-9.xhtml#pdf-page-9']);
  expect(result?.linksAdded).toBe(3);
  const doc = new DOMParser().parseFromString(await zip.file('OEBPS/page-2.xhtml')!.async('string'), 'application/xhtml+xml');
  expect(Array.from(doc.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['page-3.xhtml#pdf-page-3', 'page-6.xhtml#pdf-page-6', 'page-9.xhtml#pdf-page-9']);
  expect(doc.querySelectorAll('p')[0].textContent).toContain('northern forest');
  for (const n of [3, 6, 9]) expect(await zip.file(`OEBPS/page-${n}.xhtml`)!.async('string')).toContain('pdf-ocr-chapter-week-');
});

it('leaves a book unchanged when repeated markers or a coherent numbered series are missing', async () => {
  const zip = await workbook('en', n => n === 2 ? 'Other topic' : `Week ${n}`);
  const before = await zip.file('OEBPS/page-2.xhtml')!.async('string');
  expect(await improveOcrNavigation(zip)).toBeUndefined();
  expect(await zip.file('OEBPS/page-2.xhtml')!.async('string')).toBe(before);
});

it('does not create duplicate chapter headings when an already processed workbook is inspected again', async () => {
  const zip = await workbook('en', n => `Week ${n}`);
  await improveOcrNavigation(zip);
  await improveOcrNavigation(zip);
  const text = await zip.file('OEBPS/page-3.xhtml')!.async('string');
  expect(text.match(/id="pdf-ocr-chapter-week-1"/g)).toHaveLength(1);
});

it('ignores a one-off reference to another section rather than losing the repeated numbered series', async () => {
  const zip = await workbook('en', n => `Week ${n}`);
  const front = await zip.file('OEBPS/page-1.xhtml')!.async('string');
  zip.file('OEBPS/page-1.xhtml', front.replace('</body>', '<p>Further material may mention Week 9.</p></body>'));
  const result = await improveOcrNavigation(zip);
  expect(result?.chapters.slice(1).map(chapter => chapter.title)).toEqual(['Week 1', 'Week 2', 'Week 3']);
});

it('never uses facsimile supplements with duplicate page basenames as chapter source pages', async () => {
  const zip = await workbook('en', n => `Week ${n}`);
  for (let n = 1; n <= 11; n++) zip.file(`OEBPS/original-pages/page-${n}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Original page ${n}</p><p>Week 9 Week 8</p></body></html>`);
  const before = await zip.file('OEBPS/original-pages/page-3.xhtml')!.async('string');
  const result = await improveOcrNavigation(zip);
  expect(result?.chapters.slice(1).map(chapter => chapter.href)).toEqual(['page-3.xhtml#pdf-page-3', 'page-6.xhtml#pdf-page-6', 'page-9.xhtml#pdf-page-9']);
  expect(await zip.file('OEBPS/original-pages/page-3.xhtml')!.async('string')).toBe(before);
});

it('uses the supplied book language when package metadata is not written yet and the cover uses another language', async () => {
  const zip = await workbook('zh', n => `第${n}周`);
  zip.remove('OEBPS/book.opf');
  const result = await improveOcrNavigation(zip, 'ja');
  expect(result?.chapters.slice(1).map(chapter => chapter.title)).toEqual(['第1週', '第2週', '第3週']);
});

it('separates a one-off introductory mention from dense running headers and links the coherent contents rows', async () => {
  const zip = new JSZip(), titles = ['A forest beside the northern river', 'A journey through the southern hills', 'A market beyond the eastern village', 'A garden above the western valley'];
  zip.file('OEBPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:language>ja</dc:language></metadata></package>');
  for (let n = 1; n <= 80; n++) {
    const cover = [15, 31, 47, 63].indexOf(n), section = Math.floor((n - 16) / 16);
    const text = n === 3 ? '<p>第1週 はじめに — an introductory explanation of how the first week works.</p>'
      : n === 6 ? titles.map((title, i) => `<p>${i === 3 ? 'A garden aboe the wesn vally' : `第${i + 1}週 ${title}`}</p>`).join('')
      : n === 7 ? '<p>A general study explanation mentions the final 第4週 in a sentence, rather than a single contents entry.</p>'
      : cover >= 0 ? `<p>${titles[cover]}</p>`
      : n >= 16 && section >= 0 && section < 4 ? `<p>${longText}</p><p>第${section + 1}週</p>`
      : '<p>General introduction and publication details.</p>';
    zip.file(`OEBPS/page-${n}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml" lang="ja"><body id="pdf-page-${n}">${text}</body></html>`);
  }
  const result = await improveOcrNavigation(zip, 'ja');
  expect(result?.chapters.map(chapter => chapter.href)).toEqual([15, 31, 47, 63].map(n => `page-${n}.xhtml#pdf-page-${n}`));
  expect(result?.linksAdded).toBe(4);
  const contents = new DOMParser().parseFromString(await zip.file('OEBPS/page-6.xhtml')!.async('string'), 'application/xhtml+xml');
  expect(Array.from(contents.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual([15, 31, 47, 63].map(n => `page-${n}.xhtml#pdf-page-${n}`));
  expect(await zip.file('OEBPS/page-3.xhtml')!.async('string')).not.toContain('<a ');
});

it('matches a readable title script when OCR merges it with long unrelated translation noise', async () => {
  const zip = await workbook('ja', n => `第${n}週`);
  zip.file('OEBPS/page-3.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" lang="ja"><body id="pdf-page-3"><p>ゆっくり散歩を楽しみましょう① BERASD QWERASD ftyjfasd BERASD QWERASD ftyjfasd BERASD QWERASD ftyjfasd</p></body></html>');
  zip.file('OEBPS/page-2.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>ゆっくり散歩を楽しみましょ①</p><p>第2週 A journey beside the southern lake</p><p>第3週 An arrival in the western valley</p></body></html>');
  const result = await improveOcrNavigation(zip, 'ja'); expect(result?.linksAdded).toBe(3);
  const doc = new DOMParser().parseFromString(await zip.file('OEBPS/page-2.xhtml')!.async('string'), 'application/xhtml+xml');
  expect(doc.querySelector('a')?.getAttribute('href')).toBe('page-3.xhtml#pdf-page-3');
});

it.each(['pdf-destination-9', 'pdf-page-1'])('keeps a named Chinese preface with a %s bookmark destination', async fragment => {
  const zip = await workbook('ja', n => `第${n}週`);
  zip.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="page-1.xhtml#${fragment}">前言</a></li><li><a href="page-2.xhtml#pdf-page-2">Random OCR noise</a></li></ol></nav></body></html>`);
  const result = await improveOcrNavigation(zip, 'ja');
  expect(result?.chapters[0]).toEqual({ title: '前言', href: `page-1.xhtml#${fragment}`, children: [] });
  expect(result?.chapters.some(chapter => chapter.title === 'Random OCR noise')).toBe(false);
});
