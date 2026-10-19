Photon 1.5.3 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.5.3.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.5.3.pkg`
- **Android 8+ phone or tablet:** `Photon-1.5.3.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**Android app: Photon stays on the phone**
- Photon's page and settings now only open in the Photon app on the phone itself. Other devices on the network can only reach the webhooks your media server sends, which carry their own secret key. Your password never travels over Wi-Fi.
- So there's no HTTPS option in the app any more; it isn't needed.
- The notification and the app's main screen no longer show a network address. The notification says Photon is running and keeps its Stop button.
- **Download settings** (Settings > Saved versions) now works in the app: Android asks where to save the file.

Photon on Windows and Mac works the same as 1.5.2.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
