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
  it('does not promote a narrative sentence to a heading because an OCR row has an inflated size', () => {
    const source = [item('The preceding ordinary narrative fills this source line.', 20, 180, 300), item('Hagrid was so huge that this ordinary sentence kept going.', 20, 162, 300, 17), item('and the next normal line continues its paragraph.', 20, 144, 290)];
    const body = parse(reflowText(source, 'en', new Set(), { ocr: true }));
    expect(body.querySelector('h2')).toBeNull();
    expect(body.textContent).toContain('Hagrid was so huge');
    const digital = [item('A Genuine Chapter Title', 20, 240, 260, 20), ...source, item('Additional regular body text.', 20, 126, 250), item('More ordinary source font information.', 20, 108, 250), item('The final ordinary source line.', 20, 90, 250)];
    const title = parse(reflowText(digital, 'en', new Set()));
    expect(title.querySelector('h2')?.textContent).toBe('A Genuine Chapter Title');
    expect(parse(reflowText(digital, 'en', new Set(), { ocr: true })).querySelector('h2')).toBeNull();
  });

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

  it('infers prose indentation from the repeated text margin instead of isolated OCR debris at the crop edge', () => {
    const body = parse(reflow([
      item('An opening line that reaches the column edge', 77.8, 262.1, 232, 10.7),
      item('continues on the next physical line without ending', 32.4, 246.9, 277, 10.3),
      item('the paragraph.', 32.4, 231.3, 85, 10.7),
      item('The following paragraph starts indented and', 43.2, 215.9, 266, 10.9),
      item('flows across the full column', 32.6, 200.5, 277, 10.3),
      item('before it ends here.', 32.4, 185.1, 100, 10.7),
      item('a', 0, 61.4, 4, 8.2), item('Bi ee dicta ston', 0, 0, 18, 4.3),
    ]));
    expect(Array.from(body.querySelectorAll('p')).map(p => p.textContent).slice(0, 2)).toEqual([
      'An opening line that reaches the column edge continues on the next physical line without ending the paragraph.',
      'The following paragraph starts indented and flows across the full column before it ends here.',
    ]);
  });

  it('moves a dropped initial beside the first prose line before sorting and keeps the paragraph reader-controlled', () => {
    const body = parse(reflow([
      item('M ', 20, 120, 32, 36), item('r. Example starts the paragraph and', 55, 144, 245, 12),
      item('continues with ordinary body text on the next line', 55, 126, 245, 12),
      item('before the final sentence.', 20, 108, 150, 12),
    ]));
    expect(body.querySelectorAll('p')).toHaveLength(1);
    expect(body.textContent).toBe('Mr. Example starts the paragraph and continues with ordinary body text on the next line before the final sentence.');
    expect(body.querySelector('h2')).toBeNull();
  });

  it('removes physical line-wrap hyphens when joining a continued word, including across a link', () => {
    const body = parse(reflowText([
      item('The line contains a word split in-', 20, 150, 280),
      item('to a continuation, and an un\u00ad', 20, 132, 280),
      item('broken soft-hyphen word.', 20, 114, 170),
    ], 'en', new Set(), { links: [{ rect: [20, 147, 300, 163], href: 'page-2.xhtml#pdf-page-2' }] }));
    expect(body.querySelectorAll('p')).toHaveLength(1);
    expect(body.textContent).toBe('The line contains a word split into a continuation, and an unbroken soft-hyphen word.');
    expect(body.querySelector('a')?.getAttribute('href')).toBe('page-2.xhtml#pdf-page-2');
    expect(body.querySelector('a')?.textContent).toBe('The line contains a word split in');
  });

  it('joins a corrected tall initial to its nearby longer lowercase word fragment without inventing a space', () => {
    const body = parse(reflow([
      item('N', 20, 120, 34.5, 36), item('early everyone continued the opening', 55, 144, 245, 12),
      item('paragraph beside its decorated initial', 55, 126, 245, 12), item('and finished the sentence.', 20, 108, 150, 12),
    ]));
    expect(body.querySelector('p')?.textContent).toContain('Nearly everyone');
    expect(body.querySelectorAll('p')).toHaveLength(1);
  });

  it('uses a faithful inline word image in ordinary prose, skipping only the replaced source identities', () => {
    const initial = item('NN', 20, 100, 35, 32), remainder = item('t.', 55, 124, 12, 12);
    const anchor = item('\ufffc', 20, 124, 47, 12), body = item('and a completely adjustable paragraph continues here.', 75, 124, 240, 12);
    const html = reflowText([initial, remainder, anchor, body], 'en', new Set(), { inlineImages: [{ item: anchor, replace: [initial, remainder, anchor], src: 'images/first-word-1.png', alt: '', aspect: 2.5 }] });
    const document = parse(html), image = document.querySelector('p img')!;
    expect(document.querySelectorAll('p')).toHaveLength(1); expect(document.querySelector('h2')).toBeNull();
    expect(image.getAttribute('src')).toBe('images/first-word-1.png'); expect(image.getAttribute('style')).toContain('height:1em;width:2.5em');
    expect(document.textContent).toContain('and a completely adjustable paragraph'); expect(html).not.toMatch(/NN|\ufffc|>t\.</);
  });

  it('keeps PDF links and destination anchors attached to an inline source-word image', () => {
    const anchor = item('', 20, 100, 35, 12), following = item('ordinary following words.', 64, 100, 150, 12);
    const document = parse(reflowText([anchor, following], 'en', new Set(), {
      inlineImages: [{ item: anchor, replace: [], src: 'images/word.jpg', alt: 'Source word', aspect: 2 }],
      links: [{ rect: [20, 98, 55, 112], href: 'page-2.xhtml#pdf-page-2' }], targets: [{ id: 'initial-target', x: 20, y: 100 }],
    }));
    expect(document.querySelector('#initial-target a img')?.getAttribute('alt')).toBe('Source word');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('page-2.xhtml#pdf-page-2'); expect(document.textContent).toContain('ordinary following words.');
  });

  it('rejects unsafe or invalid source-word image locations before removing any text', () => {
    const anchor = item('Source', 20, 100, 40, 12);
    for (const src of ['javascript:alert(1)', 'https://example.org/word.png', '../outside.png']) expect(() => reflowText([anchor], 'en', new Set(), { inlineImages: [{ item: anchor, replace: [], src, alt: '', aspect: 2 }] })).toThrow('conversionFailed');
  });

  it('retains hanging source-line context after a tall decorated word becomes a normal-height inline image', () => {
    const anchor = item('', 20, 144, 47, 12);
    const document = parse(reflowText([
      anchor, item('and the ordinary first line continues', 75, 144, 225, 12),
      item('beside the original capital on the next line', 55, 126, 245, 12),
      item('before returning to the full text margin.', 20, 108, 230, 12),
    ], 'en', new Set(), { inlineImages: [{ item: anchor, replace: [], src: 'images/word.png', alt: '', aspect: 2.5, hangingUntil: 120 }] }));
    expect(document.querySelectorAll('p')).toHaveLength(1);
    expect(document.querySelector('p img')).not.toBeNull();
    expect(document.textContent).toContain('first line continues beside the original capital');
  });

  it('keeps the actual word space after a complete inline source word even when OCR boxes touch', () => {
    const anchor = item('\ufffc ', 20, 100, 47, 12);
    const html = reflowText([anchor, item('they continued in ordinary text.', 67, 100, 200, 12)], 'en', new Set(), {
      inlineImages: [{ item: anchor, replace: [], src: 'images/word.png', alt: '', aspect: 2.5 }],
    });
    expect(html).toMatch(/\/> they continued/);
    expect(parse(html).querySelector('img')?.nextSibling?.textContent).toBe(' they continued in ordinary text.');
  });

  it('joins consecutive lines at a stable inset quotation margin without flattening the surrounding paragraphs', () => {
    const body = parse(reflow([
      item('Ordinary prose has its own column margin.', 20, 260, 260, 10.7),
      item('The preceding paragraph ends.', 20, 244, 160, 10.7),
      item('The quoted paragraph contains a word split mak-', 68, 212, 215, 10.7),
      item('ing a continuous quotation across several lines', 68, 196, 215, 10.7),
      item('and keeping the following prose separate.', 68, 180, 195, 10.7),
      item('Another normal paragraph starts here', 32, 148, 248, 10.7),
      item('and finishes normally.', 20, 132, 120, 10.7),
    ]));
    expect(Array.from(body.querySelectorAll('p')).map(p => p.textContent)).toEqual([
      'Ordinary prose has its own column margin. The preceding paragraph ends.',
      'The quoted paragraph contains a word split making a continuous quotation across several lines and keeping the following prose separate.',
      'Another normal paragraph starts here and finishes normally.',
    ]);
  });

  it('keeps an obvious lowercase hyphen continuation together despite a noisy OCR font-height estimate', () => {
    const body = parse(reflow([
      item('A complete paragraph at the normal body size.', 20, 240, 260, 10.7),
      item('A new paragraph becomes almost unbear-', 32, 212, 248, 10.7),
      item('able because its OCR row height is inaccurate.', 20, 196, 245, 14.4),
      item('It continues with ordinary body type', 20, 180, 260, 10.7),
      item('until the paragraph ends.', 20, 164, 140, 10.7),
    ]));
    expect(body.querySelector('h2')).toBeNull();
    expect(Array.from(body.querySelectorAll('p')).map(p => p.textContent)).toEqual([
      'A complete paragraph at the normal body size.',
      'A new paragraph becomes almost unbearable because its OCR row height is inaccurate. It continues with ordinary body type until the paragraph ends.',
    ]);
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
