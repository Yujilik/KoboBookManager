// @vitest-environment node
import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { repairPdfUnicode } from '../src/pdf-fonts';

async function fixture(options: { font?: string; unicode?: string; codes?: string; registry?: string; subtype?: string } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  const jis = !options.font || options.font.includes('DFKaiSho');
  const child = pdf.context.obj({
    Type: 'Font', Subtype: options.subtype || (jis ? 'CIDFontType2' : 'CIDFontType0'),
    BaseFont: options.font || 'ABCDEF+DFKaiSho-Md-MP-RKSJ-H',
    CIDSystemInfo: { Registry: pdf.context.obj(options.registry || (jis ? 'Adobe' : 'DYNA')), Ordering: pdf.context.obj(jis ? 'Identity' : 'GBH1'), Supplement: 0 },
    CIDToGIDMap: 'Identity', DW: 1000,
  });
  // PDF strings in CIDSystemInfo are strings rather than PDF names.
  const system = child.lookup(PDFName.of('CIDSystemInfo'), PDFDict);
  const { PDFString } = await import('pdf-lib');
  system.set(PDFName.of('Registry'), PDFString.of(options.registry || (jis ? 'Adobe' : 'DYNA')));
  system.set(PDFName.of('Ordering'), PDFString.of(jis ? 'Identity' : 'GBH1'));
  const font = pdf.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: options.font || 'ABCDEF+DFKaiSho-Md-MP-RKSJ-H', Encoding: 'Identity-H', DescendantFonts: [pdf.context.register(child)] });
  if (options.unicode) font.set(PDFName.of('ToUnicode'), pdf.context.register(pdf.context.flateStream(options.unicode)));
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: pdf.context.register(font) } }));
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(`BT /F1 14 Tf 20 550 Td <${options.codes || '025A02250231010206FA0D3E11FE0103'}> Tj ET`)));
  return pdf.save();
}
async function text(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true });
  try { const pdf = await task.promise; return (await (await pdf.getPage(1)).getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join(''); }
  finally { await task.destroy(); }
}

it('repairs legacy Identity-H JIS glyph IDs before PDF.js Unicode normalization and bidi', async () => {
  const original = await fixture(), before = original.slice();
  const repaired = await repairPdfUnicode(original);
  expect(original).toEqual(before);
  expect(await text(repaired)).toBe('むかし、浦太郎。');
  const doc = await PDFDocument.load(repaired);
  const font = doc.context.enumerateIndirectObjects().map(([, object]) => object).find(object => object instanceof PDFDict && object.has(PDFName.of('ToUnicode'))) as PDFDict;
  const map = font.lookup(PDFName.of('ToUnicode')) as PDFRawStream;
  const source = new TextDecoder().decode(decodePDFRawStream(map).decode());
  expect(source).toContain('<0000> <FFFD>');
  expect(source).toContain('<FFFF> <FFFD>');
});

it('recovers the traditional Chinese title font used for Japanese Han, kana and supplementary forms', async () => {
  const pdf = await fixture({ font: 'ABCDEF+HanziPenTC-W5-B5pc-H', codes: '404795AE95F12FD795BF95E62C0B95C763AF95F595AE75CF760D816A8C9596169648321F95B595D6960F95A596129640' });
  expect(await text(await repairPdfUnicode(pdf))).toBe('浦うら島しま太た郎ろう女弟雪沢セロ弾きのゴーシュ');
});

it('recovers the legacy font Latin block, including spaces, without losing text around Japanese', async () => {
  const pdf = await fixture({ codes: '004200430021003E004E0029002A002D0231' });
  expect(await text(await repairPdfUnicode(pdf))).toBe('AB =M(),し');
});

it('preserves an existing ToUnicode even when the font name matches a known legacy family', async () => {
  const unicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000><FFFF> endcodespacerange 1 beginbfchar <025A><65E5> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const pdf = await fixture({ unicode, codes: '025A' });
  expect(await repairPdfUnicode(pdf)).toBe(pdf);
  expect(await text(pdf)).toBe('日');
});

it('preserves valid mixed-script ToUnicode mappings even under a legacy family name', async () => {
  const unicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000><FFFF> endcodespacerange 1 beginbfchar <025A><D55C0E440E170E224E2D3042004100420043> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const pdf = await fixture({ unicode, codes: '025A' });
  expect(await repairPdfUnicode(pdf)).toBe(pdf);
  expect(await text(pdf)).toBe('한ไทย中あABC');
});

it('leaves unrelated fonts and real mixed-script Unicode alone', async () => {
  const pdf = await fixture({ font: 'ABCDEF+NotoSansCJK', codes: '004161E3304230640E01' });
  expect(await repairPdfUnicode(pdf)).toBe(pdf);
});

it('requires the exact CID font kind and registry rather than guessing from a font-family prefix', async () => {
  for (const options of [{ font: 'ABCDEF+DFKaiSho-Md-MP-RKSJ-H', subtype: 'CIDFontType0' }, { font: 'ABCDEF+HanziPenTC-W5-B5pc-H', registry: 'Adobe' }, { font: 'OtherDFKaiSho' }]) {
    const pdf = await fixture(options);
    expect(await repairPdfUnicode(pdf)).toBe(pdf);
  }
});

it('marks unsupported legacy glyph identifiers as unreliable rather than treating them as another alphabet', async () => {
  const pdf = await fixture({ codes: 'FFFF' });
  expect(await text(await repairPdfUnicode(pdf))).toContain('\uFFFD');
});

it('leaves malformed input to the existing PDF.js error handling', async () => {
  const malformed = new TextEncoder().encode('%PDF-1.7 broken');
  expect(await repairPdfUnicode(malformed)).toBe(malformed);
});
