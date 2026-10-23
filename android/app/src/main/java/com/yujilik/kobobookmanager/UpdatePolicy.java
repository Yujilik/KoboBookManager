package com.yujilik.kobobookmanager;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;

/** Only this project's public release pages may be opened by the update button. */
final class UpdatePolicy {
    static void release(String address) throws IOException {
        try {
            URI uri = new URI(address);
            String version = "(0|[1-9][0-9]*)";
            if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost()) ||
                (uri.getPort() != -1 && uri.getPort() != 443) || uri.getRawUserInfo() != null ||
                uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawPath() == null ||
                !uri.getRawPath().matches("/Yujilik/KoboBookManager/releases/tag/v?" + version + "\\." + version + "\\." + version)) {
                throw new IOException("Invalid release URL");
            }
        } catch (URISyntaxException error) { throw new IOException("Invalid release URL", error); }
    }
}
