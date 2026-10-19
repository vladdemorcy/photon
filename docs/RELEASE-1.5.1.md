Photon 1.5.1 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.5.1.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.5.1.pkg`
- **Android 8+ phone or tablet:** `Photon-1.5.1.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**What's new**
- A new **Settings** tab for how Photon itself runs: Password and sign-in (with fingerprint or face in the Android app), Secure connection (HTTPS), Your location, Saved versions and Webhook security.
- **Connections** is now only for connecting things: lights, media servers and Smart TVs.
- On phones, the bottom bar has four tabs: Rooms, Connections, Activity and Settings.
- Fixed: on phones, the page could be slightly wider than the screen, which pushed the bottom bar out of view.
- Making a new webhook key now asks first, since the old webhook addresses stop working.

Everything from 1.5.0 (sign-in with a password, cookie sessions, services with fewer rights, fingerprint or face sign-in on Android) is included. See the [1.5.0 notes](https://github.com/vladdemorcy/photon/releases/tag/v1.5.0).

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
