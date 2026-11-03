<img src="public/icon.png" width="72" alt="Kobo Book Manager icon" />

# Kobo Book Manager

I made this to solve my own book-management problem. My usual routine was to convert EPUBs, put them in Google Drive, and download them on my Kobo Libra Colour, but the Kobo Clara doesn't have that Drive integration that Libra has.

I wanted the simplicity of having editing + conversion + transfer capabilities all on my phone, so I built a small Android app to edit books and covers, convert EPUBs to KEPUB, and send them to a Kobo over Wi-Fi or a hotspot.

It's something I use myself, shared in case it helps someone else too. — **yujilik**

## Use

- [Download and install the APK](https://github.com/Yujilik/KoboBookManager/releases) on **Android 7+**. 
- On **iPhone (iOS 16+)**, download the `.ipa` from the same [releases page](https://github.com/Yujilik/KoboBookManager/releases) and follow [Install on iPhone](#install-on-iphone). 
- Import your books, make your edits, then use **Export & send**. 
- For a PDF, choose **EPUB**, **KEPUB**, or **PDF (original)** in **Export & send**. EPUB/KEPUB conversion creates selectable text whose font, size and spacing can be changed in the reader, with illustrations kept separately. Page layout can change. Text keeps its Unicode and language tags, including mixed Chinese, Japanese, Korean and Thai; set the primary language in **Details** when needed. Supported missing character maps are repaired locally. Scanned or unreadable pages use offline text recognition automatically. Open **Text recognition languages (OCR)** to select the languages present in those pages: English, Japanese, simplified/traditional Chinese, Korean, Thai, Russian, Portuguese or Spanish. Recognition can take several minutes and may make mistakes; your books are never uploaded. Source-page references are grouped at the end of each chapter, with return links to the adjustable text. Decorative title/imprint pages and uncertain ornamental initials may retain their original image. Conversion keeps the original PDF and uses reader fonts instead of embedding the PDF typefaces.
- PDF links and chapter navigation are rebuilt from bookmarks, named destinations, link annotations and detected contents/headings. Reading files are grouped into real chapters, with the available titles and hierarchy. Physical PDF pages keep their anchors in the separate page list. Repeated page furniture and physical line-wrap hyphens are removed conservatively. Links point to text anchors so they continue to work when font size or spacing changes.
- **Change cover** works for PDF, EPUB and KEPUB. The selected image is embedded in every exported/delivered copy. PDFs stay PDFs: a cover page is added before all original pages, with source text and fonts preserved. For EPUB/KEPUB, both the cover metadata and cover page use the chosen image, including when converting from PDF. The source file stays unchanged.
- On your Kobo, open the new copy and enable **Show current read** under **Energy saving and privacy** for its cover to appear while sleeping or powered off. If an older copy is already imported, remove it and import the new copy to refresh cached covers. Wi-Fi browser delivery cannot directly update the Kobo's thumbnail cache or its sleep settings.
- For delivery, keep the app open and connect your Kobo to the same Wi-Fi or hotspot. 
- The app shows the address and code to use in the Kobo's browser.

### Install on iPhone

The app isn't on the App Store, so you install the `.ipa` yourself with a free Apple ID. You need a computer (Windows or Mac) and a cable, once.

1. Download `KoboBookManager-x.y.z.ipa` from the [releases page](https://github.com/Yujilik/KoboBookManager/releases).
2. Install [Sideloadly](https://sideloadly.io) on your computer and connect your iPhone with a cable. If the iPhone asks, tap **Trust This Computer**.
3. Open Sideloadly, drop the `.ipa` into it, type your Apple ID and press **Start**. Your Apple ID is only used to sign the app for your own phone. If it says the app ID is unavailable, tick **Change bundle ID** in the advanced options and try again.
4. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** and restart when asked. The option appears after the first install.
5. Go to **Settings → General → VPN & Device Management**, tap your Apple ID under **Developer App** and choose **Trust**.
6. Open **Kobo Book Manager**.

With a free Apple ID the app stops opening after 7 days. Install it again the same way, over the existing app, to renew it. Your library stays, as long as you don't delete the app.

---

## Build

Ignore this part if you're only here to download and use the app. =)

Requires Node 22.13+ or 24+. Android needs Android Studio, JDK 21 and Android SDK 36. iOS needs a Mac with Xcode 26+.

```powershell
npm ci
npm run dev                 # browser preview
.\scripts\build-android.ps1  # tests + debug-signed APK in artifacts/
```

iOS, on a Mac:

```sh
npm ci
./scripts/build-ios.sh        # tests + unsigned IPA in artifacts/ (users sign it when sideloading)
./scripts/test-ios-native.sh  # only the Swift unit tests; the Command Line Tools are enough
npm run ios:sync && npm run ios:open  # run on your own iPhone: pick your team under Signing & Capabilities
```

## Credits & licence

MIT — see [LICENSE](LICENSE). Conversion uses [PDF.js](https://github.com/mozilla/pdf.js) and [kepubify](https://github.com/pgaskin/kepubify); bundled dependencies retain their [notices](public/vendor/THIRD_PARTY_NOTICES.txt). Independent project, not affiliated with Rakuten Kobo.
