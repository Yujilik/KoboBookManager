package com.yujilik.kobobookmanager;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.util.*;

@CapacitorPlugin(name = "KoboNative")
public class KoboNativePlugin extends Plugin {
    private DeliveryServer delivery;
    private static final long MAX_FILE = 64L * 1024 * 1024;

    @PluginMethod public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderChosen");
    }

    @ActivityCallback private void folderChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) { call.reject("Seleção de pasta cancelada."); return; }
        try {
            Uri uri = data.getData();
            getContext().getContentResolver().takePersistableUriPermission(uri, data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String name = "Minha pasta";
            Uri document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri));
            try (Cursor cursor = getContext().getContentResolver().query(document, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) { if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0); }
            JSObject answer = new JSObject(); answer.put("uri", uri.toString()); answer.put("name", name); call.resolve(answer);
        } catch (Exception e) { call.reject("Não foi possível manter acesso à pasta. Escolha uma pasta local ou um provedor compatível.", e); }
    }

    @PluginMethod public void scanFolder(PluginCall call) {
        getBridge().execute(() -> {
            try {
                Uri tree = Uri.parse(Objects.requireNonNull(call.getString("uri")));
                JSArray files = new JSArray();
                scan(tree, DocumentsContract.getTreeDocumentId(tree), files, 0);
                JSObject answer = new JSObject(); answer.put("files", files); call.resolve(answer);
            } catch (Exception e) { call.reject("Não foi possível ler a pasta. Selecione-a novamente para renovar o acesso.", e); }
        });
    }

    private void scan(Uri tree, String parent, JSArray files, int depth) throws Exception {
        if (depth > 12 || files.length() > 10000) throw new IOException("Pasta muito grande ou com muitas subpastas.");
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent);
        String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try (Cursor cursor = getContext().getContentResolver().query(children, columns, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0), name = cursor.getString(1), mime = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) { scan(tree, id, files, depth + 1); continue; }
                Uri document = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                if (name == null) name = "book";
                if (!name.toLowerCase(Locale.ROOT).matches(".*\\.(epub|pdf)$") && !"application/epub+zip".equals(mime) && !"application/pdf".equals(mime)) {
                    // Some providers return no extension and application/octet-stream.
                    // Read only five bytes, then let the importer validate the whole file.
                    try (InputStream input = getContext().getContentResolver().openInputStream(document)) {
                        if (!BookContent.candidate(input)) continue;
                    } catch (IOException | SecurityException ignored) { continue; }
                }
                JSObject item = new JSObject(); item.put("uri", document.toString()); item.put("name", name); item.put("size", cursor.getLong(3)); item.put("modified", cursor.getString(4)); files.put(item);
            }
        }
    }

    @PluginMethod public void readDocument(PluginCall call) {
        getBridge().execute(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(Objects.requireNonNull(call.getString("uri"))))) {
                if (in == null) throw new IOException("Arquivo indisponível.");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[32768]; int n;
                while ((n = in.read(buffer)) != -1) { if (bytes.size() + (long)n > MAX_FILE) throw new IOException("O limite por livro é 64 MB."); bytes.write(buffer, 0, n); }
                JSObject answer = new JSObject(); answer.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)); call.resolve(answer);
            } catch (Exception e) { call.reject("Não foi possível abrir o livro: " + e.getMessage(), e); }
        });
    }

    @PluginMethod public void saveDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType(call.getString("mime", "application/octet-stream")); intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "livro.epub"));
        startActivityForResult(call, intent, "documentCreated");
    }

    @ActivityCallback private void documentCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("Arquivo não salvo: seleção cancelada."); return; }
        Uri uri = result.getData().getData();
        getBridge().execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("Destino indisponível.");
                out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
                JSObject answer = new JSObject(); answer.put("uri", uri.toString()); call.resolve(answer);
            } catch (Exception e) { call.reject("Não foi possível salvar o arquivo no destino escolhido.", e); }
        });
    }

    @PluginMethod public void startDelivery(PluginCall call) {
        try {
            stop();
            List<DeliveryServer.Entry> entries = new ArrayList<>();
            JSArray files = call.getArray("files");
            if (files == null) {
                files = new JSArray();
                JSObject single = new JSObject(); single.put("path", call.getString("path")); single.put("name", call.getString("name", "book.epub")); single.put("mime", call.getString("mime", "application/epub+zip")); single.put("title", call.getString("name", "book.epub")); files.put(single);
            }
            for (int i = 0; i < files.length(); i++) {
                org.json.JSONObject item = files.getJSONObject(i);
                File file = new File(getContext().getCacheDir(), item.getString("path")).getCanonicalFile();
                if (!file.getPath().startsWith(getContext().getCacheDir().getCanonicalPath() + File.separator) || !file.isFile()) throw new IOException("Invalid delivery file");
                entries.add(new DeliveryServer.Entry(file, item.getString("name"), item.optString("mime", "application/epub+zip"), item.optString("title", item.getString("name"))));
            }
            Map<String, String> labels = new HashMap<>();
            JSObject values = call.getObject("labels");
            if (values != null) { Iterator<String> keys = values.keys(); while (keys.hasNext()) { String key = keys.next(); labels.put(key, values.getString(key)); } }
            String locale = call.getString("locale", "en-GB");
            try { delivery = new DeliveryServer(entries, locale, labels, 8080); }
            catch (BindException e) { delivery = new DeliveryServer(entries, locale, labels, 0); }
            JSArray urls = new JSArray();
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback()) continue;
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address && address.isSiteLocalAddress()) urls.put("http://" + address.getHostAddress() + ":" + delivery.port());
                }
            }
            if (urls.length() == 0) { stop(); throw new IOException("Conecte-se ao Wi-Fi ou ative o hotspot e tente novamente."); }
            getActivity().runOnUiThread(() -> getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
            JSObject answer = new JSObject(); answer.put("urls", urls); answer.put("code", delivery.code()); answer.put("port", delivery.port()); call.resolve(answer);
        } catch (Exception e) { call.reject("Não foi possível iniciar o envio: " + e.getMessage(), e); }
    }

    @PluginMethod public void stopDelivery(PluginCall call) { stop(); call.resolve(); }
    private void stop() {
        if (delivery != null) { delivery.close(); delivery = null; }
        if (getActivity() != null) getActivity().runOnUiThread(() -> getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
    }
    @Override protected void handleOnPause() { stop(); notifyListeners("deliveryStopped", new JSObject()); }
    @Override protected void handleOnDestroy() { stop(); }

}
