// @vitest-environment node
import { expect, it } from 'vitest';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { decorativeOcrPage, existingOcrNeedsReview, sourceOcrLanguages } from '../src/pdf-text-quality';
import { ocrWordGeometry } from '../src/pdf-ocr-repair';
import { PDF_OCR_LANGUAGES } from '../src/pdf-ocr-options';

const item = (str: string, y = 500, height = 12): TextItem => ({ str, dir: 'ltr', width: str.length * 6, height, transform: [height, 0, 0, height, 20, y], fontName: 'ocr', hasEOL: true });
const content = (runs: TextItem[], lang: string | null = null): TextContent => ({ items: runs, styles: {}, lang });

it('does not equate valid Unicode with reliable inherited OCR small-cap recognition', () => {
  expect(existingOcrNeedsReview(content([item('For someone, wHO enjoys stories.')]))).toBe(true);
  expect(existingOcrNeedsReview(content([item('ScHOLASTIC INC.')]))).toBe(true);
  expect(existingOcrNeedsReview(content([item('Mr. McDonald and Ms. O’Neill read a normal paragraph.')]))).toBe(false);
});

it('detects several short OCR artifact rows but keeps isolated scene separators and formulas', () => {
  expect(existingOcrNeedsReview(content([item('* x *', 500), item('a : = p', 480), item('x * m : *', 460), item('An otherwise readable paragraph.', 420)]))).toBe(true);
  expect(existingOcrNeedsReview(content([item('A normal paragraph.', 500), item('* * *', 480), item('Another paragraph.', 460)]))).toBe(false);
  expect(existingOcrNeedsReview(content([item('x = a + b', 500), item('A derivation follows.', 480)]))).toBe(false);
});

it('preserves uncertain sparse decorative typography as artwork without flattening prose', () => {
  const title = content([item('DISPLAY TITLE', 600, 48), item('BY', 500), item('A WRITER', 470), item('Publisher', 400), item('A city', 380)]);
  expect(decorativeOcrPage(title, 69)).toBe(true);
  expect(decorativeOcrPage(title, 95)).toBe(false);
  expect(decorativeOcrPage(content([item('Heading', 600, 48), item('A long flowing prose paragraph. '.repeat(30), 500)]), 69)).toBe(false);
});

it('uses a reliable language consensus while retaining scripts actually present in mixed books', () => {
  const pages = [1, 2, 3, 4].map(() => content([item('A readable English paragraph with enough letters to identify its source language.')], 'eng'));
  expect(sourceOcrLanguages(pages, [...PDF_OCR_LANGUAGES])).toEqual(['eng']);
  pages[0].items.push(item('日本語ひらがな ภาษาไทย 한국어'));
  expect(sourceOcrLanguages(pages, ['eng'])).toEqual(['eng', 'jpn', 'kor', 'tha']);
});

it('does not use a single catalog notice to guess the language of a scanned book', () => {
  const pages = Array.from({ length: 10 }, () => content([]));
  pages.push(content([item('Catalog metadata in English contains enough text but only one page.')], 'eng'));
  expect(sourceOcrLanguages(pages, ['eng', 'jpn', 'chi_sim', 'kor'])).toEqual(['eng', 'jpn', 'chi_sim', 'kor']);
});

it('retains multilingual Japanese defaults rather than discarding translation languages', () => {
  const pages = [1, 2, 3].map(() => content([item('日本語の文章と中国語や韓国語の翻訳が同じ語学教材に含まれていても設定を保持します。')], 'jpn'));
  expect(sourceOcrLanguages(pages, ['eng', 'jpn', 'chi_sim', 'kor'])).toEqual(['eng', 'jpn', 'chi_sim', 'kor']);
});

it('preserves uncertain decorative legal front matter while leaving a prose introduction reflowable', () => {
  expect(decorativeOcrPage(content([item('For a loved one'), item('Text copyright © 2000. ISBN 1234567890. All rights reserved.')]), 92, [50, 90, 95])).toBe(true);
  expect(decorativeOcrPage(content([item('An ordinary introduction discusses the ideas in this book. '.repeat(15))]), 92, [50, 90, 95])).toBe(false);
});

it('reviews detached initials and illustrated chapter openings rather than trusting their Unicode', () => {
  const body = 'An ordinary body line contains enough letters to establish the text margin.';
  const page = content([item('AN OPENING TITLE', 600, 20), { ...item('lowercase fragment continues the first narrative sentence.', 520), transform: [12, 0, 0, 12, 60, 520] }, item(body, 502), item(body, 484), item(body, 466)]);
  expect(existingOcrNeedsReview(page)).toBe(true);
  const regular = content([item('RUNNING HEADER', 555), item(body, 520), item(body, 502), item(body, 484), item(body, 466)]);
  expect(existingOcrNeedsReview(regular)).toBe(false);
});

it('does not choose a language when the source metadata has no reliable majority', () => {
  const text = 'A paragraph containing sufficient actual readable text for the book.';
  const pages = ['eng', 'jpn', 'jpn', 'eng'].map(lang => content([item(text)], lang));
  expect(sourceOcrLanguages(pages, ['eng', 'jpn'])).toEqual(['eng', 'jpn']);
});

it('normalizes different glyph descenders to the fitted OCR row baseline and height', () => {
  const first = { text: 'a', confidence: 95, bbox: { x0: 10, y0: 25, x1: 20, y1: 40 } }, second = { text: 'body', confidence: 96, bbox: { x0: 25, y0: 10, x1: 70, y1: 48 } };
  const line = { text: 'a body', confidence: 95, bbox: { x0: 10, y0: 10, x1: 70, y1: 48 }, words: [first, second], baseline: { x0: 10, y0: 40, x1: 70, y1: 40 }, height: 38 };
  expect(ocrWordGeometry(line, first)).toEqual({ baseline: 40, height: 38 });
  expect(ocrWordGeometry(line, second)).toEqual({ baseline: 40, height: 38 });
});

it('retains a large initial ink box so the reflow engine can attach it to the opening line', () => {
  const large = { text: 'M', confidence: 90, bbox: { x0: 10, y0: 5, x1: 55, y1: 110 } };
  const regular = { text: 'body', confidence: 96, bbox: { x0: 65, y0: 70, x1: 130, y1: 100 } };
  const line = { text: 'M body', confidence: 95, bbox: { x0: 10, y0: 5, x1: 130, y1: 110 }, words: [large, regular, { ...regular, text: 'text' }], baseline: { x0: 10, y0: 100, x1: 130, y1: 100 }, height: 30 };
  expect(ocrWordGeometry(line, large)).toEqual({ baseline: 110, height: 105 });
  expect(ocrWordGeometry(line, regular)).toEqual({ baseline: 100, height: 30 });
});

it('preserves a rear decorative picture page only when sparse layout and recognition evidence both support it', () => {
  const decorative = content([item('ABOUT THE AUTHOR', 500, 24), item('Several small fragments', 400, 5), item('An uncertain caption', 380, 5), item('Other fragments', 360, 5)]);
  const context = { rear: true, imageCount: 2 };
  expect(decorativeOcrPage(decorative, 65, [0, 14, 31, 64], context)).toBe(true);
  expect(decorativeOcrPage(decorative, 88, [0, 14, 31, 64], context)).toBe(false);
  expect(decorativeOcrPage(decorative, 65, [0, 14, 31, 64], { rear: true, imageCount: 0 })).toBe(false);
  expect(decorativeOcrPage(decorative, 65, [40, 85, 95, 90], context)).toBe(true);
  // The actual Android renderer returned these higher per-row scores while
  // still omitting most of the author biography and classifying it as pictures.
  expect(decorativeOcrPage(decorative, 74, [51, 73, 78, 74], context)).toBe(true);
  const narrative = content([item('A final narrative paragraph with enough prose to remain adjustable. '.repeat(12))]);
  expect(decorativeOcrPage(narrative, 65, [0, 14, 31, 64], context)).toBe(false);
});

it('does not turn an oversized ink box on an ordinary long word into a dropped capital', () => {
  const long = { text: 'punishment.', confidence: 95, bbox: { x0: 100, y0: 20, x1: 300, y1: 83 } };
  const regular = { text: 'body', confidence: 96, bbox: { x0: 320, y0: 50, x1: 390, y1: 82 } };
  const line = { text: 'punishment. body words', confidence: 95, bbox: { x0: 100, y0: 20, x1: 480, y1: 83 }, words: [long, regular, { ...regular, text: 'words' }], baseline: { x0: 100, y0: 72, x1: 480, y1: 72 }, height: 43 };
  expect(ocrWordGeometry(line, long)).toEqual({ baseline: 72, height: 43 });
});
