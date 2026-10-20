package com.yujilik.kobobookmanager;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class DeliveryServerTest {
    @Test public void deliversTheEntireCollectionAsSeparateBooksAndLocalisesThePage() throws Exception {
        File first = File.createTempFile("kobo-one", ".epub"), second = File.createTempFile("kobo-two", ".epub");
        Files.write(first.toPath(), new byte[]{1, 2, 3}); Files.write(second.toPath(), new byte[]{4, 5, 6});
        java.util.List<DeliveryServer.Entry> entries = java.util.Arrays.asList(
            new DeliveryServer.Entry(first, "same.kepub.epub", "application/epub+zip", "Volume <one>"),
            new DeliveryServer.Entry(second, "same.kepub.epub", "application/epub+zip", "Volume two")
        );
        java.util.Map<String, String> labels = new java.util.HashMap<>(); labels.put("receiveTitle", "本を受け取る"); labels.put("download", "ダウンロード");
        try (DeliveryServer server = new DeliveryServer(entries, "ja", labels, 0)) {
            assertTrue(new String(request(server, "/"), StandardCharsets.UTF_8).contains("本を受け取る"));
            String page = new String(request(server, "/" + server.code()), StandardCharsets.UTF_8);
            assertTrue(page.contains("lang='ja'")); assertTrue(page.contains("ダウンロード")); assertTrue(page.contains("Volume &lt;one&gt;")); assertFalse(page.contains("Volume <one>"));
            for (int i = 0; i < 2; i++) {
                byte[] response = request(server, "/" + server.code() + "/" + i + "/same.kepub.epub");
                String raw = new String(response, StandardCharsets.ISO_8859_1); int start = raw.indexOf("\r\n\r\n") + 4;
                assertArrayEquals(i == 0 ? new byte[]{1, 2, 3} : new byte[]{4, 5, 6}, java.util.Arrays.copyOfRange(response, start, response.length));
            }
            assertTrue(new String(request(server, "/" + server.code() + "/2/same.kepub.epub"), StandardCharsets.UTF_8).contains("404 Not Found"));
        } finally { first.delete(); second.delete(); }
    }
    private byte[] request(DeliveryServer server, String path) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", server.port())) {
            socket.setSoTimeout(3000);
            socket.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: localhost\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            return socket.getInputStream().readAllBytes();
        }
    }
    @Test public void downloadsOnlyTheSelectedBookWithCorrectBytesAndExtension() throws Exception {
        File file = File.createTempFile("kobo-test", ".epub");
        byte[] payload = new byte[]{80, 75, 3, 4, 0, -1, 13, 10}; Files.write(file.toPath(), payload);
        try (DeliveryServer server = new DeliveryServer(file, "book.kepub.epub", "application/epub+zip", 0)) {
            String root = new String(request(server, "/"), StandardCharsets.UTF_8);
            assertTrue(root.contains("200 OK")); assertTrue(root.contains("name='code'"));
            String invalid = new String(request(server, "/wrong/book.kepub.epub"), StandardCharsets.UTF_8);
            assertTrue(invalid.contains("404 Not Found"));
            String page = new String(request(server, "/" + server.code()), StandardCharsets.UTF_8);
            assertTrue(page.contains("/" + server.code() + "/book.kepub.epub"));
            byte[] download = request(server, "/" + server.code() + "/book.kepub.epub");
            String raw = new String(download, StandardCharsets.ISO_8859_1);
            int start = raw.indexOf("\r\n\r\n") + 4;
            assertTrue(raw.contains("Content-Type: application/epub+zip"));
            assertTrue(raw.contains("filename=\"book.kepub.epub\""));
            assertArrayEquals(payload, java.util.Arrays.copyOfRange(download, start, download.length));
            assertTrue(new String(request(server, "/" + server.code() + "/../secret"), StandardCharsets.UTF_8).contains("404 Not Found"));
        } finally { file.delete(); }
    }
}
