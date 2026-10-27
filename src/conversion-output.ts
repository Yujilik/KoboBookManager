import JSZip from 'jszip';

const CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container';
const OPF = 'http://www.idpf.org/2007/opf';

function parseXml(value: string): XMLDocument {
  // Generated packages do not need DTDs or entity declarations.
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('Invalid generated XML');
  const document = new DOMParser().parseFromString(value, 'application/xml');
  if (document.getElementsByTagNameNS('*', 'parsererror').length) throw new Error('Invalid generated XML');
  return document;
}

function localPath(base: string, reference: string): string {
  const value = decodeURIComponent(reference.split('#')[0]);
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/)|\\/i.test(value)) throw new Error('Invalid generated path');
  const parts = base ? base.split('/').slice(0, -1) : [];
  for (const part of value.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error('Invalid generated path');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** Reject empty, wrong-format and incomplete conversion results before saving or delivery. */
export async function validateEpubOutput(bytes: Uint8Array): Promise<void> {
  try {
    if (!bytes || bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) {
      throw new Error('Conversion did not return a ZIP');
    }
    const zip = await JSZip.loadAsync(bytes);
    if (await zip.file('mimetype')?.async('string') !== 'application/epub+zip') throw new Error('Conversion did not return an EPUB');
    const container = zip.file('META-INF/container.xml');
    if (!container) throw new Error('Generated container is missing');
    const containerDocument = parseXml(await container.async('string'));
    if (containerDocument.documentElement.localName !== 'container' || containerDocument.documentElement.namespaceURI !== CONTAINER) {
      throw new Error('Invalid generated container');
    }
    const roots = Array.from(containerDocument.getElementsByTagNameNS(CONTAINER, 'rootfile'));
    const reference = roots.find(root => root.getAttribute('media-type') === 'application/oebps-package+xml')?.getAttribute('full-path');
    if (!reference) throw new Error('Generated package reference is missing');
    const path = localPath('', reference);
    const packageFile = zip.file(path);
    if (!packageFile) throw new Error('Generated package is missing');
    const document = parseXml(await packageFile.async('string'));
    if (document.documentElement.localName !== 'package' || document.documentElement.namespaceURI !== OPF) throw new Error('Invalid generated package');
    const manifest = document.getElementsByTagNameNS(OPF, 'manifest')[0];
    const spine = document.getElementsByTagNameNS(OPF, 'spine')[0];
    if (!manifest || !spine) throw new Error('Generated reading order is missing');
    const items = Array.from(manifest.getElementsByTagNameNS(OPF, 'item'));
    const references = Array.from(spine.getElementsByTagNameNS(OPF, 'itemref'));
    if (!references.length) throw new Error('Generated reading order is empty');
    for (const reference of references) {
      const id = reference.getAttribute('idref');
      const item = id && items.find(item => item.getAttribute('id') === id);
      const href = item && item.getAttribute('href');
      const file = href && zip.file(localPath(path, href));
      if (!file || !(await file.async('uint8array')).byteLength) throw new Error('Generated reading content is missing');
    }
  } catch (error) {
    throw new Error('conversionFailed', { cause: error });
  }
}
