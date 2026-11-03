import Foundation
import UIKit
import UniformTypeIdentifiers
import Capacitor

/// iOS implementation of the `KoboNative` plugin (see android/.../KoboNativePlugin.java and src/native.ts).
@objc(KoboNativePlugin)
public class KoboNativePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "KoboNativePlugin"
    public let jsName = "KoboNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "chooseFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDelivery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDelivery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setProcessing", returnType: CAPPluginReturnPromise),
    ]

    private let folders = FolderAccess()
    /// Serial like Android's bridge executor: folder reads, staging checks and delivery never overlap.
    private let work = DispatchQueue(label: "com.yujilik.kobobookmanager.native")
    private let state = NSLock()
    private var delivery: DeliveryServer?
    private var processing = false

    private var folderCall: CAPPluginCall?
    private var folderPicker: UIDocumentPickerViewController?
    private struct PendingSave { let call: CAPPluginCall; let checked: ExportPayload.Checked; let copy: URL; let picker: UIDocumentPickerViewController }
    private var pendingSave: PendingSave?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        processing = false
        stop()
    }

    // MARK: Folders

    @objc func chooseFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { call.reject("Seleção de pasta cancelada."); return }
            self.folderCall?.reject("Seleção de pasta cancelada.")
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            picker.isModalInPresentation = true
            self.folderCall = call
            self.folderPicker = picker
            presenter.present(picker, animated: true)
        }
    }

    private func folderChosen(_ urls: [URL]) {
        guard let call = folderCall else { return }
        folderCall = nil; folderPicker = nil
        guard let url = urls.first else { call.reject("Seleção de pasta cancelada."); return }
        work.async {
            do {
                let folder = try self.folders.register(url)
                call.resolve(["uri": folder.uri, "name": folder.name])
            } catch {
                call.reject("Não foi possível manter acesso à pasta. Escolha uma pasta local ou um provedor compatível.", nil, error)
            }
        }
    }

    @objc func scanFolder(_ call: CAPPluginCall) {
        work.async {
            do {
                guard let uri = call.getString("uri") else { throw KoboError("Missing folder") }
                let files = try self.folders.scan(uri).map { ["uri": $0.uri, "name": $0.name, "size": $0.size, "modified": $0.modified] as [String: Any] }
                call.resolve(["files": files])
            } catch {
                call.reject("Não foi possível ler a pasta. Selecione-a novamente para renovar o acesso.", nil, error)
            }
        }
    }

    @objc func readDocument(_ call: CAPPluginCall) {
        work.async {
            do {
                guard let uri = call.getString("uri") else { throw KoboError("Arquivo indisponível.") }
                let data = try self.folders.read(uri)
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                call.reject("Não foi possível abrir o livro: " + error.localizedDescription, nil, error)
            }
        }
    }

    // MARK: Saving

    @objc func saveDocument(_ call: CAPPluginCall) {
        work.async {
            let checked: ExportPayload.Checked
            let copy: URL
            do {
                checked = try self.checkedOutput(call)
                // The Files exporter names the result after the file it receives, so stage a named copy.
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("save-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let name = (call.getString("name") ?? "book").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
                copy = directory.appendingPathComponent(name)
                // Same volume: a hard link (or an APFS clone) names the file without duplicating up to 512 MB.
                do { try FileManager.default.linkItem(at: checked.file, to: copy) }
                catch { try FileManager.default.copyItem(at: checked.file, to: copy) }
                try ExportPayload.verifyFile(copy, expectedSize: checked.size, expectedHash: checked.sha256)
            } catch {
                call.reject("outputInvalid: " + error.localizedDescription, "OUTPUT_INVALID", error)
                return
            }
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else {
                    self.cleanup(copy); call.reject("Arquivo não salvo: seleção cancelada."); return
                }
                if let previous = self.pendingSave { self.pendingSave = nil; self.cleanup(previous.copy); previous.call.reject("Arquivo não salvo: seleção cancelada.") }
                let picker = UIDocumentPickerViewController(forExporting: [copy], asCopy: true)
                picker.delegate = self
                picker.isModalInPresentation = true
                self.pendingSave = PendingSave(call: call, checked: checked, copy: copy, picker: picker)
                presenter.present(picker, animated: true)
            }
        }
    }

    private func documentSaved(_ urls: [URL]) {
        guard let pending = pendingSave else { return }
        pendingSave = nil
        guard let destination = urls.first else {
            cleanup(pending.copy); pending.call.reject("Arquivo não salvo: seleção cancelada."); return
        }
        work.async {
            defer { self.cleanup(pending.copy) }
            do {
                // Read the committed destination back when the provider allows it, as on Android.
                let scoped = destination.startAccessingSecurityScopedResource()
                defer { if scoped { destination.stopAccessingSecurityScopedResource() } }
                if FileManager.default.isReadableFile(atPath: destination.path) {
                    try ExportPayload.verifyFile(destination, expectedSize: pending.checked.size, expectedHash: pending.checked.sha256)
                } else {
                    try ExportPayload.verifyFile(pending.copy, expectedSize: pending.checked.size, expectedHash: pending.checked.sha256)
                }
                pending.call.resolve(["uri": destination.absoluteString, "size": pending.checked.size, "sha256": pending.checked.sha256])
            } catch {
                let scoped = destination.startAccessingSecurityScopedResource()
                try? FileManager.default.removeItem(at: destination)
                if scoped { destination.stopAccessingSecurityScopedResource() }
                pending.call.reject("Não foi possível salvar o arquivo no destino escolhido: " + error.localizedDescription, nil, error)
            }
        }
    }

    private func cleanup(_ copy: URL) { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }

    /// Same contract as Android: a staged file under the cache directory (Capacitor's Directory.Cache).
    private func checkedOutput(_ options: [AnyHashable: Any]) throws -> ExportPayload.Checked {
        if options["data"] != nil { throw KoboError("Use a staged export instead of a base64 activity payload") }
        guard let number = options["size"] as? NSNumber else { throw KoboError("Output length is missing, zero or too large") }
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return try ExportPayload.validate(cacheDirectory: cache, path: options["path"] as? String, name: options["name"] as? String,
                                          mime: options["mime"] as? String, expectedSize: number.int64Value, expectedHash: options["sha256"] as? String)
    }

    private func checkedOutput(_ call: CAPPluginCall) throws -> ExportPayload.Checked { try checkedOutput(call.options ?? [:]) }

    // MARK: UIDocumentPickerDelegate

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if controller === folderPicker { folderChosen(urls) } else if controller === pendingSave?.picker { documentSaved(urls) }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if controller === folderPicker {
            let call = folderCall; folderCall = nil; folderPicker = nil
            call?.reject("Seleção de pasta cancelada.")
        } else if let pending = pendingSave, controller === pending.picker {
            pendingSave = nil; cleanup(pending.copy)
            pending.call.reject("Arquivo não salvo: seleção cancelada.")
        }
    }

    // MARK: Delivery

    @objc func startDelivery(_ call: CAPPluginCall) {
        work.async {
            var outputsValidated = false
            do {
                self.stop()
                guard let files = call.options?["files"] as? [[AnyHashable: Any]], !files.isEmpty else { throw KoboError("No staged delivery files") }
                var entries: [DeliveryServer.Entry] = []
                var receipts: [[String: Any]] = []
                for item in files {
                    let checked = try self.checkedOutput(item)
                    guard let name = item["name"] as? String else { throw KoboError("Missing output filename or MIME type") }
                    let title = item["title"] as? String ?? name
                    entries.append(DeliveryServer.Entry(file: checked.file, filename: name, mime: checked.mime, title: title, size: checked.size, sha256: checked.sha256))
                    receipts.append(["name": name, "mime": checked.mime, "size": checked.size, "sha256": checked.sha256])
                }
                outputsValidated = true
                var labels: [String: String] = [:]
                for (key, value) in call.getObject("labels") ?? [:] { if let text = value as? String { labels[key] = text } }
                let locale = call.getString("locale") ?? "en-GB"
                let server: DeliveryServer
                do { server = try DeliveryServer(entries: entries, locale: locale, labels: labels, port: 8080) }
                catch is DeliveryServer.BindError { server = try DeliveryServer(entries: entries, locale: locale, labels: labels, port: 0) }
                self.state.lock(); self.delivery = server; self.state.unlock()
                var urls = DeliveryServer.localURLs(port: server.port)
                // Unlike Android, iOS creates the Personal Hotspot interface only once a device has
                // joined it. Its gateway is always 172.20.10.1, and the server listens on every
                // interface, so a Kobo that joins the hotspot afterwards can still use this address.
                if urls.isEmpty { urls = [DeliveryServer.personalHotspotURL(port: server.port)] }
                self.updateKeepAwake()
                call.resolve(["urls": urls, "code": server.code, "port": server.port, "files": receipts])
            } catch {
                self.stop()
                if outputsValidated { call.reject("networkFailed: " + error.localizedDescription, "NETWORK_FAILED", error) }
                else { call.reject("outputInvalid: " + error.localizedDescription, "OUTPUT_INVALID", error) }
            }
        }
    }

    @objc func stopDelivery(_ call: CAPPluginCall) { stop(); call.resolve() }

    @objc func setProcessing(_ call: CAPPluginCall) {
        state.lock(); processing = call.getBool("active") ?? false; state.unlock()
        updateKeepAwake(); call.resolve()
    }

    private func updateKeepAwake() {
        state.lock(); let awake = processing || delivery != nil; state.unlock()
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = awake }
    }

    private func stop() {
        state.lock(); let server = delivery; delivery = nil; state.unlock()
        server?.close()
        updateKeepAwake()
    }

    /// Android stops delivery in onPause; iOS suspends background apps, so stop here as well.
    @objc private func didEnterBackground() {
        stop()
        notifyListeners("deliveryStopped", data: [:])
    }
}
