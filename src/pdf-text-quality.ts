import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { PDF_OCR_LANGUAGES, type PdfOcrLanguage } from './pdf-ocr-options';
import { languageTag } from './pdf-language';

const items = (text: TextContent) => text.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim());
const length = (text: TextContent) => items(text).reduce((count, item) => count + item.str.replace(/\s/g, '').length, 0);
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;

/** Unicode validity does not tell us whether an inherited OCR layer read the scan correctly. */
export function existingOcrNeedsReview(text: TextContent): boolean {
  const runs = items(text), value = runs.map(item => item.str).join(' ');
  if (!value.trim()) return false;
  // Unusual case transitions commonly come from small-cap OCR. Ordinary names
  // such as McDonald, code and formulas do not trigger recognition on their own:
  // the caller also requires an invisible OCR layer over a raster page.
  if (/\p{Ll}\p{Lu}{2}/u.test(value)) return true;
  const normal = median(runs.map(item => Math.abs(item.height)).filter(Boolean)) || 12;
  const rows: { y: number; x: number; text: string }[] = [];
  for (const item of [...runs].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    let row = rows.at(-1);
    if (!row || Math.abs(row.y - item.transform[5]) > normal * .35) { row = { y: item.transform[5], x: item.transform[4], text: '' }; rows.push(row); }
    row.x = Math.min(row.x, item.transform[4]);
    row.text += (row.text ? ' ' : '') + item.str;
  }
  const noisy = rows.filter(row => {
    const text = row.text.trim(), letters = text.match(/\p{L}/gu)?.length || 0, symbols = text.match(/[^\p{L}\p{N}\s.,!?;:'’“”()\-]/gu)?.length || 0;
    return text.length < 45 && (symbols >= 2 || symbols && letters <= 4 || /(?:\b\p{L}{1,2}\b\s*){4}/u.test(text));
  });
  if (noisy.length >= 3) return true;
  const prose = rows.filter(row => row.text.length >= 45 && (row.text.match(/\p{Script=Latin}/gu)?.length || 0) >= 30);
  if (prose.length >= 3) {
    const first = prose[0], margins = prose.map(row => row.x).sort((a, b) => a - b), left = margins[Math.floor(margins.length * .15)];
    const next = rows[rows.indexOf(first) + 1];
    // A dropped capital may have been placed on the next OCR row, leaving an
    // abnormally indented lowercase fragment at the start of the paragraph.
    if (first.x - left > normal * 1.5 || first.x - left > normal * .8 && /^[a-z]/.test(first.text)) return true;
    if (next && next.x - left > normal * 1.5 && first.y - next.y < normal * 2) return true;
    if (runs.some(run => run.str.trim().length <= 3 && Math.abs(run.height) > normal * 1.7 && Math.abs(run.transform[5] - first.y) < normal * 3)) return true;
    // An illustrated opening with display lettering and a large vertical gap
    // needs a fresh layout pass; ordinary running headers sit much closer to
    // their body lines and do not establish this pattern.
    if (rows.some((row, index) => {
      const following = rows[index + 1], latin = row.text.match(/\p{Script=Latin}/gu)?.join('') || '';
      return following && latin.length >= 5 && latin.length <= 90 && latin === latin.toUpperCase() &&
        row.y - following.y > normal * 4 && /\p{Script=Latin}/u.test(following.text);
    })) return true;
  }
  return false;
}

/** Decorative display typography should remain faithful artwork when recognition is uncertain. */
export function decorativeOcrPage(text: TextContent, confidence: number, openingConfidence: number[] = [], context: { rear?: boolean; imageCount?: number } = {}): boolean {
  const runs = items(text);
  const value = runs.map(item => item.str).join(' ');
  // Rear matter requires both a picture and low overall recognition quality,
  // followed by the independent sparse-layout and font-variance checks below.
  // Individual row confidences vary across browser image decoders.
  if (context.rear && (confidence >= 75 || !context.imageCount)) return false;
  // Legal/imprint pages often mix ornate dedications, emblems and tiny type.
  // A faithful page is preferable to uncertain invented display lettering.
  if (!context.rear && /\bISBN\b/i.test(value) && /©|\bcopyright\b/i.test(value) && openingConfidence.slice(0, 3).some(score => score < 70)) return true;
  if (confidence >= 80 || !runs.length || length(text) > 600) return false;
  const heights = runs.map(item => Math.abs(item.height)).filter(Boolean), normal = median([...heights]);
  if (!normal || Math.max(...heights) < normal * 2.4) return false;
  const prose = runs.filter(item => item.str.trim().length > 65).reduce((count, item) => count + item.str.length, 0);
  return prose < length(text) * .5;
}

/** Use reliable source language metadata only in automatic mode; explicit selections win. */
export function sourceOcrLanguages(pages: TextContent[], fallback: PdfOcrLanguage[]): PdfOcrLanguage[] {
  const meaningful = pages.filter(page => length(page) >= 32);
  const counts = new Map<string, number>();
  for (const page of meaningful) { const tag = languageTag(page.lang).split('-')[0]; if (tag !== 'und') counts.set(tag, (counts.get(tag) || 0) + 1); }
  const [primary, count] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  if (!primary || count < 3 || count < meaningful.length * .7) return fallback;
  const selections: Record<string, PdfOcrLanguage[]> = { en: ['eng'], ja: ['eng', 'jpn'], zh: ['eng', 'chi_sim', 'chi_tra'], ko: ['eng', 'kor'], th: ['eng', 'tha'], ru: ['eng', 'rus'], pt: ['eng', 'por'], es: ['eng', 'spa'] };
  // Known-language defaults deliberately include related scripts (for example,
  // Japanese study books may include Chinese/Korean translations). Narrow only
  // the unknown-language all-model fallback, never these curated selections.
  const selected = new Set<PdfOcrLanguage>(fallback.length < PDF_OCR_LANGUAGES.length ? [...fallback, ...(selections[primary] || [])] : selections[primary] || fallback);
  const all = meaningful.flatMap(page => items(page).map(item => item.str)).join(' ');
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(all)) selected.add('jpn');
  if (/\p{Script=Han}/u.test(all) && !selected.has('jpn') && !selected.has('kor')) { selected.add('chi_sim'); selected.add('chi_tra'); }
  if (/\p{Script=Hangul}/u.test(all)) selected.add('kor');
  if (/\p{Script=Thai}/u.test(all)) selected.add('tha');
  if (/\p{Script=Cyrillic}/u.test(all)) selected.add('rus');
  return [...selected];
}
