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
  it('localises export verification failures from JavaScript and native Android', () => {
    for (const locale of locales) {
      const t = translator(locale);
      expect(translatedError(new Error('outputInvalid'), t)).toBe(t('outputInvalid'));
      expect(translatedError({ message: 'outputInvalid: File hash mismatch', code: 'OUTPUT_INVALID' }, t)).toBe(t('outputInvalid'));
      expect(translatedError({ code: 'OUTPUT_INVALID' }, t)).toBe(t('outputInvalid'));
    }
  });
});
