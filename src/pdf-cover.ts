import { EncryptedPDFError, PDFBool, PDFDocument, PDFName, rgb } from 'pdf-lib';
import { coverMime } from './cover';
import { MAX_BOOK_SIZE } from './epub';
import type { Cover } from './types';

/** Wi-Fi delivery cannot write Kobo's thumbnail cache: give PDF readers a real cover page. */
export async function withPdfCover(bytes: Uint8Array, cover: Cover): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
  if (coverMime(cover.bytes) !== cover.mime) throw new Error('coverInvalid');
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    if (pdf.isEncrypted) throw new Error('DRM');
    if (!pdf.getPageCount()) throw new Error('pdfCoverFailed');
    const first = pdf.getPage(0);
    const size = first.getCropBox();
    const sideways = Math.abs(first.getRotation().angle) % 180 === 90;
    const width = sideways ? size.height : size.width;
    const height = sideways ? size.width : size.height;
    const marker = PDFName.of('KBMCover');
    // Only replace a cover created by this app. Never delete a source page.
    if (first.node.lookupMaybe(marker, PDFBool)?.asBoolean()) pdf.removePage(0);
    const image = await (cover.mime === 'image/png' ? pdf.embedPng(cover.bytes) : pdf.embedJpg(cover.bytes));
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error('coverInvalid');
    const page = pdf.insertPage(0, [width, height]);
    page.node.set(marker, PDFBool.True);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    const fitted = image.scaleToFit(width, height);
    page.drawImage(image, { x: (width - fitted.width) / 2, y: (height - fitted.height) / 2, ...fitted });
    // Keep original page objects, fonts, links and annotations; do not rasterise the PDF.
    const output = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    if (output.byteLength > MAX_BOOK_SIZE) throw new Error('fileTooLarge');
    return output;
  } catch (error) {
    if (error instanceof EncryptedPDFError || error instanceof Error && error.message === 'DRM') throw new Error('DRM');
    if (error instanceof Error && ['coverInvalid', 'fileTooLarge'].includes(error.message)) throw error;
    throw new Error('pdfCoverFailed', { cause: error });
  }
}
