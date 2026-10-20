import JSZip from 'jszip';
export async function fixture(version = '2.0', withCover = true) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/book.opf', `<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid"><metadata><dc:identifier id="uid">urn:uuid:original-identifier</dc:identifier><dc:title>Um livro de exemplo</dc:title><dc:creator opf:role="aut">Autor original</dc:creator><dc:creator id="translator">Tradutor original</dc:creator><meta refines="#translator" property="role">trl</meta><dc:language>pt-BR</dc:language>${withCover ? '<meta name="cover" content="cover-image"/>' : ''}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${withCover ? '<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>' : ''}</manifest><spine>${withCover ? '<itemref idref="cover-page"/>' : ''}<itemref idref="chapter"/></spine>${withCover ? '<guide><reference type="cover" href="cover.xhtml"/></guide>' : ''}</package>`);
  zip.file('OEBPS/chapter.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Uma página</title></head><body><h1>Começo</h1><p>Este é um livro de teste escrito para o projeto. Cada nova página abre uma possibilidade.</p><p>Boa leitura!</p></body></html>');
  if (withCover) {
    zip.file('OEBPS/images/cover.png', new Uint8Array([137, 80, 78, 71]));
    zip.file('OEBPS/cover.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capa</title></head><body><img src="images/cover.png" alt="Capa"/></body></html>');
  }
  return zip.generateAsync({ type: 'uint8array' });
}

export async function sampleCollection() {
  const titles = ['The Glass Orchard', 'A Map of Quiet Places', 'Letters from the Harbour', 'The Last Lantern', 'A Season of Small Wonders', 'Beyond the Paper Moon', 'The Library at Dawn'];
  const result: { name: string; bytes: Uint8Array }[] = [];
  for (let index = 0; index < titles.length; index++) {
    const zip = await JSZip.loadAsync(await fixture('3.0', false));
    const opf = (await zip.file('OEBPS/book.opf')!.async('string')).replace('Um livro de exemplo', titles[index]).replace('Autor original', 'Sample Author').replace('pt-BR', 'en-GB').replace('urn:uuid:original-identifier', 'urn:uuid:sample-collection-' + (index + 1));
    zip.file('OEBPS/book.opf', opf);
    for (const file of Object.values(zip.files)) file.date = new Date('2025-01-01T00:00:00Z');
    result.push({ name: `${String(index + 1).padStart(2, '0')} - ${titles[index]}.epub`, bytes: await zip.generateAsync({ type: 'uint8array' }) });
  }
  return result;
}
