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
}
export interface ReflowLink { rect: number[]; href: string }
export interface ReflowTarget { id: string; x?: number; y?: number }
export interface ReflowOptions { links?: ReflowLink[]; targets?: ReflowTarget[] }
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
  const runs: Run[] = items.filter(item => clean(item.str).trim() && Number.isFinite(item.transform[4]) && Number.isFinite(item.transform[5]))
    .flatMap(item => linkedRuns(item, options.links ?? []));
  const targets = validTargets(options.targets ?? []);
  if (!runs.length) return targets.map(target => `<span id="${xml(target.id)}"></span>`).join('');
  const tagged = (value: string) => languageRuns(value, language).map(run => {
    if (!run.language || run.language === 'und') return xml(run.text);
    languages.add(run.language);
    return `<span lang="${xml(run.language)}" xml:lang="${xml(run.language)}">${xml(run.text)}</span>`;
  }).join('');
  const fragment = (run: Run) => {
    let content = tagged(run.text);
    if (run.ruby.length) {
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
    const left = Math.min(...lines.map(line => line.x)), right = Math.max(...lines.map(line => line.end));
    let block: { html: string; text: string; heading: boolean; dir: string; bullet: boolean } | undefined;
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
      const heading = line.height > normal * 1.3 && text.trim().length < 160;
      const gap = previous ? previous.y - line.y : 0;
      const bullet = /^[▪■●•]/u.test(text.trim());
      const label = /^(?:example|例|例文)\s*[:：]/iu.test(text.trim());
      const indented = line.x - left > normal * 0.65 && !block?.bullet;
      const endsParagraph = previous && previous.end < right - normal * 2 && /[.!?。！？]["'”’」』)]?\s*$/.test(block?.text || '');
      if (block && !heading && !block.heading && !bullet && !label && block.dir === line.dir && gap > 0 && gap < spacing * 1.5 && !indented && !endsParagraph) {
        const separator = /[-\u00ad]$/.test(block.text.trim()) ? '' : lineSeparator(block.text.trim(), text.trim());
        block.html += separator + html; block.text += separator + text;
      } else {
        flush(); block = { html, text, heading, dir: line.dir, bullet };
      }
      previous = line;
    }
    flush();
  }
  return output.join('\n');
}
