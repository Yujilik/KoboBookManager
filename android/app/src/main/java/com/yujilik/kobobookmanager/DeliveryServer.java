package com.yujilik.kobobookmanager;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

/** Read-only temporary delivery of a selected book or collection, compatible with the Kobo browser. */
public final class DeliveryServer implements AutoCloseable {
    public static final class Entry {
        final File file;
        final String filename, mime, title;
        final long size;
        final String sha256;
        public Entry(File file, String filename, String mime, String title) {
            this(file, filename, mime, title, file.length(), null);
        }
        public Entry(File file, String filename, String mime, String title, long size, String sha256) {
            this.file = file;
            this.filename = filename.replaceAll("[^A-Za-z0-9._-]", "_");
            this.mime = "application/pdf".equals(mime) ? mime : "application/epub+zip";
            this.title = title;
            this.size = size; this.sha256 = sha256;
        }
    }
    private final ServerSocket server;
    private final ExecutorService workers = new ThreadPoolExecutor(3, 3, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(12));
    private final ScheduledExecutorService expiry = Executors.newSingleThreadScheduledExecutor();
    private final List<Entry> entries;
    private final Map<String, String> labels;
    private final String code, locale;

    public DeliveryServer(File file, String filename, String mime, int port) throws IOException {
        this(Collections.singletonList(new Entry(file, filename, mime, filename)), "en-GB", Collections.emptyMap(), port);
    }
    public DeliveryServer(List<Entry> entries, String locale, Map<String, String> labels, int port) throws IOException {
        if (entries.isEmpty()) throw new IOException("No delivery files");
        for (Entry entry : entries) {
            if (!entry.file.isFile() || entry.size <= 0 || entry.file.length() != entry.size) throw new IOException("Delivery output is missing, empty or truncated");
            if (entry.sha256 != null) ExportPayload.verifyFile(entry.file, entry.size, entry.sha256);
        }
        this.entries = new ArrayList<>(entries);
        this.locale = locale.matches("[a-zA-Z-]{2,16}") ? locale : "en-GB";
        this.labels = new HashMap<>(labels);
        this.code = String.format(Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000));
        this.server = new ServerSocket();
        server.setReuseAddress(true); server.bind(new InetSocketAddress(port));
        Thread acceptor = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket socket = server.accept();
                    try { workers.execute(() -> { try (socket) { handle(socket); } catch (IOException ignored) {} }); }
                    catch (RejectedExecutionException full) { socket.close(); }
                } catch (IOException ignored) { break; }
            }
        }, "kobo-delivery");
        acceptor.setDaemon(true); acceptor.start(); expiry.schedule(this::close, 20, TimeUnit.MINUTES);
    }
    public int port() { return server.getLocalPort(); }
    public String code() { return code; }
    public boolean isClosed() { return server.isClosed(); }
    private static String escape(String value) { return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;"); }
    private String label(String key, String fallback) { return escape(labels.getOrDefault(key, fallback)); }
    private String route(int index) { return "/" + code + "/" + (entries.size() > 1 ? index + "/" : "") + entries.get(index).filename; }

    private void handle(Socket socket) throws IOException {
        socket.setSoTimeout(5000);
        InputStream in = socket.getInputStream(); ByteArrayOutputStream header = new ByteArrayOutputStream();
        int b, tail = 0;
        while (header.size() < 8192 && (b = in.read()) != -1) { header.write(b); tail = (tail << 8) | b; if (tail == 0x0d0a0d0a) break; }
        String[] request = header.toString(StandardCharsets.US_ASCII.name()).split("\r\n", 2)[0].split(" ");
        OutputStream out = socket.getOutputStream();
        if (request.length != 3 || !(request[0].equals("GET") || request[0].equals("HEAD"))) { page(out, "405 Method Not Allowed", label("methodNotAllowed", "Method not allowed."), false); return; }
        boolean head = request[0].equals("HEAD"); String path = request[1];
        if (path.startsWith("/?code=")) {
            if (path.substring(7).split("&", 2)[0].equals(code)) { out.write(("HTTP/1.1 303 See Other\r\nLocation: /" + code + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); return; }
            page(out, "404 Not Found", "<h1>" + label("wrongCode", "Invalid code") + "</h1><a href='/'>" + label("retry", "Try again") + "</a>", head); return;
        }
        if (path.equals("/")) {
            page(out, "200 OK", "<h1>" + label("receiveTitle", "Receive books") + "</h1><p>" + label("enterCode", "Enter the code shown on your phone.") + "</p><form action='/' method='get'><input name='code' maxlength='6' size='8' autocomplete='off'/><button type='submit'>" + label("open", "Open") + "</button></form>", head); return;
        }
        if (path.equals("/" + code) || path.equals("/" + code + "/")) {
            StringBuilder body = new StringBuilder("<h1>" + label("readyKobo", "Ready for your Kobo") + "</h1><ol>");
            for (int i = 0; i < entries.size(); i++) body.append("<li style='margin-bottom:24px'><a href='").append(route(i)).append("'>").append(label("download", "Download")).append(": ").append(escape(entries.get(i).title)).append("</a><br><small>").append(escape(entries.get(i).filename)).append("</small></li>");
            body.append("</ol><p>").append(label("closeBrowser", "After downloading, close the browser to find your books in the library.")).append("</p>");
            page(out, "200 OK", body.toString(), head); return;
        }
        Entry selected = null;
        for (int i = 0; i < entries.size(); i++) if (path.equals(route(i))) { selected = entries.get(i); break; }
        if (selected == null) { page(out, "404 Not Found", label("notFound", "File not found."), head); return; }
        if (!selected.file.isFile() || selected.file.length() != selected.size) { page(out, "410 Gone", label("notFound", "File not found."), head); return; }
        if (selected.sha256 != null) {
            try { ExportPayload.verifyFile(selected.file, selected.size, selected.sha256); }
            catch (IOException changed) { page(out, "410 Gone", label("notFound", "File not found."), head); return; }
        }
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + selected.mime + "\r\nContent-Length: " + selected.size + "\r\nContent-Disposition: attachment; filename=\"" + selected.filename + "\"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        if (!head) try (InputStream bytes = new FileInputStream(selected.file)) { byte[] buffer = new byte[32768]; int n; while ((n = bytes.read(buffer)) != -1) out.write(buffer, 0, n); }
        out.flush();
    }
    private void page(OutputStream out, String status, String body, boolean head) throws IOException {
        byte[] data = ("<!doctype html><html lang='" + locale + "'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Kobo Book Manager</title></head><body style='font:22px sans-serif;color:#000;background:#fff;margin:24px'>" + body + "</body></html>").getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + data.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        if (!head) out.write(data); out.flush();
    }
    @Override public void close() { try { server.close(); } catch (IOException ignored) {} workers.shutdownNow(); expiry.shutdownNow(); }
}
