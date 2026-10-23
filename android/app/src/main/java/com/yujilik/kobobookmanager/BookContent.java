package com.yujilik.kobobookmanager;

import java.io.IOException;
import java.io.InputStream;

/** Fast folder prefilter. The web importer validates each EPUB's internal structure. */
final class BookContent {
    static boolean candidate(InputStream input) throws IOException {
        if (input == null) return false;
        byte[] header = new byte[5];
        int length = 0;
        while (length < header.length) {
            int count = input.read(header, length, header.length - length);
            if (count < 0) break;
            if (count == 0) {
                int next = input.read();
                if (next < 0) break;
                header[length++] = (byte) next;
            } else length += count;
        }
        return (length >= 4 && header[0] == 'P' && header[1] == 'K' && header[2] == 3 && header[3] == 4) ||
            (length >= 5 && header[0] == '%' && header[1] == 'P' && header[2] == 'D' && header[3] == 'F' && header[4] == '-');
    }
}
