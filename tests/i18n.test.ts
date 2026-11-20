import { describe, expect, it } from 'vitest';
import { locales, messages, translator } from '../src/messages';
import { readLocale, translatedError } from '../src/i18n';
describe('application languages', () => {
  it('defaults to British English regardless of browser language and retains a supported preference', () => {
    expect(readLocale(null)).toBe('en-GB'); expect(readLocale('fr')).toBe('en-GB');
    for (const locale of locales) expect(readLocale(locale)).toBe(locale);
  });
  it('provides seven complete dictionaries with identical substitution parameters', () => {
    expect(locales).toEqual(['en-GB', 'pt-BR', 'ru', 'ko', 'zh-CN', 'es-ES', 'ja']);
    for (const [key, translations] of Object.entries(messages)) {
      expect(translations.length, key).toBe(7);
      const parameters = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      for (const translation of translations) {
        expect(translation.trim().length, key).toBeGreaterThan(0);
        expect(parameters(translation), key).toEqual(parameters(translations[0]));
      }
    }
  });
  it('formats progress in each language without leaking placeholders', () => {
    for (const locale of locales) {
      const message = translator(locale)('converting', { index: 2, count: 7, progress: 50 });
      expect(message).toContain('2/7'); expect(message).toContain('50%'); expect(message).not.toContain('{');
    }
  });
  it('localises existing parser and native errors instead of exposing Portuguese in an English interface', () => {
    expect(translatedError(new Error('Este EPUB tem conteúdo protegido por DRM'), translator('en-GB'))).toContain('DRM-protected');
    expect(translatedError(new Error('Seleção de pasta cancelada.'), translator('ja'))).toBe(translator('ja')('cancelled'));
  });
  it('localises in-place replacement failures from Android and iOS', () => {
    for (const locale of locales) {
      const t = translator(locale);
      expect(translatedError({ message: 'folderReadOnly: write denied', code: 'FOLDER_READ_ONLY' }, t)).toBe(t('folderReadOnly'));
      expect(translatedError({ code: 'FOLDER_READ_ONLY' }, t)).toBe(t('folderReadOnly'));
      expect(translatedError({ message: 'originalMissing: gone', code: 'ORIGINAL_MISSING' }, t)).toBe(t('originalMissing'));
      expect(translatedError(new Error('replaceUnavailable'), t)).toBe(t('replaceUnavailable'));
      expect(translatedError({ message: 'Folder access expired', code: 'FOLDER_FAILED' }, t)).toBe(t('folderFailed'));
      expect(translatedError({ message: 'originalChanged: hash differs', code: 'ORIGINAL_CHANGED' }, t)).toBe(t('originalChanged'));
      expect(translatedError({ message: 'targetExists: Book.kepub.epub', code: 'TARGET_EXISTS' }, t)).toBe(t('targetExists'));
      // A generic failure naming an .epub file must not be mistaken for an invalid book.
      expect(translatedError({ message: 'Não foi possível salvar o arquivo no destino escolhido: Book.epub', code: 'SAVE_FAILED' }, t)).toBe(t('saveFailed'));
    }
  });
  it('localises export verification failures from JavaScript and native Android', () => {
    for (const locale of locales) {
      const t = translator(locale);
      expect(translatedError(new Error('outputInvalid'), t)).toBe(t('outputInvalid'));
      expect(translatedError({ message: 'outputInvalid: File hash mismatch', code: 'OUTPUT_INVALID' }, t)).toBe(t('outputInvalid'));
      expect(translatedError({ code: 'OUTPUT_INVALID' }, t)).toBe(t('outputInvalid'));
    }
  });
  it('explains when a PDF needs text recognition instead of promising an image-only conversion', () => {
    for (const locale of locales) for (const key of ['pdfTextUnavailable', 'pdfTextUnreliable', 'pdfOcrFailed'] as const) {
      expect(translatedError(new Error(key), translator(locale))).toBe(translator(locale)(key));
    }
  });
});
