import UIKit
import Capacitor

/// Registers the app's native plugins and keeps the native canvas in the app's light/dark colours,
/// like MainActivity.applySystemTheme() on Android.
class KoboBridgeViewController: CAPBridgeViewController {
    static let canvas = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x2D / 255, green: 0x35 / 255, blue: 0x3B / 255, alpha: 1)
            : UIColor(red: 0xF8 / 255, green: 0xF7 / 255, blue: 0xF3 / 255, alpha: 1)
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(KoboNativePlugin())
        bridge?.registerPluginInstance(AppUpdatesPlugin())
        view.backgroundColor = Self.canvas
        webView?.isOpaque = false
        webView?.backgroundColor = Self.canvas
        webView?.scrollView.backgroundColor = Self.canvas
    }
}
