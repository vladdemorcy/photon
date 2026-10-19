Photon 1.5.4 for Windows, Mac and Android.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.5.4.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.5.4.pkg`
- **Android 8+ phone or tablet:** `Photon-1.5.4.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**What's new**
- **A warning when Photon runs on two devices.** If Photon is also running on another computer or phone on your network, every page shows which one (its name, kind of device, address and Photon version), and the Activity log notes it. Two Photons react to the same players and fight over the same lights; the warning says which lighting systems both of them use. *Hide for now* hides it until the browser is closed, and it goes away by itself about two minutes after the other Photon stops.
- Photons find each other with a small broadcast on UDP port 47883 every 30 seconds. It carries no keys or settings, just the device's name, its kind, Photon's version and which lighting systems are on. The Windows installer opens that port for your home network.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
