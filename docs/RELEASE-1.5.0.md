Photon 1.5.0 for Windows, Mac and Android. This release is about security: Photon now has a proper sign-in, and it runs with fewer rights on Windows and Mac.

**Downloads**
- **Windows 10/11:** `Photon-Setup-1.5.0.exe`
- **macOS 11+ (Apple silicon and Intel):** `Photon-1.5.0.pkg`
- **Android 8+ phone or tablet:** `Photon-1.5.0.apk`

See [Installing Photon](https://github.com/vladdemorcy/photon/blob/main/docs/INSTALL.md) and [Troubleshooting](https://github.com/vladdemorcy/photon/blob/main/docs/TROUBLESHOOTING.md).

**Signing in**
- The Windows and Mac installers ask you to choose a password. Updating lets you keep it or pick a new one, and running the installer again is also how you reset a forgotten one.
- Each browser stays signed in with a session cookie that page scripts can't read and other websites can't send (HttpOnly, SameSite=Strict). It lasts 30 days from the last time you used it, and 180 days at most.
- Every change also needs a token only Photon's own page has. Another website, or another program running on the same computer, can't change settings, reset anything or sign anyone out.
- The password is stored only as a salted scrypt hash, in its own file. Passwords need 10 characters, and very common ones are refused. Wrong passwords are slowed down, and five in a row lock that device out for 15 minutes.
- Without a password yet (running Photon by hand, or the Android app), Photon asks for one together with a one-time setup code that only someone with access to that computer or phone can read. The Android app fills the code in for you.
- **Fingerprint or face in the Android app:** after signing in with the password once, the app can use the phone's fingerprint or face instead. The key it uses only unlocks after a strong biometric match (Android's keystore enforces it), only works on that phone, and turns off when a fingerprint or face is added, the password changes or everyone is signed out. Android 9 or newer.
- **Connections > Password and sign-in** changes the password (which signs out every other device) or signs out everywhere.

**Other protection**
- Keys and tokens (Plex, lights, TVs) stay on the server. The page only sees that one is saved.
- Photon only answers at this computer's own addresses, which blocks DNS rebinding. Add other names under Secure connection (HTTPS) > Other names, or in `PHOTON_HOSTNAMES`.
- Webhooks are checked against their secret key before Photon reads the rest of the request, with size limits on uploads.
- A content security policy, no framing by other sites, and no referrer sent to other sites. Fonts are now part of Photon rather than loaded from Google.
- **Windows:** the service runs as Local Service with its own service identity instead of SYSTEM, without the impersonation privilege, and only uses a Node.js from Program Files. The program folder is locked so only administrators can change it.
- **Mac:** the service runs under its own hidden `_photon` account instead of root.
- Updated packages (ws, node-forge). npm still lists one advisory for node-forge's RSA signature checking, which has no fix yet. Photon never checks signatures with node-forge (it only uses it to make its HTTPS certificates and read .pfx files), so it doesn't affect Photon.

**Also new**
- **Download settings** under Connections > Saved versions saves everything, keys included, after you type your password. Use it to move Photon to another computer or phone.

**If you use scripts or tools with Photon:** changes now need a signed-in session. Webhooks from Plex, Jellyfin and Emby keep working as before. `UI_PASSWORD` becomes the sign-in password the first time, if it's long enough.

The installers aren't code-signed, so Windows SmartScreen and macOS Gatekeeper ask once before running them. The Android app isn't from the Play Store, so Android asks to allow installs from your browser, and Play Protect may ask you to confirm.
