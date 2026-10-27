package com.yujilik.kobobookmanager;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class ExportPayloadTest {
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder value = new StringBuilder();
        for (byte part : MessageDigest.getInstance("SHA-256").digest(bytes)) value.append(String.format(java.util.Locale.ROOT, "%02x", part & 255));
        return value.toString();
    }

    private static byte[] epub() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            byte[] mimetype = "application/epub+zip".getBytes(StandardCharsets.US_ASCII);
            CRC32 crc = new CRC32(); crc.update(mimetype);
            ZipEntry type = new ZipEntry("mimetype"); type.setMethod(ZipEntry.STORED); type.setSize(mimetype.length); type.setCrc(crc.getValue());
            zip.putNextEntry(type); zip.write(mimetype); zip.closeEntry();
            zip.putNextEntry(new ZipEntry("META-INF/container.xml"));
            zip.write("<container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'><rootfiles><rootfile full-path='book.opf' media-type='application/oebps-package+xml'/></rootfiles></container>".getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            zip.putNextEntry(new ZipEntry("book.opf"));
            zip.write("<package xmlns='http://www.idpf.org/2007/opf' version='3.0' unique-identifier='uid'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:identifier id='uid'>urn:uuid:test</dc:identifier><dc:title>Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id='p' href='page.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='p'/></spine></package>".getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            zip.putNextEntry(new ZipEntry("page.xhtml")); zip.write("<html xmlns='http://www.w3.org/1999/xhtml'><head><title>Test</title></head><body><p>Converted book</p></body></html>".getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
        }
        return output.toByteArray();
    }

    private static byte[] pdf() {
        return "%PDF-1.7\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Count 0/Kids[]>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n".getBytes(StandardCharsets.US_ASCII);
    }

    private static File stage(File root, byte[] bytes) throws Exception {
        File file = new File(root, "delivery/session/export");
        assertTrue(file.getParentFile().mkdirs() || file.getParentFile().isDirectory());
        Files.write(file.toPath(), bytes); return file;
    }

    private static void removeTree(File root) throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            for (java.nio.file.Path path : paths.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new)) Files.deleteIfExists(path);
        }
    }

    @Test public void validatesRealConvertedEpubAndKeepsTheExactStagedBytes() throws Exception {
        File root = Files.createTempDirectory("kobo-output").toFile(); byte[] bytes = epub();
        try {
            File file = stage(root, bytes);
            ExportPayload.Checked checked = ExportPayload.validate(root, "delivery/session/export", "book.kepub.epub", "application/epub+zip", bytes.length, hash(bytes));
            assertEquals(file.getCanonicalFile(), checked.file); assertEquals(bytes.length, checked.size); assertEquals(hash(bytes), checked.sha256);
            ByteArrayOutputStream saved = new ByteArrayOutputStream();
            try (InputStream input = new FileInputStream(checked.file)) { ExportPayload.copy(input, saved, checked.size, checked.sha256); }
            assertArrayEquals(bytes, saved.toByteArray());
            ExportPayload.verifyStream(new ByteArrayInputStream(saved.toByteArray()), checked.size, checked.sha256);
        } finally { removeTree(root); }
    }

    @Test public void rejectsZeroLengthTruncatedWrongHashAndMissingFiles() throws Exception {
        File root = Files.createTempDirectory("kobo-output").toFile(); byte[] bytes = epub();
        try {
            File file = stage(root, new byte[0]);
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", 0, hash(new byte[0])));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
            Files.write(file.toPath(), bytes);
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", bytes.length, "0".repeat(64)));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", bytes.length, null));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/missing", "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
        } finally { removeTree(root); }
    }

    @Test public void cannotSubstituteTheOriginalPdfForARequestedConvertedEpub() throws Exception {
        File root = Files.createTempDirectory("kobo-output").toFile();
        try {
            byte[] bytes = pdf(); stage(root, bytes);
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
            ExportPayload.validate(root, "delivery/session/export", "book.pdf", "application/pdf", bytes.length, hash(bytes));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/pdf", bytes.length, hash(bytes)));
            byte[] converted = epub(); stage(root, converted);
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.pdf", "application/pdf", converted.length, hash(converted)));
        } finally { removeTree(root); }
    }

    @Test public void rejectsPlainZipDisguisedAsEpubButAllowsAnArchiveExport() throws Exception {
        File root = Files.createTempDirectory("kobo-output").toFile();
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(output)) { zip.putNextEntry(new ZipEntry("backup.json")); zip.write("{}".getBytes(StandardCharsets.US_ASCII)); zip.closeEntry(); }
            byte[] bytes = output.toByteArray(); stage(root, bytes);
            ExportPayload.validate(root, "delivery/session/export", "backup.zip", "application/zip", bytes.length, hash(bytes));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "delivery/session/export", "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
        } finally { removeTree(root); }
    }

    @Test public void stagedPathsCannotEscapeTheAppCache() throws Exception {
        File root = Files.createTempDirectory("kobo-output").toFile(); byte[] bytes = epub();
        try {
            File file = stage(root, bytes);
            assertThrows(IOException.class, () -> ExportPayload.validate(root, "../outside", "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
            assertThrows(IOException.class, () -> ExportPayload.validate(root, file.getAbsolutePath(), "book.epub", "application/epub+zip", bytes.length, hash(bytes)));
        } finally { removeTree(root); }
    }

    @Test public void readbackCatchesProvidersThatSilentlyTruncateTheOutput() throws Exception {
        byte[] bytes = epub(); ByteArrayOutputStream backing = new ByteArrayOutputStream();
        OutputStream lossy = new OutputStream() {
            @Override public void write(int value) { if (backing.size() < 8) backing.write(value); }
        };
        ExportPayload.copy(new ByteArrayInputStream(bytes), lossy, bytes.length, hash(bytes));
        assertThrows(IOException.class, () -> ExportPayload.verifyStream(new ByteArrayInputStream(backing.toByteArray()), bytes.length, hash(bytes)));
        assertThrows(IOException.class, () -> ExportPayload.copy(new ByteArrayInputStream(Arrays.copyOf(bytes, 5)), new ByteArrayOutputStream(), bytes.length, hash(bytes)));
    }

    @Test public void aProviderMustCloseBeforeItsCommittedBytesCanBeVerified() throws Exception {
        byte[] bytes = epub(); ByteArrayOutputStream pending = new ByteArrayOutputStream(); ByteArrayOutputStream committed = new ByteArrayOutputStream();
        OutputStream deferred = new OutputStream() {
            @Override public void write(int value) { pending.write(value); }
            @Override public void close() throws IOException { committed.write(pending.toByteArray()); }
        };
        ExportPayload.copy(new ByteArrayInputStream(bytes), deferred, bytes.length, hash(bytes));
        assertEquals(0, committed.size());
        deferred.close();
        ExportPayload.verifyStream(new ByteArrayInputStream(committed.toByteArray()), bytes.length, hash(bytes));
    }
}
