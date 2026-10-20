# Installing Photon

Photon runs on one device at home. That can be a Windows PC or Mac (often the one that runs your media server), which you then open in a browser from any phone or computer on your network, or a spare Android phone or tablet that stays at home, which you use through the Photon app on it. Download the installer for it from the **Releases** page of this repository.

## Windows 10 and 11

1. Download **Photon-Setup-x.y.z.exe** from the latest release.
2. Run it and say yes to the admin prompt. If SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**. (The installer isn't code-signed.)
3. Go through the setup window. The defaults are fine for most homes:
   - **Install folder:** `C:\Program Files\Photon`
   - **Port:** 8787
   - **Let other devices on my network open Photon:** on (adds firewall rules for your home network only)
   - **Desktop icon:** on
4. Choose the password you'll sign in to Photon with, and type it again. It needs at least 10 characters, and setup tells you if it's too common. A few words together make a strong one that's easy to remember. When you update, you can keep your current password instead.
5. Setup installs Node.js if needed, installs Photon as a Windows service named **Photon**, and opens it in your browser. Sign in with your password.

Photon starts with the computer and keeps running when nobody is signed in. Open it from the Start menu or desktop icon, or from another device at `http://<that computer's IP>:8787`.

Settings live in `C:\ProgramData\Photon`, separate from the program, so updates never touch them.

## Mac (macOS 11 or newer, Apple silicon or Intel)

1. Download **Photon-x.y.z.pkg** from the latest release.
2. The first time, right-click the pkg and choose **Open** (or open it, then go to System Settings > Privacy & Security and click **Open Anyway**). The installer isn't signed with an Apple Developer ID, so macOS asks once.
3. Follow the steps and enter your Mac's admin password. The installer needs internet access the first time to download Node.js from nodejs.org.
4. Photon asks you to choose the password you'll sign in to it with, then asks for it again. (This isn't your Mac's password. Use at least 10 characters.) When you update, you can keep your current one.
5. Photon opens in your browser when it's done. Sign in with your password. Later, open it with **Photon** in Applications.

Photon runs as a background service (`com.photon.server`) that starts with the Mac, under its own hidden account `_photon` rather than as root. Settings live in `/Library/Application Support/Photon`.

## Android phone or tablet

Use this to run Photon without a computer that's always on. It works best on a spare phone or tablet that **stays at home, on Wi-Fi and plugged in**, because Photon stops following what's playing when the device leaves the house or its battery runs out. Needs Android 8 or newer.

1. On the phone, download **Photon-x.y.z.apk** from the latest release. (You can also download it on a computer and copy it over.)
2. Open the downloaded file. Android asks to allow installs from your browser or Files app the first time: tap **Settings**, turn on **Allow from this source**, and go back.
3. Tap **Install**. Google Play Protect may say it doesn't recognize the app, because it isn't from the Play Store. Choose **More details**, then **Install anyway**.
4. Open **Photon**. It starts right away and asks to show notifications. Say **Allow**, so you can see that Photon is running, and its Stop button, in the notification shade.
5. Tap **Let Photon run in the background** and choose **Allow**. Without this, Android may pause Photon when the screen is off.
6. Tap **Open Photon**. The first time, it asks you to choose a password. The one-time setup code it needs is filled in for you, since you're on the phone itself. Setup is the same as on a computer (below). On a phone, Photon only opens in the app itself: other devices at home can't open it, and HTTPS isn't offered, since nothing travels over the network. Your media server can still send its webhooks to the phone.
7. After you sign in with the password, Photon asks whether to use your fingerprint or face next time. Say **OK** and touch the sensor (or look at the phone). From then on the app asks for your fingerprint or face instead of the password. Turn it off or on again under **Settings > Password and sign-in**. It needs Android 9 or newer, a screen lock, and a fingerprint or face set up in the phone's settings.

Photon runs as a background service with a notification while it's running, and starts again by itself when the phone restarts (you can turn that off in the app). Its settings stay on the phone.

**Moving from a computer:** on the computer, open Photon and go to **Settings > Saved versions**, type your password and click **Download settings**. Then stop Photon on the computer so the two don't both control your lights. Copy the downloaded file to the phone, and in Photon on the phone go to **Settings > Saved versions > Import settings from another Photon**. If you use Plex webhooks, Photon updates the address to the phone's for you.

**Give the phone a fixed address.** Set a DHCP reservation for it in your router, so your media server's webhook keeps reaching it. (Photon updates the Plex webhook by itself when the address changes; Jellyfin and Emby webhooks you'd update by hand.)

## First-time setup in Photon

If you ran Photon by hand (not with an installer), the first time you open it, it asks you to choose a password. It needs the one-time setup code that Photon printed when it started, which is also saved in the `setup-code` file next to its settings. That way only someone with access to the computer running Photon can claim it.

1. **Connections > Lights:** turn on each lighting system you have and pair or sign in (Hue: press the bridge button, then *Pair*).
2. **Connections > Media server:** click *Sign in with Plex* (or set up Jellyfin or Emby). Photon adds its Plex webhook to your account for you if you have Plex Pass.
3. **Connections > TVs and players (optional):** turn on Roku, LG, Android TV / Fire TV, Chromecast, Vizio, Samsung or Kodi to follow any app on the TV, not just Plex.
4. **Rooms:** make a room, drag its lights onto the floor plan, and pick the player (TV or streaming box) in that room. The default behaviors dim the lights on play, bring them up on pause and put them back on stop. Change any of them per event and time of day.

## Updating

Download the newer installer and run it. It upgrades in place and keeps your rooms, lights, sign-ins and settings. On Android, open the newer APK and tap **Update**; Photon restarts by itself. Photon also saves a copy of your settings every time it starts, so an update can always be undone under **Settings > Saved versions**.

## Removing

- **Windows:** Settings > Apps > Photon > Uninstall. You can keep or delete your settings.
- **Mac:** Applications > Utilities > **Uninstall Photon**. You can keep or delete your settings.
- **Android:** hold the Photon icon and choose **Uninstall** (or Settings > Apps > Photon > Uninstall). This deletes Photon's settings on the phone, so save a copy first if you might want them back: in the Photon app, go to **Settings > Saved versions**, type your password, tap **Download settings** and choose where to save the file.

## Forgot your password?

- **Windows or Mac:** run the installer again and choose a new password. Your rooms and settings stay as they are. Everyone who was signed in has to sign in again.
- **Android:** there's no installer to run again, so download your settings first if you can still sign in somewhere. Otherwise, Settings > Apps > Photon > Storage > **Clear storage** starts Photon over with a new setup code, without your rooms and settings.
- **Running Photon by hand:** run `node src/password.js set` in Photon's folder, or `node src/password.js reset` to get a new setup code.
