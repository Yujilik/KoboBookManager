export function languageTag(value: string | null | undefined): string {
  try { return value ? Intl.getCanonicalLocales(value.trim().replace(/_/g, '-'))[0] || 'und' : 'und'; }
  catch { return 'und'; }
}

/** Script detection is reliable for kana/Hangul/Thai; Han alone is ambiguous. */
export function textLanguage(text: string, fallback: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Thai}/u.test(text) && !/\p{Script=Han}/u.test(text)) return 'th';
  if (/\p{Script=Han}/u.test(text)) return /^(ja|ko|zh)(-|$)/i.test(fallback) ? fallback : 'zh';
  return fallback;
}

/** Tag the script runs, without guessing a Latin-script language or altering characters/marks. */
export function languageRuns(text: string, fallback: string): { text: string; language?: string }[] {
  const hanLanguage = textLanguage(text, fallback);
  const runs: { text: string; language?: string }[] = [];
  for (const character of text) {
    const previous = runs.at(-1);
    const language = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character) ? 'ja'
      : /\p{Script=Hangul}/u.test(character) ? 'ko'
      : /\p{Script=Thai}/u.test(character) ? 'th'
      : /\p{Script=Han}/u.test(character) ? hanLanguage
      : /[\p{Mark}\p{Punctuation}\p{Separator}\p{Number}]/u.test(character) ? previous?.language : undefined;
    if (previous && previous.language === language) previous.text += character;
    else runs.push({ text: character, language });
  }
  return runs;
}

/** A PDF hard line break is not a word separator inside CJK or Thai text. */
export function lineSeparator(before: string, after: string): string {
  const scripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Mark}]/u;
  return scripts.test([...before].at(-1) || '') && scripts.test([...after][0] || '') ? '' : ' ';
}
