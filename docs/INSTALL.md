# Installing Photon

Photon runs on one computer at home (often the one that runs your media server) and you open it in a browser from any phone or computer on your network. Download the installer for your computer from the **Releases** page of this repository.

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

## First-time setup in Photon

1. **Connections > Lights:** turn on each lighting system you have and pair or sign in (Hue: press the bridge button, then *Pair*).
2. **Connections > Media server:** click *Sign in with Plex* (or set up Jellyfin or Emby). Photon adds its Plex webhook to your account for you if you have Plex Pass.
3. **Connections > Smart TVs (optional):** turn on Roku, LG, Android TV / Fire TV, Chromecast, Vizio or Samsung to follow any app on the TV, not just Plex.
4. **Rooms:** make a room, drag its lights onto the floor plan, and pick the player (TV or streaming box) in that room. The default behaviors dim the lights on play, bring them up on pause and put them back on stop. Change any of them per event and time of day.

## Updating

Download the newer installer and run it. It upgrades in place and keeps your rooms, lights, sign-ins and settings. Photon also saves a copy of your settings every time it starts, so an update can always be undone under **Connections > Saved versions**.

## Removing

- **Windows:** Settings > Apps > Photon > Uninstall. You can keep or delete your settings.
- **Mac:** Applications > Utilities > **Uninstall Photon**. You can keep or delete your settings.
