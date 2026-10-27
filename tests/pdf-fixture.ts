/** A complete PDF made from small content streams; no personal book fixtures. */
export function pdfFixture(pages = ['BT /F1 18 Tf 40 750 Td (Title & <notes>) Tj /F1 12 Tf 0 -32 Td (First line of a paragraph) Tj 0 -15 Td (and its continuation.) Tj ET']) {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R /Lang (en-GB) >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (const [index, stream] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let source = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length); source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(new TextEncoder().encode(source));
}
