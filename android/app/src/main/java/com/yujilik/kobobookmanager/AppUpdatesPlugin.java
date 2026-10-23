package com.yujilik.kobobookmanager;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Objects;

@CapacitorPlugin(name = "AppUpdates")
public class AppUpdatesPlugin extends Plugin {
    @PluginMethod public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject(); result.put("version", info.versionName); call.resolve(result);
        } catch (Exception error) { call.reject("updateCheckFailed", error); }
    }

    @PluginMethod public void openRelease(PluginCall call) {
        try {
            String address = Objects.requireNonNull(call.getString("url"));
            UpdatePolicy.release(address);
            getActivity().runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(address));
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    getActivity().startActivity(intent); call.resolve();
                } catch (Exception error) { call.reject("updateOpenFailed", error); }
            });
        } catch (Exception error) { call.reject("updateOpenFailed", error); }
    }
}
