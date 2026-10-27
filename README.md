<img src="public/icon.png" width="72" alt="Kobo Book Manager icon" />

# Kobo Book Manager

I made this to solve my own book-management problem. My usual routine was to convert EPUBs, put them in Google Drive, and download them on my Kobo Libra Colour, but the Kobo Clara doesn't have that Drive integration that Libra has.

I wanted the simplicity of having editing + conversion + transfer capabilities all on my phone, so I built a small Android app to edit books and covers, convert EPUBs to KEPUB, and send them to a Kobo over Wi-Fi or a hotspot.

It's something I use myself, shared in case it helps someone else too. — **yujilik**

## Use

- [Download and install the APK](https://github.com/Yujilik/KoboBookManager/releases) on **Android 7+**. 
- Import your books, make your edits, then use **Export & send**. 
- For a PDF, choose **EPUB**, **KEPUB**, or **PDF (original)** in **Export & send**. EPUB/KEPUB conversion creates selectable text whose font, size and spacing can be changed in the reader, with illustrations kept separately. Page layout can change. Text keeps its Unicode and language tags, including mixed Chinese, Japanese, Korean and Thai; set the primary language in **Details** when needed. Supported missing character maps are repaired locally. Scanned or unreadable pages use offline text recognition automatically. Open **Text recognition languages (OCR)** to select the languages present in those pages: English, Japanese, simplified/traditional Chinese, Korean, Thai, Russian, Portuguese or Spanish. Recognition can take several minutes and may make mistakes; your books are never uploaded. Scanned pages also include a **View original page** link, with a return link to the adjustable text, so the source illustrations and layout remain available. Conversion keeps the original PDF and uses reader fonts instead of embedding the PDF typefaces.
- PDF links and chapter navigation are rebuilt from bookmarks, named destinations, link annotations and detected contents/headings. Printed page numbers stay in the separate page list; chapter menus use the available titles and hierarchy. Links point to text anchors so they continue to work when font size or spacing changes.
- **Change cover** works for PDF, EPUB and KEPUB. The selected image is embedded in every exported/delivered copy. PDFs stay PDFs: a cover page is added before all original pages, with source text and fonts preserved. For EPUB/KEPUB, both the cover metadata and cover page use the chosen image, including when converting from PDF. The source file stays unchanged.
- On your Kobo, open the new copy and enable **Show current read** under **Energy saving and privacy** for its cover to appear while sleeping or powered off. If an older copy is already imported, remove it and import the new copy to refresh cached covers. Wi-Fi browser delivery cannot directly update the Kobo's thumbnail cache or its sleep settings.
- For delivery, keep the app open and connect your Kobo to the same Wi-Fi or hotspot. 
- The app shows the address and code to use in the Kobo's browser.

---

## Build

Ignore this part if you're only here to download and use the app. =)

Requires Node 22.13+ or 24+, Android Studio, JDK 21 and Android SDK 36.

```powershell
npm ci
npm run dev                 # browser preview
.\scripts\build-android.ps1  # tests + debug-signed APK in artifacts/
```

## Credits & licence

MIT — see [LICENSE](LICENSE). Conversion uses [PDF.js](https://github.com/mozilla/pdf.js) and [kepubify](https://github.com/pgaskin/kepubify); bundled dependencies retain their [notices](public/vendor/THIRD_PARTY_NOTICES.txt). Independent project, not affiliated with Rakuten Kobo.
