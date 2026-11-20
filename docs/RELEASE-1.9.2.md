Photon 1.9.2 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.9.2.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.9.2.pkg`
- **Android 8+ phone or tablet:** `Photon-1.9.2.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**Fixed: Philips Hue after the latest bridge update**
- Recent Hue bridge updates turn off plain HTTP, so Photon's Hue connection showed "connection refused". Photon now talks to the bridge over HTTPS.
- Your existing pairing carries over. There's nothing to redo: update Photon and your Hue lights work again.
- Photon checks the bridge's certificate against Signify's Hue root certificates, or for older bridges remembers the certificate it first saw and refuses a different one later, so nothing else on your network can pose as the bridge and get its app key. Once a bridge has used HTTPS, Photon never drops back to an unencrypted connection.
- Very old bridges that only speak HTTP still work.
- The Hue Sync Box's link to the bridge (for finding its entertainment area lights) uses the same encrypted connection.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
