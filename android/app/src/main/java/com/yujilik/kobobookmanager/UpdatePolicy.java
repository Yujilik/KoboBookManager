package com.yujilik.kobobookmanager;

import java.io.IOException;
import java.net.URL;

/** The updater accepts only this project's release assets and GitHub's HTTPS asset hosts. */
final class UpdatePolicy {
    static final long MAX_BYTES = 128L * 1024 * 1024;

    static URL asset(String address, String version, long size, String digest) throws IOException {
        if (version == null || !version.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")) throw new IOException("Invalid update version");
        if (size <= 0 || size > MAX_BYTES || (digest != null && !digest.matches("sha256:[a-f0-9]{64}"))) throw new IOException("Invalid update metadata");
        URL url = new URL(address);
        String prefix = "/Yujilik/KoboBookManager/releases/download/";
        String file = "/KoboBookManager-" + version + ".apk";
        if (!https(url) || !url.getHost().equals("github.com") || url.getQuery() != null || url.getRef() != null ||
            !(url.getPath().equals(prefix + version + file) || url.getPath().equals(prefix + "v" + version + file))) throw new IOException("Invalid update URL");
        return url;
    }

    static boolean redirect(URL url) {
        if (!https(url)) return false;
        String host = url.getHost();
        return host.equals("github.com") || host.equals("release-assets.githubusercontent.com") ||
            host.equals("objects.githubusercontent.com") || host.equals("github-releases.githubusercontent.com");
    }
    private static boolean https(URL url) {
        return url.getProtocol().equals("https") && (url.getPort() == -1 || url.getPort() == 443) && url.getUserInfo() == null;
    }
}
