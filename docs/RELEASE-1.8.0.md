Photon 1.8.0 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.8.0.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.8.0.pkg`
- **Android 8+ phone or tablet:** `Photon-1.8.0.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**New: Wyze lights**
- Wyze Bulb, Bulb Color, Light Strip and Light Strip Pro, plus Wyze plugs with a lamp, under Connections > Lights.
- Color bulbs and light strips take colors and white; the original Wyze Bulb takes brightness and white. When playback stops, each light goes back to how it was.
- Setup: create a free API key at developer-api-console.wyze.com, then enter it with its key ID and your Wyze email and password, and click "Sign in to Wyze". Accounts with two-step verification are supported: Photon asks for the code from your authenticator app or text message.
- Wyze lights only take commands through Wyze's cloud, so changes land about a second later than lights Photon controls on your network.
- Photon keeps the Wyze session in a private file next to its settings and renews it by itself. For accounts with two-step verification it never signs in on its own in the background, so you won't get surprise texts; if Wyze ends the session, Photon asks you to click "Sign in to Wyze" again.

**Fixed**
- On phones, a room's name no longer shrinks to a few letters while something is playing. What's playing now sits on its own line below the name.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
