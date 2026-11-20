package com.yujilik.kobobookmanager;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public class InPlaceTest {
    @Test public void namesTheKepubAfterTheOriginalFile() {
        assertEquals("Book.kepub.epub", InPlace.kepubName("Book.epub"));
        assertEquals("Book.kepub.epub", InPlace.kepubName("Book.EPUB"));
        assertEquals("noext.kepub.epub", InPlace.kepubName("noext"));
        assertEquals("Vol: 1 — «Été».kepub.epub", InPlace.kepubName("Vol: 1 — «Été».epub"));
        // Lower-casing "İ" changes the string length; the stem must still be cut correctly.
        assertEquals("İSTANBUL.kepub.epub", InPlace.kepubName("İSTANBUL.EPUB"));
    }

    @Test public void refusesFilesThatAreAlreadyKepub() {
        assertNull(InPlace.kepubName("a.kepub.epub"));
        assertNull(InPlace.kepubName("a.KEPUB.Epub"));
        assertNull(InPlace.kepubName(""));
        assertNull(InPlace.kepubName(null));
    }

    @Test public void recognisesProviderRenamesThatBreakTheKepubSuffix() {
        assertTrue(InPlace.isKepubName("Book.kepub.epub"));
        assertTrue(InPlace.isKepubName("Book (1).KEPUB.epub"));
        assertFalse(InPlace.isKepubName("Book.kepub (1).epub"));
        assertFalse(InPlace.isKepubName("epub"));
        assertFalse(InPlace.isKepubName(null));
    }

    @Test public void hashesTheOriginalLikeTheLibraryId() throws Exception {
        // The library id of a book is the SHA-256 of the bytes it was imported from.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ExportPayload.sha256(new ByteArrayInputStream("abc".getBytes(StandardCharsets.US_ASCII))));
    }
}
