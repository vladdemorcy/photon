Photon 1.6.0 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.6.0.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.6.0.pkg`
- **Android 8+ phone or tablet:** `Photon-1.6.0.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**New: TV sync boxes**
- **Philips Hue Play HDMI Sync Box** (and the 8K model): connect it under Connections (type its IP, click Pair, hold the box's button), then pick it in a room under Room settings > TV sync box.
- **Govee sync boxes and camera TV backlights with DreamView:** they show up as sync boxes when your Govee cloud API key is set.
- Photon starts syncing when something starts or resumes and stops it on pause and stop. Each behavior can choose differently: start, stop, or leave it as it is. When playback stops, the box goes back to how it was before.
- While the box syncs, Photon leaves the lights it colors alone (it finds them for you, and you can change the list) and only dims or brightens the room's other lights, so the two never fight.
- Hue Sync Box: mode (automatic picks music mode for music, video for everything else), intensity and brightness per room.
- Photon remembers the Hue Sync Box's certificate when pairing and refuses anything else posing as the box, so its access token only ever goes to your box. The token stays on the server like Photon's other keys.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
