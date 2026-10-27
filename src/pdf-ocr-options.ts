export const PDF_OCR_LANGUAGES = ['eng', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'tha', 'rus', 'por', 'spa'] as const;
export type PdfOcrLanguage = typeof PDF_OCR_LANGUAGES[number];
export interface PdfConversionOptions { ocrLanguages?: PdfOcrLanguage[] }
export const ocrLanguageNames: Record<PdfOcrLanguage, string> = {
  eng: 'English', jpn: '日本語', chi_sim: '简体中文', chi_tra: '繁體中文',
  kor: '한국어', tha: 'ไทย', rus: 'Русский', por: 'Português', spa: 'Español',
};

/** Metadata and visible title scripts are hints; users can select all languages present in scans. */
export function defaultOcrLanguages(book: { language: string; title: string; filename?: string }): PdfOcrLanguage[] {
  const language = book.language.trim().toLowerCase().replace(/_/g, '-');
  const text = `${book.title} ${book.filename || ''}`;
  if (/^(ja|jpn)(-|$)/.test(language) || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return ['eng', 'jpn', 'chi_sim', 'kor'];
  if (/^(ko|kor)(-|$)/.test(language) || /\p{Script=Hangul}/u.test(text)) return ['eng', 'kor'];
  if (/^(th|tha)(-|$)/.test(language) || /\p{Script=Thai}/u.test(text)) return ['eng', 'tha'];
  if (/^(ru|rus)(-|$)/.test(language) || /\p{Script=Cyrillic}/u.test(text)) return ['eng', 'rus'];
  if (/^(zh|chi|zho)(-|$)/.test(language) || /\p{Script=Han}/u.test(text)) return ['eng', 'chi_sim', 'chi_tra'];
  if (/^(pt|por)(-|$)/.test(language)) return ['eng', 'por'];
  if (/^(es|spa)(-|$)/.test(language)) return ['eng', 'spa'];
  if (/^(en|eng)(-|$)/.test(language)) return ['eng'];
  return [...PDF_OCR_LANGUAGES];
}
