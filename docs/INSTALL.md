# Installing Photon

Photon runs on one device at home and you open it in a browser from any phone or computer on your network. That device can be a Windows PC or Mac (often the one that runs your media server), or a spare Android phone or tablet that stays at home. Download the installer for it from the **Releases** page of this repository.

## Windows 10 and 11

1. Download **Photon-Setup-x.y.z.exe** from the latest release.
2. Run it and say yes to the admin prompt. If SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. (The installer isn't code-signed.)
3. Go through the setup window. The defaults are fine for most homes:
   - **Install folder:** `C:\Program Files\Photon`
   - **Port:** 8787
   - **Let other devices on my network open Photon:** on (adds firewall rules for your home network only)
   - **Desktop icon:** on
4. Setup installs Node.js if needed, installs Photon as a Windows service named **Photon**, and opens it in your browser.

Photon starts with the computer and keeps running when nobody is signed in. Open it from the Start menu or desktop icon, or from another device at `http://<that computer's IP>:8787`.

Settings live in `C:\ProgramData\Photon`, separate from the program, so updates never touch them.

## Mac (macOS 11 or newer, Apple silicon or Intel)

1. Download **Photon-x.y.z.pkg** from the latest release.
2. The first time, right-click the pkg and choose **Open** (or open it, then go to System Settings > Privacy & Security and click **Open Anyway**). The installer isn't signed with an Apple Developer ID, so macOS asks once.
3. Follow the steps and enter your admin password. The installer needs internet access the first time to download Node.js from nodejs.org.
4. Photon opens in your browser when it's done. Later, open it with **Photon** in Applications.

Photon runs as a background service (`com.photon.server`) that starts with the Mac. Settings live in `/Library/Application Support/Photon`.

## Android phone or tablet

Use this to run Photon without a computer that's always on. It works best on a spare phone or tablet that **stays at home, on Wi-Fi and plugged in**, because Photon stops following what's playing when the device leaves the house or its battery runs out. Needs Android 8 or newer.

1. On the phone, download **Photon-x.y.z.apk** from the latest release. (Signed in to GitHub in the phone's browser, since the repository is private. You can also download it on a computer and copy it over.)
2. Open the downloaded file. Android asks to allow installs from your browser or Files app the first time: tap **Settings**, turn on **Allow from this source**, and go back.
3. Tap **Install**. Google Play Protect may say it doesn't recognize the app, because it isn't from the Play Store. Choose **More details**, then **Install anyway**.
4. Open **Photon**. It starts right away and asks to show notifications. Say **Allow**, so you can see Photon's address and its Stop button in the notification shade.
5. Tap **Let Photon run in the background** and choose **Allow**. Without this, Android may pause Photon when the screen is off.
6. Tap **Open Photon** to set it up on the phone, or use the address the app shows (like `http://192.168.1.50:8787`) from any computer, phone or tablet at home. Setup is the same as on a computer (below).

Photon runs as a background service with a notification while it's running, and starts again by itself when the phone restarts (you can turn that off in the app). Its settings stay on the phone.

**Moving from a computer:** stop Photon on the computer first so the two don't both control your lights. Copy its `config.json` (`C:\ProgramData\Photon` on Windows, `/Library/Application Support/Photon` on a Mac) to the phone, then in Photon on the phone go to **Connections > Saved versions > Import settings from another Photon**. If you use Plex webhooks, Photon updates the address to the phone's for you.

**Give the phone a fixed address.** Set a DHCP reservation for it in your router, so the address you bookmark and Plex's webhook keep working.

## First-time setup in Photon

1. **Connections > Lights:** turn on each lighting system you have and pair or sign in (Hue: press the bridge button, then *Pair*).
2. **Connections > Media server:** click *Sign in with Plex* (or set up Jellyfin or Emby). Photon adds its Plex webhook to your account for you if you have Plex Pass.
3. **Connections > Smart TVs (optional):** turn on Roku, LG, Android TV / Fire TV, Chromecast, Vizio or Samsung to follow any app on the TV, not just Plex.
4. **Rooms:** make a room, drag its lights onto the floor plan, and pick the player (TV or streaming box) in that room. The default behaviors dim the lights on play, bring them up on pause and put them back on stop. Change any of them per event and time of day.

## Updating

Download the newer installer and run it. It upgrades in place and keeps your rooms, lights, sign-ins and settings. On Android, open the newer APK and tap **Update**; Photon restarts by itself. Photon also saves a copy of your settings every time it starts, so an update can always be undone under **Connections > Saved versions**.

## Removing

- **Windows:** Settings > Apps > Photon > Uninstall. You can keep or delete your settings.
- **Mac:** Applications > Utilities > **Uninstall Photon**. You can keep or delete your settings.
- **Android:** hold the Photon icon and choose **Uninstall** (or Settings > Apps > Photon > Uninstall). This deletes Photon's settings on the phone, so save a copy first if you might want them back: on a computer at home, open Photon and use your browser to save `http://<phone address>:8787/api/config`.
