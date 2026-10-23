package com.yujilik.kobobookmanager;

import java.net.URL;
import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    private final String asset = "https://github.com/Yujilik/KoboBookManager/releases/download/v0.2.5/KoboBookManager-0.2.5.apk";

    @Test public void acceptsOnlyVersionedAssetsFromThisRepository() throws Exception {
        assertEquals(asset, UpdatePolicy.asset(asset, "0.2.5", 7000000, null).toString());
        assertNotNull(UpdatePolicy.asset(asset.replace("/v0.2.5/", "/0.2.5/"), "0.2.5", 7000000, "sha256:" + "a".repeat(64)));
        for (String bad : new String[]{asset.replace("https:", "http:"), asset.replace("Yujilik", "someone"), asset.replace("github.com/", "github.com.evil.example/"), asset + "?other=1", asset.replace("KoboBookManager-0.2.5.apk", "other.apk")}) {
            assertThrows(java.io.IOException.class, () -> UpdatePolicy.asset(bad, "0.2.5", 7000000, null));
        }
    }
    @Test public void rejectsInvalidSizeAndChecksum() {
        assertThrows(java.io.IOException.class, () -> UpdatePolicy.asset(asset, "0.2.5", 0, null));
        assertThrows(java.io.IOException.class, () -> UpdatePolicy.asset(asset, "0.2.5", UpdatePolicy.MAX_BYTES + 1, null));
        assertThrows(java.io.IOException.class, () -> UpdatePolicy.asset(asset, "0.2.5", 7000000, "not-a-digest"));
    }
    @Test public void followsOnlyGitHubAssetHostsOverHttps() throws Exception {
        assertTrue(UpdatePolicy.redirect(new URL("https://release-assets.githubusercontent.com/example?token=public-download")));
        for (String bad : new String[]{"http://objects.githubusercontent.com/test", "https://github.com.evil.example/test", "https://evil.example/test", "https://user:password@github.com/test", "https://github.com:8443/test"}) assertFalse(UpdatePolicy.redirect(new URL(bad)));
    }
}
