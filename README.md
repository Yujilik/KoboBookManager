<img src="public/icon.png" width="72" alt="Kobo Book Manager icon" />

# Kobo Book Manager

I made this to solve my own book-management problem. My usual routine was to convert EPUBs, put them in Google Drive, and download them on my Kobo Libra Colour, but the Kobo Clara doesn't have that Drive integration that Libra has.

I wanted the simplicity of having editing + conversion + transfer capabilities all on my phone, so I built a small Android app to edit books and covers, convert EPUBs to KEPUB, and send them to a Kobo over Wi-Fi or a hotspot.

It's something I use myself, shared in case it helps someone else too. — **yujilik**

## Use

- [Download and install the APK](https://github.com/Yujilik/KoboBookManager/releases) on **Android 7+**. 
- Import your books, make your edits, then use **Export & send**. 
- For delivery, keep the app open and connect your Kobo to the same Wi-Fi or hotspot. 
- The app shows the address and code to use in the Kobo's browser.

---

## Build

Ignore this part if you're only here to download and use the app. =)

Requires Node 22+, Android Studio, JDK 21 and Android SDK 36.

```powershell
npm ci
npm run dev                 # browser preview
.\scripts\build-android.ps1  # tests + debug-signed APK in artifacts/
```

## Credits & licence

MIT — see [LICENSE](LICENSE). Conversion uses [kepubify](https://github.com/pgaskin/kepubify); bundled dependencies retain their [notices](public/vendor/THIRD_PARTY_NOTICES.txt). Independent project, not affiliated with Rakuten Kobo.
