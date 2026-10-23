package com.yujilik.kobobookmanager;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "AppUpdates")
public class AppUpdatesPlugin extends Plugin {
    private final AtomicBoolean downloading = new AtomicBoolean();
    private volatile String pendingVersion;

    @PluginMethod public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject(); result.put("version", info.versionName); call.resolve(result);
        } catch (Exception error) { call.reject("updateCheckFailed", error); }
    }
    private File apk() { return new File(getContext().getCacheDir(), "updates/update.apk"); }

    @PluginMethod public void download(PluginCall call) {
        if (!downloading.compareAndSet(false, true)) { call.reject("updateInProgress"); return; }
        getBridge().execute(() -> {
            File destination = apk(), partial = new File(destination.getParentFile(), "update.part");
            pendingVersion = null;
            try {
                String version = call.getString("version"), checksum = call.getString("digest");
                long expected = Objects.requireNonNull(call.getLong("size"));
                URL url = UpdatePolicy.asset(Objects.requireNonNull(call.getString("url")), version, expected, checksum);
                if (!destination.getParentFile().isDirectory() && !destination.getParentFile().mkdirs()) throw new IOException("Update cache unavailable");
                if (destination.exists() && !destination.delete()) throw new IOException("Update cache unavailable");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long deadline = SystemClock.elapsedRealtime() + 180000;
                HttpURLConnection connection = connect(url);
                try {
                    long length = connection.getContentLengthLong();
                    if (length >= 0 && length != expected) throw new IOException("Update size mismatch");
                    try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(partial)) {
                        byte[] buffer = new byte[32768]; long size = 0; int count;
                        while ((count = input.read(buffer)) != -1) {
                            size += count;
                            if (size > expected || size > UpdatePolicy.MAX_BYTES || SystemClock.elapsedRealtime() > deadline) throw new IOException("Update download limit exceeded");
                            digest.update(buffer, 0, count); output.write(buffer, 0, count);
                        }
                        if (size != expected) throw new IOException("Incomplete update");
                    }
                } finally { connection.disconnect(); }
                if (checksum != null && !checksum.substring(7).equals(hex(digest.digest()))) throw new IOException("Update checksum mismatch");
                verifyArchive(partial, version);
                if (!partial.renameTo(destination)) throw new IOException("Cannot store update");
                pendingVersion = version; call.resolve();
            } catch (Exception error) { partial.delete(); call.reject(error.getMessage(), error); }
            finally { downloading.set(false); }
        });
    }

    private HttpURLConnection connect(URL initial) throws IOException {
        URL current = initial;
        for (int count = 0; count < 6; count++) {
            if (!UpdatePolicy.redirect(current)) throw new IOException("Invalid update redirect");
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/octet-stream");
            connection.setRequestProperty("User-Agent", "KoboBookManager-Updater");
            connection.setRequestProperty("Accept-Encoding", "identity");
            try {
                int status = connection.getResponseCode();
                if (status == 200) return connection;
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("Invalid update redirect");
                    current = new URL(current, location);
                    connection.disconnect(); continue;
                }
                throw new IOException("Update HTTP " + status);
            } catch (IOException error) { connection.disconnect(); throw error; }
        }
        throw new IOException("Too many update redirects");
    }

    @SuppressWarnings("deprecation")
    private void verifyArchive(File file, String version) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
        PackageInfo update = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (update == null || !installed.packageName.equals(update.packageName) || !version.equals(update.versionName) ||
            PackageInfoCompat.getLongVersionCode(update) <= PackageInfoCompat.getLongVersionCode(installed)) throw new IOException("Invalid update package or version");
        if (!signatures(installed).equals(signatures(update))) throw new IOException("updateSignatureMismatch");
    }
    @SuppressWarnings("deprecation")
    private Set<String> signatures(PackageInfo info) throws Exception {
        Signature[] values;
        if (Build.VERSION.SDK_INT >= 28) values = info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        else values = info.signatures;
        if (values == null || values.length == 0) throw new IOException("Missing update signature");
        Set<String> result = new HashSet<>();
        for (Signature value : values) result.add(hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray())));
        return result;
    }
    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(); for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 255)); return value.toString();
    }

    @PluginMethod public void install(PluginCall call) {
        if (pendingVersion == null || !apk().isFile() || downloading.get()) { call.reject("Update not downloaded"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())), "installPermissionReturned");
                } else openInstaller(call);
            } catch (Exception error) { call.reject("updateInstallFailed", error); }
        });
    }
    @ActivityCallback private void installPermissionReturned(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) { call.reject("installPermissionDenied"); return; }
        openInstaller(call);
    }
    private void openInstaller(PluginCall call) {
        try {
            verifyArchive(apk(), Objects.requireNonNull(pendingVersion));
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk());
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }
}
