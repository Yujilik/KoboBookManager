package com.yujilik.kobobookmanager;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public class BookContentTest {
    @Test public void recognisesBookSignaturesWithoutNamesOrMimeTypes() throws Exception {
        assertTrue(BookContent.candidate(new ByteArrayInputStream(new byte[]{'P', 'K', 3, 4, 20})));
        assertTrue(BookContent.candidate(new ByteArrayInputStream("%PDF-1.7".getBytes(StandardCharsets.US_ASCII))));
    }
    @Test public void ignoresUnrelatedAndTruncatedFiles() throws Exception {
        assertFalse(BookContent.candidate(null));
        for (String value : new String[]{"", "PK", "%PDF", "image.png", "text %PDF-1.7"}) {
            assertFalse(BookContent.candidate(new ByteArrayInputStream(value.getBytes(StandardCharsets.US_ASCII))));
        }
    }
    @Test public void handlesShortReadsAndReadsOnlyTheHeader() throws Exception {
        InputStream shortReads = new ByteArrayInputStream("%PDF-1.7".getBytes(StandardCharsets.US_ASCII)) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) { return super.read(bytes, offset, Math.min(length, 1)); }
        };
        assertTrue(BookContent.candidate(shortReads));
        assertEquals('1', shortReads.read());
    }
}
