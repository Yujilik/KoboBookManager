import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { languageRuns, lineSeparator } from './pdf-language';

interface Run {
  text: string;
  x: number;
  y: number;
  end: number;
  height: number;
  dir: string;
  ruby: Run[];
  href?: string;
  ids: string[];
  dropCap?: { bottom: number; right: number };
  image?: { src: string; alt: string; aspect: number; spaceAfter: boolean };
}
export interface ReflowLink { rect: number[]; href: string }
export interface ReflowTarget { id: string; x?: number; y?: number }
export interface ReflowInlineImage { item: TextItem; replace: TextItem[]; src: string; alt: string; aspect: number; hangingUntil?: number }
export interface ReflowOptions { links?: ReflowLink[]; targets?: ReflowTarget[]; inlineImages?: ReflowInlineImage[]; ocr?: boolean }
interface Line { runs: Run[]; x: number; end: number; y: number; height: number; dir: string }
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const xml = (value: string) => clean(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const reading = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Mark}\sー・]+$/u;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (!value || /[\u0000-\u0020\u007f]/u.test(value)) return;
  if (/^#[A-Za-z_][\w:.-]*$/u.test(value) || /^(?:[\w.-]+\/)*[\w.-]+\.xhtml(?:#[A-Za-z_][\w:.-]*)?$/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) return value;
  } catch { /* Only generated EPUB paths and explicitly safe external schemes are links. */ }
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment);
  return value.match(/\P{Mark}\p{Mark}*|\p{Mark}+/gu) ?? [];
}

/** Match the PDF link hitboxes before replacing page coordinates with normal text flow. */
function linkedRuns(item: TextItem, links: ReflowLink[]): Run[] {
  const text = clean(item.str), x = item.transform[4], y = item.transform[5];
  const width = Math.max(0, item.width), height = Math.abs(item.height) || Math.hypot(item.transform[0], item.transform[1]) || 12;
  const base = { text, x, y, end: x + width, height, dir: item.dir, ruby: [], ids: [] } as Run;
  const vertical = item.dir === 'ttb';
  const alongScale = Math.hypot(item.transform[vertical ? 2 : 0], item.transform[vertical ? 3 : 1]);
  const acrossScale = Math.hypot(item.transform[vertical ? 0 : 2], item.transform[vertical ? 1 : 3]);
  const ux = alongScale ? item.transform[vertical ? 2 : 0] / alongScale * (vertical ? -1 : 1) : vertical ? 0 : 1;
  const uy = alongScale ? item.transform[vertical ? 3 : 1] / alongScale * (vertical ? -1 : 1) : vertical ? -1 : 0;
  const nx = acrossScale ? item.transform[vertical ? 0 : 2] / acrossScale : vertical ? 1 : 0;
  const ny = acrossScale ? item.transform[vertical ? 1 : 3] / acrossScale : vertical ? 0 : 1;
  const advance = vertical ? height : width, thickness = vertical ? width : height;
  const corners = [0, advance].flatMap(offset => (vertical ? [-0.5, 0.5] : [-0.2, 0.9]).map(across => [x + ux * offset + nx * thickness * across, y + uy * offset + ny * thickness * across]));
  const bounds = { left: Math.min(...corners.map(point => point[0])), right: Math.max(...corners.map(point => point[0])), bottom: Math.min(...corners.map(point => point[1])), top: Math.max(...corners.map(point => point[1])) };
  const hits = links.flatMap(link => {
    const href = safeHref(link.href), rect = link.rect;
    if (!href || rect.length !== 4 || !rect.every(Number.isFinite)) return [];
    const left = Math.min(rect[0], rect[2]), right = Math.max(rect[0], rect[2]);
    const bottom = Math.min(rect[1], rect[3]), top = Math.max(rect[1], rect[3]);
    if (right <= bounds.left || left >= bounds.right || top < bounds.bottom || bottom > bounds.top) return [];
    return [{ href, left, right, bottom, top, area: (right - left) * (top - bottom) }];
  }).sort((a, b) => a.area - b.area);
  if (!hits.length) return [base];
  // Smaller hitboxes win when PDF annotations overlap, such as a linked number
  // within a larger linked index row. One character can never get nested links.
  const characters = graphemes(text), pieces: Run[] = [];
  for (let index = 0; index < characters.length; index++) {
    const position = item.dir === 'rtl' ? characters.length - index - 1 : index;
    const offset = advance * (position + 0.5) / characters.length;
    const centerX = x + ux * offset + nx * thickness * (vertical ? 0 : 0.35);
    const centerY = y + uy * offset + ny * thickness * (vertical ? 0 : 0.35);
    const horizontal = !vertical && Math.abs(uy) < 0.001;
    const href = hits.find(hit => centerX >= hit.left && centerX <= hit.right && (horizontal || centerY >= hit.bottom && centerY <= hit.top))?.href;
    // Source transforms determine hit testing; logical output coordinates keep
    // rotated text in its original string order when its rotation is removed.
    const left = vertical ? x : x + width * position / characters.length;
    const right = vertical ? x + width : x + width * (position + 1) / characters.length;
    const top = vertical ? y - advance * position / characters.length : y;
    const partHeight = vertical ? advance / characters.length : height;
    const prior = pieces.at(-1);
    if (prior && prior.href === href) {
      prior.text += characters[index]; prior.x = Math.min(prior.x, left); prior.end = Math.max(prior.end, right);
      if (vertical) prior.height += partHeight;
    } else pieces.push({ ...base, text: characters[index], x: left, y: top, end: right, height: partHeight, href, ruby: [], ids: [] });
  }
  return pieces;
}

function validTargets(targets: ReflowTarget[]): ReflowTarget[] {
  const seen = new Set<string>();
  return targets.filter(target => {
    if (!/^[A-Za-z_][\w:.-]*$/u.test(target.id) || seen.has(target.id)) return false;
    seen.add(target.id); return true;
  });
}

function attachTargets(runs: Run[], targets: ReflowTarget[]) {
  const highest = Math.max(...runs.map(run => run.y + (run.dir === 'ttb' ? 0 : run.height)));
  for (const target of targets) {
    const y = Number.isFinite(target.y) ? target.y! : highest;
    const x = Number.isFinite(target.x) ? target.x : undefined;
    const distance = (run: Run) => {
      const top = run.y + (run.dir === 'ttb' ? 0 : run.height), bottom = run.y - run.height * (run.dir === 'ttb' ? 1 : 0.2);
      const dy = y > top ? y - top : y < bottom ? bottom - y : 0;
      const dx = x === undefined ? 0 : x < run.x ? run.x - x : x > run.end ? x - run.end : 0;
      return dy * 4 + dx + (top > y + run.height ? run.height * 4 : 0);
    };
    const owner = [...runs].sort((a, b) => distance(a) - distance(b) || b.y - a.y || a.x - b.x)[0];
    owner?.ids.push(target.id);
  }
}

function groupLines(runs: Run[], normal: number): Line[] {
  const lines: Line[] = [];
  for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.at(-1);
    if (!line || Math.abs(line.y - run.y) > normal * 0.3 || line.dir !== run.dir) {
      line = { runs: [], x: run.x, end: run.end, y: run.y, height: run.height, dir: run.dir };
      lines.push(line);
    }
    line.runs.push(run);
    line.x = Math.min(line.x, run.x); line.end = Math.max(line.end, run.end);
    line.height = Math.max(line.height, run.height);
  }
  for (const line of lines) line.runs.sort((a, b) => line.dir === 'rtl' ? b.x - a.x : a.x - b.x);
  return lines;
}

/** OCR sometimes puts stray glyphs at the crop edge. They cannot define the
 * indentation of every paragraph in the actual text column. */
function columnLeft(lines: Line[], normal: number): number {
  const useful = lines.filter(line => line.height >= normal * .7 && line.height <= normal * 1.4 &&
    line.runs.map(run => run.text).join('').replace(/\s/g, '').length >= 8);
  const positions = (useful.length >= 2 ? useful : lines).map(line => line.x).sort((a, b) => a - b);
  if (!positions.length) return 0;
  let best: number[] = [];
  for (let start = 0; start < positions.length; start++) {
    const group = positions.slice(start).filter(x => x - positions[start] <= normal * .4);
    if (group.length > best.length) best = group;
  }
  return best.length >= 2 ? median(best) : Math.min(...positions);
}

/** A dropped initial is printed beside the first lines, with its baseline
 * below theirs. Normalize it before sorting, without imposing a font size. */
function attachDropCaps(runs: Run[], normal: number) {
  for (const initial of runs) {
    if (!/^[\p{Lu}]{1,2}$/u.test(initial.text.trim()) || initial.height < normal * 1.7 ||
      initial.height > normal * 5 || initial.end - initial.x > normal * 6 || initial.dir !== 'ltr') continue;
    const first = runs.filter(run => run !== initial && run.dir === 'ltr' && run.height >= normal * .65 &&
      run.height <= normal * 1.35 && run.x >= initial.x + normal && run.x <= initial.end + normal * 4 &&
      run.y >= initial.y - normal * .2 && run.y + run.height <= initial.y + initial.height * 1.15 &&
      run.y >= initial.y + initial.height * .25).sort((a, b) => b.y - a.y || a.x - b.x)[0];
    if (!first) continue;
    initial.dropCap = { bottom: initial.y, right: Math.max(initial.end, first.x) };
    initial.y = first.y;
    initial.height = first.height;
    // A separated short word ending, such as the rest of an honorific, belongs
    // directly to the initial. A complete following word keeps its separation.
    const joinsWord = /^[\p{Ll}]{1,2}[\p{Punctuation}\s]/u.test(first.text) || /^[\p{Ll}]{1,2}$/u.test(first.text);
    if (joinsWord) initial.text = initial.text.trim();
    initial.end = joinsWord ? first.x : Math.min(initial.end, first.x);
  }
}

function unwrapHyphen(block: { html: string; text: string }, after: string, wrappedAtRight: boolean): boolean {
  const soft = /\u00ad\s*$/u.test(block.text);
  const hard = wrappedAtRight && /\p{Ll}-$/u.test(block.text) && /^\p{Ll}/u.test(after);
  if (!soft && !hard) return false;
  block.text = block.text.replace(/[-\u00ad]\s*$/u, '');
  block.html = block.html.replace(/[-\u00ad](?=(?:<\/(?:a|span)>)*\s*$)/u, '');
  return true;
}

/** Associate small kana above a CJK base with that base, instead of inserting it as another body line. */
function attachRuby(runs: Run[]): Run[] {
  const annotations = new Set<Run>();
  for (const small of runs) {
    if (!reading.test(small.text.trim()) || small.dir === 'ttb') continue;
    let owner: Run | undefined, best = Infinity;
    for (const base of runs) {
      if (base === small || base.height < small.height * 1.45 || !cjk.test(base.text)) continue;
      const dy = small.y - base.y;
      if (dy < base.height * 0.4 || dy > Math.max(base.height * 1.4, small.height * 2.2)) continue;
      const overlap = Math.min(small.end, base.end) - Math.max(small.x, base.x);
      if (overlap <= Math.min(small.end - small.x, base.end - base.x) * 0.2) continue;
      const distance = Math.abs((small.x + small.end - base.x - base.end) / 2) /
        Math.max(base.end - base.x, small.end - small.x, 1) + Math.abs(dy / base.height - 0.85);
      if (distance < best) { owner = base; best = distance; }
    }
    if (owner) { owner.ruby.push(small); annotations.add(small); }
  }
  return runs.filter(run => !annotations.has(run));
}

/** Find a persistent gutter. A few separated words or one short heading cannot establish columns. */
function gutter(runs: Run[], normal: number): number | undefined {
  const body = runs.filter(run => run.height >= normal * 0.75 && run.height <= normal * 1.4);
  const intervals = body.map(run => [run.x, run.end]).sort((a, b) => a[0] - b[0]);
  if (!intervals.length) return;
  const merged: number[][] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] - previous[1] < normal * 0.4) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  const left = merged[0][0], right = merged.at(-1)![1], width = right - left;
  let candidate: number | undefined, largest = 0;
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1], middle = (merged[i][0] + merged[i - 1][1]) / 2;
    if (gap < normal * 1.25 || gap <= largest || middle < left + width * 0.25 || middle > left + width * 0.75) continue;
    const before = body.filter(run => run.end <= middle), after = body.filter(run => run.x >= middle);
    if (before.length < body.length * 0.2 || after.length < body.length * 0.2) continue;
    if (groupLines(before, normal).length < 4 || groupLines(after, normal).length < 4) continue;
    const overlap = Math.min(Math.max(...before.map(run => run.y)), Math.max(...after.map(run => run.y))) -
      Math.max(Math.min(...before.map(run => run.y)), Math.min(...after.map(run => run.y)));
    if (overlap < normal * 3) continue;
    candidate = middle; largest = gap;
  }
  return candidate;
}

function orderedRegions(runs: Run[], normal: number): Run[][] {
  const split = gutter(runs, normal);
  if (split === undefined) return [runs];
  // A hanging bullet can begin in the gutter. Only a genuinely wide heading
  // separates column bands; boundary glyphs belong to their text column.
  const crossesColumns = (run: Run) => run.x < split - normal * 2 && run.end > split + normal * 2;
  const spanning = groupLines(runs.filter(crossesColumns), normal);
  let remaining = runs.filter(run => !crossesColumns(run));
  const regions: Run[][] = [];
  const columns = (subset: Run[]) => {
    const left = subset.filter(run => (run.x + run.end) / 2 < split), right = subset.filter(run => (run.x + run.end) / 2 >= split);
    if (left.length) regions.push(left);
    if (right.length) regions.push(right);
  };
  for (const line of spanning) {
    columns(remaining.filter(run => run.y > line.y + normal * 0.3));
    regions.push(line.runs);
    remaining = remaining.filter(run => run.y <= line.y + normal * 0.3);
  }
  columns(remaining);
  return regions;
}

/** Build relative, selectable XHTML. Original coordinates determine reading order, never the output layout. */
export function reflowText(items: TextItem[], language: string, languages: Set<string>, options: ReflowOptions = {}): string {
  const inlineImages = new Map((options.inlineImages ?? []).map(image => {
    if (!/^(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g)$/i.test(image.src) || image.src.split('/').includes('..') ||
      !Number.isFinite(image.aspect) || image.aspect <= 0 || image.aspect > 30) throw new Error('conversionFailed');
    return [image.item, image] as const;
  }));
  const replaced = new Set((options.inlineImages ?? []).flatMap(image => image.replace));
  const runs: Run[] = items.filter(item => (inlineImages.has(item) || !replaced.has(item) && clean(item.str).trim()) && Number.isFinite(item.transform[4]) && Number.isFinite(item.transform[5]))
    .flatMap(item => {
      const image = inlineImages.get(item);
      const fragments = linkedRuns(image && !clean(item.str).trim() ? { ...item, str: '\ufffc' } : item, options.links ?? []);
      if (!image) return fragments;
      const first = fragments[0];
      const spaceAfter = /\s$/u.test(item.str);
      return [{ ...first, text: image.alt + (spaceAfter ? ' ' : ''), x: item.transform[4], end: item.transform[4] + item.width,
        image: { src: image.src, alt: image.alt, aspect: image.aspect, spaceAfter }, href: fragments.find(fragment => fragment.href)?.href,
        dropCap: Number.isFinite(image.hangingUntil) ? { bottom: image.hangingUntil!, right: item.transform[4] + item.width } : undefined }];
    });
  const targets = validTargets(options.targets ?? []);
  if (!runs.length) return targets.map(target => `<span id="${xml(target.id)}"></span>`).join('');
  const tagged = (value: string) => languageRuns(value, language).map(run => {
    if (!run.language || run.language === 'und') return xml(run.text);
    languages.add(run.language);
    return `<span lang="${xml(run.language)}" xml:lang="${xml(run.language)}">${xml(run.text)}</span>`;
  }).join('');
  const fragment = (run: Run) => {
    let content = run.image ? `<img class="pdf-inline-word" src="${xml(run.image.src)}" alt="${xml(run.image.alt)}" style="height:1em;width:${Number(run.image.aspect.toFixed(4))}em;vertical-align:baseline"/>${run.image.spaceAfter ? ' ' : ''}` : tagged(run.text);
    if (!run.image && run.ruby.length) {
      const bullet = run.text.match(/^([▪■●•]\s*)(.+)$/su);
      const annotation = run.ruby.sort((a, b) => a.x - b.x).map(reading => reading.text.trim()).join('');
      content = (bullet ? tagged(bullet[1]) : '') + `<ruby>${tagged(bullet ? bullet[2] : run.text)}<rt>${tagged(annotation)}</rt></ruby>`;
    }
    const href = run.href ?? run.ruby.find(reading => reading.href)?.href;
    if (href) content = `<a href="${xml(href)}">${content}</a>`;
    for (const id of run.ids) content = `<span id="${xml(id)}">${content}</span>`;
    return content;
  };
  const normal = [...runs].map(run => run.height).sort((a, b) => a - b)[Math.floor(runs.length * 0.6)];
  const body = attachRuby(runs);
  attachDropCaps(body, normal);
  attachTargets(body, targets);
  if (body.filter(run => run.dir === 'ttb').length > body.length / 2) {
    // Convert vertical source columns to logical horizontal paragraphs, keeping the reader's typography controls.
    const columns: Run[][] = [];
    for (const run of [...body].sort((a, b) => b.x - a.x || b.y - a.y)) {
      let column = columns.at(-1);
      if (!column || Math.abs(column[0].x - run.x) > normal * 0.45) { column = []; columns.push(column); }
      column.push(run);
    }
    return columns.map(column => `<p>${column.sort((a, b) => b.y - a.y).map(fragment).join('')}</p>`).join('\n');
  }
  // An isolated short running footer belongs after both columns, rather than between them.
  const allLines = groupLines(body, normal), footer = allLines.at(-1), above = allLines.at(-2);
  const footerRuns = footer && above && allLines.length >= 5 && above.y - footer.y > normal * 2 &&
    footer.height <= normal * 1.05 && footer.runs.map(run => run.text).join('').length < 100 ? footer.runs : [];
  const footerSet = new Set(footerRuns);
  const regions = orderedRegions(body.filter(run => !footerSet.has(run)), normal);
  if (footerRuns.length) regions.push(footerRuns);
  const output: string[] = [];
  for (const region of regions) {
    const lines = groupLines(region, normal);
    const gaps = lines.slice(1).map((line, index) => lines[index].y - line.y).filter(gap => gap > normal * 0.7 && gap < normal * 3);
    const spacing = median(gaps) || normal * 1.5;
    const left = columnLeft(lines, normal), right = Math.max(...lines.map(line => line.end));
    let block: { html: string; text: string; heading: boolean; dir: string; bullet: boolean; label: boolean; dropCap?: Run['dropCap'] } | undefined;
    let previous: Line | undefined;
    const flush = () => {
      if (!block) return;
      const tag = block.heading ? 'h2' : 'p';
      output.push(`<${tag}${block.dir === 'rtl' ? ' dir="rtl"' : ''}>${block.html}</${tag}>`); block = undefined;
    };
    for (const line of lines) {
      let html = '', text = '', prior: Run | undefined;
      for (const run of line.runs) {
        const gap = prior ? run.x - prior.end : 0;
        if (prior && gap > Math.min(prior.height, run.height) * 0.12 && !/\s$/.test(text) && !/^\s/.test(run.text)) {
          const separator = lineSeparator(text, run.text); html += separator; text += separator;
        }
        html += fragment(run); text += run.text; prior = run;
      }
      const gap = previous ? previous.y - line.y : 0;
      // OCR boxes measure ink, not font typography. Chapter navigation supplies
      // trustworthy headings; digital PDF font sizes can still identify them.
      const heading = !options.ocr && line.height > normal * 1.3 && text.trim().length < 160;
      const bullet = /^[▪■●•]/u.test(text.trim());
      const label = /^(?:example|例|例文)\s*[:：]/iu.test(text.trim());
      const besideInitial = block?.dropCap && line.y >= block.dropCap.bottom - normal * .3 && line.x <= block.dropCap.right + normal;
      // A quotation can have a stable inset margin for many consecutive lines.
      // Only a new rightward shift marks another first-line indentation.
      const indentationShift = previous ? line.x - previous.x : line.x - left;
      const indented = line.x - left > normal * 0.65 && indentationShift > normal * .65 && !block?.bullet && !besideInitial;
      const endsParagraph = previous && previous.end < right - normal * 2 && /[.!?。！？]["'”’」』)]?\s*$/.test(block?.text || '');
      const wrappedWord = !!block && !!previous && /(?:\p{Ll}-|\u00ad)\s*$/u.test(block.text) && /^\p{Ll}/u.test(text.trim()) && line.height <= normal * 1.8 && previous.height <= normal * 1.8;
      if (block && !block.label && !bullet && !label && block.dir === line.dir && gap > 0 && gap < spacing * 1.5 &&
        (wrappedWord || !heading && !block.heading && !indented && !endsParagraph)) {
        const unwrapped = unwrapHyphen(block, text.trim(), wrappedWord || !!previous && previous.end >= right - normal * 2);
        const separator = unwrapped || /[-\u00ad]$/.test(block.text.trim()) ? '' : lineSeparator(block.text.trim(), text.trim());
        block.html += separator + html; block.text += separator + text;
        if (wrappedWord) block.heading = block.heading && heading;
      } else {
        flush(); block = { html, text, heading, dir: line.dir, bullet, label, dropCap: line.runs.find(run => run.dropCap)?.dropCap };
      }
      previous = line;
    }
    flush();
  }
  return output.join('\n');
}
