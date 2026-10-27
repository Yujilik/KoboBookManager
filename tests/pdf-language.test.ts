import { expect, it } from 'vitest';
import { languageRuns, languageTag, lineSeparator, textLanguage } from '../src/pdf-language';

it('honours declared CJK languages where Han characters alone cannot distinguish Chinese from Japanese', () => {
  expect(textLanguage('漢字', 'ja')).toBe('ja');
  expect(textLanguage('漢字', 'zh-Hant')).toBe('zh-Hant');
  expect(textLanguage('漢字', 'und')).toBe('zh');
  expect(textLanguage('ひらがな', 'zh')).toBe('ja');
  expect(textLanguage('한국어', 'en')).toBe('ko');
});

it('tags mixed scripts without losing Thai combining marks, Japanese kana, Han or Korean', () => {
  const text = '中文 日本語ひらがな 한국어 ภาษาไทย สวัสดี';
  const runs = languageRuns(text, 'zh');
  expect(runs.map(run => run.text).join('')).toBe(text);
  expect(runs.map(run => run.language)).toEqual(expect.arrayContaining(['ja', 'ko', 'th']));
  expect(languageRuns('中文', 'zh')).toEqual([{ text: '中文', language: 'zh' }]);
});

it('does not insert Western spaces at PDF line breaks inside CJK or Thai words', () => {
  expect(lineSeparator('日本', '語')).toBe('');
  expect(lineSeparator('ภาษา', 'ไทย')).toBe('');
  expect(lineSeparator('Hello', 'world')).toBe(' ');
  expect(lineSeparator('안녕', '하세요')).toBe(' ');
});

it('canonicalises valid PDF language tags without treating arbitrary text as a language', () => {
  expect(languageTag('zh_tw')).toBe('zh-TW');
  expect(languageTag('not a language')).toBe('und');
});
