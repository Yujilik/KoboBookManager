// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { reflowText } from '../src/pdf-reflow';

const item = (str: string, x: number, y: number, width = str.length * 6, height = 12, dir = 'ltr'): TextItem => ({
  str, dir, width, height, transform: [height, 0, 0, height, x, y], fontName: 'test', hasEOL: false,
});
const parse = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
const reflow = (items: TextItem[], language = 'en') => reflowText(items, language, new Set());

describe('PDF text reading order and relative typography', () => {
  it('reads each column from top to bottom before the next, with the running footer last', () => {
    const source: TextItem[] = [item('48 Book footer', 20, 20, 90, 9)];
    for (let i = 0; i < 4; i++) {
      source.push(item(`Right column ${i}.`, 220, 240 - i * 24, 100));
      source.push(item(`Left column ${i}.`, 20, 240 - i * 24, 100));
    }
    const text = parse(reflow(source)).textContent!;
    expect(text.indexOf('Left column 3')).toBeLessThan(text.indexOf('Right column 0'));
    expect(text.indexOf('Right column 3')).toBeLessThan(text.indexOf('Book footer'));
    for (let i = 0; i < 4; i++) { expect(text).toContain(`Left column ${i}.`); expect(text).toContain(`Right column ${i}.`); }
  });

  it('sorts headings and body geometry while joining indented first lines with their continuations', () => {
    const html = reflow([
      item('and its continuation.', 20, 160, 180),
      item('The second paragraph', 32, 136, 160),
      item('A title', 20, 240, 130, 24),
      item('with another line.', 20, 112, 150),
      item('A first paragraph', 32, 184, 150),
    ]);
    const body = parse(html);
    expect(body.querySelector('h2')?.textContent).toBe('A title');
    expect(Array.from(body.querySelectorAll('p')).map(p => p.textContent)).toEqual([
      'A first paragraph and its continuation.', 'The second paragraph with another line.',
    ]);
    expect(html).not.toMatch(/style=|position|font-size|line-height|width:/);
  });

  it('keeps hanging right-column bullet glyphs in that column instead of treating them as wide headings', () => {
    const source: TextItem[] = [];
    for (let i = 0; i < 5; i++) {
      source.push(item(`Left body ${i}.`, 79.5, 600 - i * 24, 154.4, 11.5));
      source.push(item(`Right body ${i}.`, 257.5, 600 - i * 24, 158.7, 11.5));
      source.push(item('■ 小', 244.5, 576 - i * 24 + 1.264, 22.9, 8));
    }
    const text = parse(reflow(source)).textContent!;
    expect(text.indexOf('Left body 4')).toBeLessThan(text.indexOf('Right body 0'));
    expect(text.indexOf('Right body 0')).toBeLessThan(text.indexOf('■ 小'));
    expect(text.match(/■ 小/g)).toHaveLength(5);
  });

  it('turns small kana above a Japanese base into semantic ruby, keeping the following text in normal flow', () => {
    const html = reflow([
      item('かんじ', 21, 110, 22, 6), item('を学ぶ', 44, 100, 36), item('漢字', 20, 100, 24),
    ], 'ja');
    const body = parse(html);
    expect(body.querySelector('ruby rt')?.textContent).toBe('かんじ');
    expect(body.querySelector('ruby')?.firstElementChild?.textContent).toBe('漢字');
    expect(body.querySelectorAll('p')).toHaveLength(1);
    expect(body.textContent).toBe('漢字かんじを学ぶ');
    expect(html).not.toContain('<img');
  });

  it('keeps small unrelated print rather than mistaking it for Japanese ruby', () => {
    const html = reflow([item('A larger heading', 20, 120, 150, 24), item('Small English note', 20, 140, 100, 10), item('Body text.', 20, 90, 100)]);
    expect(parse(html).textContent).toContain('Small English note');
    expect(html).not.toContain('<ruby>');
  });

  it('keeps glossary entries as separate paragraphs and joins their hanging continuations', () => {
    const html = reflow([
      item('■ First entry with a', 20, 200, 150), item('wrapped explanation', 32, 182, 140),
      item('■ Second entry with a', 20, 164, 150), item('second continuation', 32, 146, 140),
      item('example:', 32, 128, 60), item('An example sentence.', 32, 110, 140),
    ]);
    const paragraphs = Array.from(parse(html).querySelectorAll('p')).map(p => p.textContent);
    expect(paragraphs[0]).toBe('■ First entry with a wrapped explanation');
    expect(paragraphs[1]).toBe('■ Second entry with a second continuation');
    expect(paragraphs[2]).toBe('example:');
  });

  it('attaches kana to a short CJK run with a hanging bullet without annotating the bullet itself', () => {
    const html = reflow([item('■ 小', 244.5, 490.264, 22.9, 8), item('ちい', 257.5, 500.664, 11, 5.5), item('さい', 269, 489, 23, 11.5), item('Another body line.', 244.5, 450, 140, 11.5)], 'ja');
    const body = parse(html);
    expect(body.querySelector('ruby rt')?.textContent).toBe('ちい');
    expect(body.querySelector('ruby')?.textContent).toBe('小ちい');
    expect(body.querySelectorAll('p')).toHaveLength(2);
    expect(body.querySelector('p')?.textContent).toBe('■ 小ちいさい');
  });

  it('retains multilingual Unicode, marks its scripts and escapes XML', () => {
    const languages = new Set<string>();
    const html = reflowText([item('日本語ひらがな 中文 한국어 ภาษาไทย & <notes>', 20, 100, 400)], 'ja', languages);
    expect(parse(html).textContent).toBe('日本語ひらがな 中文 한국어 ภาษาไทย & <notes>');
    for (const language of ['ja', 'ko', 'th']) { expect(languages.has(language)).toBe(true); expect(html).toContain(`lang="${language}"`); }
    expect(html).toContain('&amp;'); expect(html).toContain('&lt;notes&gt;');
  });

  it('reads vertical Japanese columns right to left as logical text without fixed coordinates', () => {
    const html = reflow([item('左', 20, 180, 12, 12, 'ttb'), item('下', 100, 160, 12, 12, 'ttb'), item('右', 100, 180, 12, 12, 'ttb')], 'ja');
    expect(Array.from(parse(html).querySelectorAll('p')).map(p => p.textContent)).toEqual(['右下', '左']);
    expect(html).not.toContain('<img');
  });

  it('preserves explicit inline whitespace and joins hyphenated line endings without adding another space', () => {
    const body = parse(reflow([item('high- ', 20, 120, 50), item('quality material', 20, 102, 100)]));
    expect(body.textContent).toContain('high- quality material');
    const inline = parse(reflow([item('Bold ', 20, 100, 30), item('word', 50, 100, 30)]));
    expect(inline.textContent).toBe('Bold word');
  });

  it('returns no image or placeholder when a page has no meaningful text', () => {
    expect(reflow([item(' ', 10, 10), item('', 10, 20), item('\u0001', 10, 30)])).toBe('');
  });
});

describe('PDF links and destinations in reflowable text', () => {
  it('turns a PDF hitbox into a real internal link without swallowing unrelated text', () => {
    const html = reflowText([item('Chapter one', 20, 160, 100), item('Unlinked paragraph.', 20, 110, 160)], 'en', new Set(), {
      links: [{ rect: [20, 157, 120, 173], href: 'page-7.xhtml#pdf-page-7' }],
    });
    const body = parse(html), links = body.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('page-7.xhtml#pdf-page-7');
    expect(links[0].textContent).toBe('Chapter one');
    expect(body.textContent).toContain('Unlinked paragraph.');
    expect(links[0].textContent).not.toContain('Unlinked');
  });

  it('links only the annotated portions of one text run and retains both destinations', () => {
    const html = reflowText([item('Read site and book', 20, 100, 108)], 'en', new Set(), {
      links: [
        { rect: [50, 97, 74, 113], href: 'https://example.org/?a=1&b=2' },
        { rect: [104, 97, 128, 113], href: 'mailto:books@example.org' },
      ],
    });
    const body = parse(html), links = [...body.querySelectorAll('a')];
    expect(body.textContent).toBe('Read site and book');
    expect(links.map(link => link.textContent)).toEqual(['site', 'book']);
    expect(links.map(link => link.getAttribute('href'))).toEqual(['https://example.org/?a=1&b=2', 'mailto:books@example.org']);
    expect(html).toContain('&amp;b=2');
    expect(new DOMParser().parseFromString(`<body xmlns="http://www.w3.org/1999/xhtml">${html}</body>`, 'application/xml').querySelector('parsererror')).toBeNull();
  });

  it('preserves a linked index entry that spans two lines without nested anchors', () => {
    const html = reflowText([item('A longer chapter', 20, 140, 130), item('title continues here', 20, 122, 140)], 'en', new Set(), {
      links: [{ rect: [19, 119, 161, 153], href: 'page-20.xhtml#pdf-dest-1' }],
    });
    const body = parse(html), links = [...body.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links.every(link => link.getAttribute('href') === 'page-20.xhtml#pdf-dest-1')).toBe(true);
    expect(body.querySelector('a a')).toBeNull();
    expect(body.textContent).toBe('A longer chapter title continues here');
  });

  it('uses the more specific destination for overlapping PDF link rectangles', () => {
    const body = parse(reflowText([item('Chapter 12', 20, 100, 60)], 'en', new Set(), {
      links: [
        { rect: [20, 97, 80, 113], href: 'page-12.xhtml#chapter' },
        { rect: [68, 97, 80, 113], href: 'page-12.xhtml#page-number' },
      ],
    }));
    expect([...body.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Chapter ', 'page-12.xhtml#chapter'], ['12', 'page-12.xhtml#page-number'],
    ]);
    expect(body.querySelector('a a')).toBeNull();
  });

  it('places stable destination IDs on the nearest reading text, independent of source stream order', () => {
    const body = parse(reflowText([item('Body text.', 20, 360, 160), item('More body text.', 20, 340, 160), item('Last body line.', 20, 320, 160), item('Second chapter', 20, 400, 180, 24)], 'en', new Set(), {
      targets: [
        { id: 'chapter-2', x: 20, y: 424 }, { id: 'outline-2', x: 20, y: 424 },
        { id: 'chapter-2', x: 20, y: 360 },
      ],
    }));
    expect(body.querySelector('#chapter-2')?.textContent).toBe('Second chapter');
    expect(body.querySelector('#outline-2')?.textContent).toBe('Second chapter');
    expect(body.querySelectorAll('#chapter-2')).toHaveLength(1);
    expect(body.querySelector('#chapter-2')?.closest('h2')).not.toBeNull();
  });

  it('retains link targets on picture pages without inventing visible text', () => {
    const html = reflowText([], 'en', new Set(), { targets: [{ id: 'picture' }, { id: 'picture' }] });
    const body = parse(html);
    expect(body.querySelectorAll('#picture')).toHaveLength(1);
    expect(body.textContent).toBe('');
    expect(html).not.toContain('<img');
  });

  it('keeps linked Japanese ruby inside one valid hyperlink and targets its base text', () => {
    const html = reflowText([item('かんじ', 21, 110, 22, 6), item('漢字', 20, 100, 24)], 'ja', new Set(), {
      links: [{ rect: [19, 97, 45, 117], href: 'page-3.xhtml#kanji' }],
      targets: [{ id: 'kanji-here', x: 20, y: 100 }],
    });
    const body = parse(html);
    expect(body.querySelectorAll('a')).toHaveLength(1);
    expect(body.querySelector('a ruby rt')?.textContent).toBe('かんじ');
    expect(body.querySelector('#kanji-here')?.textContent).toBe('漢字かんじ');
    expect(body.querySelector('a a')).toBeNull();
    expect(html).not.toMatch(/style=|font-size|line-height|position/);
  });

  it('does not create executable or local-file links from unsafe PDF actions', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,hello', 'file:///secret', '//example.org/x']) {
      const body = parse(reflowText([item('Readable text', 20, 100, 100)], 'en', new Set(), {
        links: [{ rect: [19, 97, 121, 113], href }], targets: [{ id: '" onclick="bad' }],
      }));
      expect(body.querySelector('a'), href).toBeNull();
      expect(body.querySelector('[id]'), href).toBeNull();
      expect(body.textContent).toBe('Readable text');
    }
  });

  it('preserves telephone links allowed by the PDF navigation decoder', () => {
    const body = parse(reflowText([item('Call publisher', 20, 100, 100)], 'en', new Set(), {
      links: [{ rect: [19, 97, 121, 113], href: 'tel:+81312345678' }],
    }));
    expect(body.querySelector('a')?.getAttribute('href')).toBe('tel:+81312345678');
    expect(body.querySelector('a')?.textContent).toBe('Call publisher');
  });

  it('retains a horizontal link whose PDF hitbox is a narrow strip at the baseline', () => {
    const body = parse(reflowText([item('A linked word', 20, 100, 100)], 'en', new Set(), {
      links: [{ rect: [19, 99, 121, 101], href: 'https://example.org/narrow' }],
    }));
    expect(body.querySelector('a')?.textContent).toBe('A linked word');
  });

  it('maps a partial link down a vertical Japanese text column and keeps the logical string order', () => {
    const source = { ...item('一二三四', 100, 200, 12, 48, 'ttb'), transform: [12, 0, 0, 12, 100, 200] };
    const body = parse(reflowText([source], 'ja', new Set(), {
      links: [{ rect: [93, 152, 107, 176], href: 'page-3.xhtml#vertical-note' }],
      targets: [{ id: 'vertical-here', x: 100, y: 158 }],
    }));
    expect(body.textContent).toBe('一二三四');
    expect(body.querySelector('a')?.textContent).toBe('三四');
    expect(body.querySelector('a')?.getAttribute('href')).toBe('page-3.xhtml#vertical-note');
    expect(body.querySelector('#vertical-here')?.textContent).toBe('三四');
    expect(body.querySelectorAll('p')).toHaveLength(1);
  });

  it('matches rotated PDF hitboxes before returning the text to horizontal reading flow', () => {
    const source = { ...item('ABCDEF', 100, 100, 60, 12), transform: [0, 12, -12, 0, 100, 100] };
    const body = parse(reflowText([source], 'en', new Set(), {
      links: [{ rect: [89, 118, 103, 142], href: 'https://example.org/rotated' }],
    }));
    expect(body.textContent).toBe('ABCDEF');
    expect(body.querySelector('a')?.textContent).toBe('CD');
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.org/rotated');
  });
});
