import Foundation
import UIKit
import Capacitor

/// iOS implementation of the `AppUpdates` plugin (see src/updates.ts).
@objc(AppUpdatesPlugin)
public class AppUpdatesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppUpdatesPlugin"
    public let jsName = "AppUpdates"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVersion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openRelease", returnType: CAPPluginReturnPromise),
    ]

    @objc func getVersion(_ call: CAPPluginCall) {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            call.reject("updateCheckFailed"); return
        }
        call.resolve(["version": version])
    }

    @objc func openRelease(_ call: CAPPluginCall) {
        let url: URL
        do { url = try UpdatePolicy.release(call.getString("url") ?? "") } catch { call.reject("updateOpenFailed", nil, error); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("updateOpenFailed") }
            }
        }
    }
}
