package com.yujilik.kobobookmanager;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    private final String page = "https://github.com/Yujilik/KoboBookManager/releases/tag/0.2.6";

    @Test public void acceptsBothStableReleaseTagConventions() throws Exception {
        UpdatePolicy.release(page);
        UpdatePolicy.release(page.replace("/0.2.6", "/v0.2.6"));
    }

    @Test public void rejectsExternalAndNonReleaseDestinations() {
        for (String bad : new String[]{
            page.replace("https:", "http:"), page.replace("Yujilik", "someone"),
            page.replace("github.com/", "github.com.evil.example/"),
            page.replace("github.com/", "user:password@github.com/"),
            page.replace("github.com/", "github.com:8443/"), page + "?redirect=other",
            page + "#fragment", page + "-beta", page.replace("/tag/", "/download/"),
            page.replace("/0.2.6", "/../0.2.6"), page.replace("/0.2.6", "/0.02.6")
        }) assertThrows(java.io.IOException.class, () -> UpdatePolicy.release(bad));
    }
}
