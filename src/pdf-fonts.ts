import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString, type PDFRef } from 'pdf-lib';

const name = PDFName.of;
const replacement = 0xfffd;

/**
 * Some legacy Japanese PDFs omit both ToUnicode and the embedded font's cmap.
 * Their Identity-H character codes are glyph identifiers, not Unicode. These
 * two specifically identified font encodings have recoverable character sets.
 * Never guess an encoding from the language or change an existing ToUnicode.
 */
function legacyEncoding(font: PDFDict): 'jis' | 'dyna' | undefined {
  if (font.has(name('ToUnicode')) || font.get(name('Subtype')) !== name('Type0') || font.get(name('Encoding')) !== name('Identity-H')) return;
  const base = font.lookupMaybe(name('BaseFont'), PDFName)?.decodeText().replace(/^[A-Z]{6}\+/, '');
  const descendants = font.lookupMaybe(name('DescendantFonts'), PDFArray);
  if (!descendants?.size()) return;
  const child = descendants.lookup(0, PDFDict);
  if (base === 'DFKaiSho-Md-MP-RKSJ-H' && child.get(name('Subtype')) === name('CIDFontType2') && child.get(name('CIDToGIDMap')) === name('Identity')) return 'jis';
  if (!/^HanziPenTC-W[35]-B5pc-H(?:-Identity-H)?$/.test(base || '') || child.get(name('Subtype')) !== name('CIDFontType0')) return;
  const system = child.lookupMaybe(name('CIDSystemInfo'), PDFDict);
  const registry = system?.lookup(name('Registry'));
  const ordering = system?.lookup(name('Ordering'));
  const text = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
  if (text(registry) === 'DYNA' && text(ordering) === 'GBH1') return 'dyna';
}

function jisCodes() {
  const map = new Map<number, number>();
  // The font's initial Latin glyph block starts with the space at GID 33.
  for (let code = 0x21; code <= 0x7f; code++) map.set(code, code - 1);
  const decoder = new TextDecoder('euc-jp', { fatal: true });
  for (let index = 0; index < 94 * 94; index++) {
    try {
      const value = decoder.decode(new Uint8Array([0xa1 + Math.floor(index / 94), 0xa1 + index % 94]));
      if ([...value].length === 1) map.set(index + 257, value.codePointAt(0)!);
    } catch { /* Unassigned positions must not become arbitrary Unicode. */ }
  }
  return map;
}

function dynaCodes() {
  const map = new Map<number, number>();
  for (let code = 0x20e1; code <= 0x72e0; code++) map.set(code, code + 0x2d1f);
  for (let code = 0x95a9; code <= 0x95fb; code++) map.set(code, code - 0x6568);
  for (let code = 0x95fc; code <= 0x9651; code++) map.set(code, code - 0x655b);
  // Japanese forms outside the font's main Han block and its prolonged mark.
  for (const [code, unicode] of [[0x75cf, 0x5973], [0x760d, 0x5f1f], [0x816a, 0x96ea], [0x8c95, 0x6ca2], [0x95a5, 0x30fc]]) map.set(code, unicode);
  return map;
}

function unicodeCMap(encoding: 'jis' | 'dyna') {
  const codes = encoding === 'jis' ? jisCodes() : dynaCodes();
  const hex = (value: number) => value.toString(16).toUpperCase().padStart(4, '0');
  const chunks = [
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    `/CMapName /KBM-${encoding}-UCS def\n/CMapType 2 def`,
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange',
  ];
  // An unknown code in one of these font encodings is an extraction failure.
  // Mark it explicitly so conversion can reject it instead of publishing glyph
  // IDs which happen to look like valid Korean, Thai, Arabic or other letters.
  for (let first = 0; first <= 0xffff; first += 100) {
    const count = Math.min(100, 0x10000 - first);
    chunks.push(`${count} beginbfchar`);
    for (let code = first; code < first + count; code++) chunks.push(`<${hex(code)}> <${hex(codes.get(code) ?? replacement)}>`);
    chunks.push('endbfchar');
  }
  chunks.push('endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend');
  return new TextEncoder().encode(chunks.join('\n'));
}

/** Repair extraction semantics in memory; original file bytes and glyph drawing stay intact. */
export async function repairPdfUnicode(bytes: Uint8Array): Promise<Uint8Array> {
  let document: PDFDocument;
  try { document = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch {
    // Leave password handling and tolerant PDF parsing to the existing PDF.js
    // loader. An encrypted or damaged input must never gain extraction rights
    // merely because its font metadata was inspected.
    return bytes;
  }
  const maps = new Map<'jis' | 'dyna', PDFRef>();
  let changed = false;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const encoding = legacyEncoding(object);
    if (!encoding) continue;
    let reference = maps.get(encoding);
    if (!reference) {
      reference = document.context.register(document.context.flateStream(unicodeCMap(encoding)));
      maps.set(encoding, reference);
    }
    object.set(name('ToUnicode'), reference);
    changed = true;
  }
  return changed ? document.save() : bytes;
}
