package com.yujilik.kobobookmanager;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Validate staged exports before any picker, delivery session or success receipt. */
public final class ExportPayload {
    private static final long MAX_SIZE = 512L * 1024 * 1024;
    private static final byte[] EPUB_MIMETYPE = "application/epub+zip".getBytes(StandardCharsets.US_ASCII);

    public static final class Checked {
        public final File file;
        public final String mime, sha256;
        public final long size;
        private Checked(File file, String mime, long size, String sha256) {
            this.file = file; this.mime = mime; this.size = size; this.sha256 = sha256;
        }
    }

    private ExportPayload() {}

    public static Checked validate(File cacheDirectory, String path, String name, String mime, long expectedSize, String expectedHash) throws IOException {
        if (path == null || path.isEmpty() || new File(path).isAbsolute()) throw new IOException("Missing or invalid staged path");
        if (name == null || name.isEmpty() || mime == null) throw new IOException("Missing output filename or MIME type");
        File root = cacheDirectory.getCanonicalFile();
        File file = new File(root, path).getCanonicalFile();
        if (!file.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("Staged path is outside cache");
        if (!file.isFile()) throw new IOException("Staged output is missing");
        verifyFile(file, expectedSize, expectedHash);
        if ("application/pdf".equals(mime)) {
            if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")) throw new IOException("PDF filename does not match output type");
            try (InputStream input = new FileInputStream(file)) {
                byte[] prefix = readAtMost(input, 8);
                if (!new String(prefix, StandardCharsets.US_ASCII).matches("%PDF-[0-9]\\.[0-9]")) throw new IOException("Output is not a PDF");
            }
        } else if ("application/epub+zip".equals(mime)) {
            if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(".epub")) throw new IOException("EPUB filename does not match output type");
            verifyZip(file, true);
        } else if ("application/zip".equals(mime)) {
            if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) throw new IOException("ZIP filename does not match output type");
            verifyZip(file, false);
        } else throw new IOException("Unsupported output MIME type");
        return new Checked(file, mime, expectedSize, expectedHash);
    }

    public static void verifyFile(File file, long expectedSize, String expectedHash) throws IOException {
        if (!file.isFile() || file.length() != expectedSize) throw new IOException("Staged output length changed");
        try (InputStream input = new FileInputStream(file)) { verifyStream(input, expectedSize, expectedHash); }
    }

    public static void verifyStream(InputStream input, long expectedSize, String expectedHash) throws IOException {
        if (input == null) throw new IOException("Output cannot be read back");
        checkMetadata(expectedSize, expectedHash);
        MessageDigest digest = digest();
        byte[] buffer = new byte[32768]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            if (count == 0) continue;
            total += count;
            if (total > expectedSize) throw new IOException("Output is longer than expected");
            digest.update(buffer, 0, count);
        }
        if (total != expectedSize) throw new IOException("Output is empty or truncated");
        if (!hex(digest.digest()).equals(expectedHash)) throw new IOException("Output checksum mismatch");
    }

    /** Caller must close the destination before reporting success, then read it back. */
    public static void copy(InputStream input, OutputStream output, long expectedSize, String expectedHash) throws IOException {
        if (input == null || output == null) throw new IOException("Output destination is unavailable");
        checkMetadata(expectedSize, expectedHash);
        MessageDigest digest = digest();
        byte[] buffer = new byte[32768]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            if (count == 0) continue;
            total += count;
            if (total > expectedSize) throw new IOException("Staged output grew during save");
            output.write(buffer, 0, count); digest.update(buffer, 0, count);
        }
        if (total != expectedSize || !hex(digest.digest()).equals(expectedHash)) throw new IOException("Staged output changed during save");
        output.flush();
    }

    private static void checkMetadata(long size, String hash) throws IOException {
        if (size <= 0 || size > MAX_SIZE) throw new IOException("Output length is missing, zero or too large");
        if (hash == null || !hash.matches("[0-9a-f]{64}")) throw new IOException("Output checksum is missing or invalid");
    }

    private static MessageDigest digest() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IOException("SHA-256 is unavailable", impossible); }
    }

    private static String hex(byte[] bytes) {
        final char[] alphabet = "0123456789abcdef".toCharArray();
        char[] output = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) { int value = bytes[i] & 255; output[i * 2] = alphabet[value >>> 4]; output[i * 2 + 1] = alphabet[value & 15]; }
        return new String(output);
    }

    private static byte[] readAtMost(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream(); byte[] buffer = new byte[Math.min(8192, limit)]; int count;
        while (data.size() < limit && (count = input.read(buffer, 0, Math.min(buffer.length, limit - data.size()))) != -1) if (count > 0) data.write(buffer, 0, count);
        return data.toByteArray();
    }

    private static void verifyZip(File file, boolean epub) throws IOException {
        try (ZipFile zip = new ZipFile(file)) {
            boolean hasFile = false;
            for (Enumeration<? extends ZipEntry> entries = zip.entries(); entries.hasMoreElements();) if (!entries.nextElement().isDirectory()) { hasFile = true; break; }
            if (!hasFile) throw new IOException("Output ZIP is empty");
            if (!epub) return;
            ZipEntry type = zip.getEntry("mimetype"), container = zip.getEntry("META-INF/container.xml");
            if (type == null || type.isDirectory() || type.getSize() != EPUB_MIMETYPE.length || container == null || container.isDirectory() || container.getSize() <= 0 || container.getSize() > 1024 * 1024) throw new IOException("Output is not an EPUB container");
            try (InputStream input = zip.getInputStream(type)) {
                if (!java.util.Arrays.equals(readAtMost(input, EPUB_MIMETYPE.length + 1), EPUB_MIMETYPE)) throw new IOException("EPUB mimetype is invalid");
            }
            try (InputStream input = zip.getInputStream(container)) {
                byte[] contents = readAtMost(input, 1024 * 1024 + 1);
                if (contents.length == 0 || contents.length > 1024 * 1024) throw new IOException("EPUB container is invalid");
            }
        }
    }
}
