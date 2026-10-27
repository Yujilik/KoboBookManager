import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { locales, translator, type Locale, type Translate } from './messages';
const Context = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: Translate } | null>(null);
export function readLocale(value: string | null): Locale { return locales.includes(value as Locale) ? value as Locale : 'en-GB'; }
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState<Locale>(() => { try { return readLocale(localStorage.getItem('kobo-locale')); } catch { return 'en-GB'; } });
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const setLocale = (next: Locale) => { update(next); try { localStorage.setItem('kobo-locale', next); } catch { /* Session language still works when storage is unavailable. */ } };
  return <Context.Provider value={{ locale, setLocale, t: translator(locale) }}>{children}</Context.Provider>;
}
export function useI18n() { const value = useContext(Context); if (!value) throw new Error('Missing language provider'); return value; }

export function translatedError(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  if (message === 'pdfPasswordRequired') return t('pdfPasswordRequired');
  if (message === 'pdfConversionTooLarge') return t('pdfConversionTooLarge');
  if (message === 'pdfCoverFailed') return t('pdfCoverFailed');
  if (/fileTooLarge/.test(message)) return t('fileTooLarge');
  if (/collectionTooLarge/.test(message)) return t('collectionTooLarge');
  if (/cancelad|cancelled/.test(message)) return t('cancelled');
  if (/DRM/.test(message)) return t('drm');
  if (/backup|Backup/.test(message)) return t('backupInvalid');
  if (/título|titleRequired/.test(message)) return t('titleRequired');
  if (/capa|coverInvalid/.test(message)) return t('coverInvalid');
  if (/XML|EPUB|epub|ZIP|Caminho|invalidBook/.test(message) && !/convert/.test(message)) return t('invalidBook');
  if (/conver|minutos|converter/.test(message)) return t('conversionFailed');
  if (/pasta|folderFailed/.test(message)) return t('folderFailed');
  if (/salvar|saveFailed/.test(message)) return t('saveFailed');
  if (/Wi-Fi|hotspot|envio|networkFailed/.test(message)) return t('networkFailed');
  if (/Android/.test(message)) return t('androidOnly');
  if (/numberInvalid/.test(message)) return t('numberInvalid');
  if (import.meta.env.DEV) console.error(error);
  return t('unexpectedError');
}
