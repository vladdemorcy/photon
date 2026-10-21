# Troubleshooting Photon

Start with these two pages in Photon:

- **Activity** shows every event Photon received and what it did, including errors.
- **`http://<photon address>:8787/api/diagnostics`** shows the version, how long Photon has been running, recent crashes and the end of its log files.

On Android, the Photon app's main screen also says whether Photon is running and what address to use.

## Photon won't open in the browser

- **On the same computer**, try `http://localhost:8787`. If that works but other devices can't reach it, it's the firewall: on Windows, run the installer again with "Let other devices on my network open Photon" turned on; on a Mac, allow incoming connections for `node` in System Settings > Network > Firewall.
- **Is the service running?**
  - Windows: open an admin PowerShell and run `Get-Service Photon`. Start it with `Start-Service Photon`.
  - Mac: `sudo launchctl print system/com.photon.server`. Restart it with `sudo launchctl kickstart -k system/com.photon.server`.
- **Logs:**
  - Windows: `C:\ProgramData\Photon\logs\photon.log` (open Notepad as administrator to read it).
  - Mac: `sudo tail -f "/Library/Application Support/Photon/logs/photon.log"`.

## Signing in

- **Forgot the password:** on Windows or a Mac, run the installer again and choose a new one. Your rooms and settings stay. Running Photon by hand: `node src/password.js set`. On Android, see *Forgot your password?* in [Installing Photon](INSTALL.md).
- **"Too many wrong tries":** after five wrong passwords in a row, that device has to wait 15 minutes. Other devices can still sign in.
- **Signed out on a device you use often:** sessions end 30 days after you last used Photon on that device, and after 180 days in any case. Changing the password, or *Sign out everywhere*, also signs every other device out.
- **It asks for a setup code:** Photon has no password yet. The code is printed when Photon starts and saved in the `setup-code` file next to its settings (`C:\ProgramData\Photon` on Windows, `/Library/Application Support/Photon` on a Mac, read it with `sudo cat`). The installers fill it in for you when they open Photon.
- **"Photon only answers at this computer's own addresses":** you opened Photon by a name it doesn't know, such as a name from your router's DNS or a reverse proxy. Use its IP address, or add the name under **Settings > Secure connection (HTTPS) > Other names**. Photon refuses unknown names so that a website can't point its own name at your network and talk to Photon.
- **The Android app asks for the password instead of a fingerprint:** fingerprint or face sign-in turns itself off when a fingerprint or face is added to or removed from the phone, when Photon's password changes, and after *Sign out everywhere*. Sign in with the password and say OK when it offers fingerprint or face again. If it never offers, check that the phone has a screen lock and a fingerprint or face set up (Android 9 or newer); some phones' face unlock isn't secure enough for apps, and then only fingerprints work.
- **A script or tool that used to change Photon's settings stopped working:** changes now need a signed-in session and the page's CSRF token. Webhooks from Plex, Jellyfin and Emby aren't affected, since they use their secret key instead.

## "Changes aren't being saved" banner

Photon couldn't read its settings file, so it refuses to save over it (to protect your setup). Run the installer again; it repairs the settings folder's permissions. On Windows you can also run this in an admin PowerShell:

```
takeown /F C:\ProgramData\Photon /R /A /D Y
icacls "C:\ProgramData\Photon\*" /reset /T /C /Q
Restart-Service Photon
```

## My rooms or settings disappeared after an update

Nothing is deleted on update. Go to **Settings > Saved versions** and restore the newest version that lists your rooms. If you used to run Photon by hand from a folder, use **Import settings from another Photon** and pick that folder's `data\config.json`.

## The installer flashes and closes (Windows)

The details are saved in `%TEMP%\Photon-Setup-error.txt`. Run the installer again; if it still fails, that file says why.

## "Photon is also running on" warning

Photon found another copy of itself on your network, on the computer or phone it names. Two Photons both react to the same players and set the same lights, so the lights flicker or end up in the wrong state. Keep one: stop or uninstall the other (on Windows, Settings > Apps > Photon; on a Mac, Uninstall Photon in Applications > Utilities; on Android, Stop Photon in the app or uninstall it). The warning goes away about two minutes after the other one stops. *Hide for now* hides it in that browser until you close it.

Photons find each other with a small broadcast on UDP port 47883 every 30 seconds. It holds no keys or settings, only the device's name, its kind, Photon's version and which lighting systems are turned on.

## Lights don't react when something plays

1. Open **Activity** and start something playing.
   - **Nothing shows up:** Photon isn't hearing from the player. See the media server or TVs and players sections below.
   - **"isn't in a room yet":** add that player to a room (Activity has an *Add to a room* menu next to it).
   - **"ignored, X only reacts to …":** the room's *React to* setting excludes that kind of media or that person. Change it under the room's settings.
   - **"no behavior matches right now":** a time-of-day schedule excludes the current time, or the behavior for that event is turned off.
2. In the room, click **Run on real lights** for an event to test the lights themselves.

## Plex

- **Casting from a phone** works through server watching (no Plex Pass needed). Make sure *Watch playback on my server* is on.
- **Only Plex Home users** trigger lights when *Only react to people in my Plex Home* is on.
- **Webhook:** needs Plex Pass on the owner's account. The Plex card shows whether Photon set it up.
- **"Can't read playback from your Plex server":** type the server's address (for example `http://192.168.1.10:32400`) in the Plex card.
- **No Plex server (free Plex account):** the Plex connection needs your own Plex Media Server. Plex's free movies, shows and Live TV stream from Plex's servers, which Photon can't see. Turn on your TV under **Connections > TVs and players** and use the TV as the room's player instead. See [No Plex server?](../README.md#no-plex-server) in the README for what each kind of TV reports.

## TVs and players

Open the TV's card under **Connections > TVs and players**. It shows what each TV reported on the last check, or the exact problem.

- **Roku: "Limited" mode.** Newer Rokus block reading what's playing. On each Roku: Settings > System > Advanced system settings > Control by mobile apps > Network access > **Default** (or Permissive).
- **Roku or TV not found.** Make sure it's on and on the same network as Photon, then click *Find on my network*, or type its IP address in the card.
- **Kodi: "wants a username and password".** The username and password in Photon must match Kodi's Settings > Services > Control. Kodi 19 and newer won't answer without a password.
- **Kodi not found.** Turn on *Allow remote control via HTTP* (Settings > Services > Control) and *Announce services to other systems* (Settings > Services > General), or just type its IP address. If you changed Kodi's web server port, put the same port in Photon. A Kodi that's closed doesn't answer, so it shows as stopped.
- **LG:** click *Pair* and choose *Accept* on the TV. Turn on "TV On With Mobile" (or "Mobile TV On") in the TV's settings.
- **Android TV / Fire TV:** turn on developer options and ADB or network debugging on the TV, then click *Pair* and choose *Allow* with "Always allow" ticked.
- **Vizio and Samsung** only report on/off, not play or pause. For real play and pause, cast to them or use their Plex app.
- **"Not answering (off, asleep or unplugged)"** is normal while the TV is off.

## Lights

- **Hue:** if pairing fails, press the round button on the bridge and click *Pair* within 30 seconds.
- **Govee:** turn on *LAN Control* for each light in the Govee app, or add a cloud API key.
- **IKEA:** click *Pair*, then press the button on the bottom of the DIRIGERA hub within a minute.
- **Lutron Caseta:** click *Pair*, then press the small black button on the back of the bridge.
- **Smart Life (Treatlife, Gosund):** if Photon says the Tuya plan expired, extend it at platform.tuya.com (Cloud > Cloud Services > IoT Core).
- **Gosund or Treatlife lights don't show up:** Photon only sees lights in the Smart Life app linked to your Tuya cloud project. Lights still in the Gosund or Treatlife app have to be added to Smart Life (reset the light, then add it there). Gosund says it can't move devices between apps for you.
- **Wyze: "refused the sign-in".** Check the email and password you use in the Wyze app, and that the API key and key ID come from the same key at developer-api-console.wyze.com. Wyze shows the API key only once, so if you lost it, make a new key.
- **Wyze: "needs you to sign in again".** Click *Sign in to Wyze*. Accounts with two-step verification need the code each time, so Photon never signs in on its own for them.
- **Wyze lights are slow or skip a change.** Wyze lights only take commands through Wyze's cloud, which adds about a second, and Wyze limits how often an account can send commands. A light that's switched off at the wall shows as offline.
- **Yeelight not found:** turn on *LAN Control* for each light in the Yeelight app (open the light, tap the settings icon, then LAN Control). Lights set up in Mi Home have the same switch there. If the light is on a different part of your network than Photon (a guest network, or another subnet), type its IP in the Yeelight card.
- **Yeelight: "refused the connection":** LAN Control is off for that light, or it was reset. Turn LAN Control back on in the Yeelight app.
- **Yeelight: "too many commands":** Yeelights accept about one command a second. Photon stays well under that, but another app or automation controlling the same light at the same time can use up the allowance. It recovers within a minute.

## Android

- **Photon stops when the screen turns off, or stops after a while:** in the Photon app, tap **Let Photon run in the background**. Some phones (Samsung, Xiaomi, OnePlus, Huawei) have their own battery savers on top of Android's. On Samsung, go to Settings > Battery > Background usage limits and make sure Photon isn't under *Sleeping apps* or *Deep sleeping apps*, then add it to *Never sleeping apps*. For other brands, look up your phone at dontkillmyapp.com.
- **"Photon isn't answering" in the app:** it's restarting after a problem. Wait a minute. If it stays that way, tap **Stop Photon**, then **Start Photon**. If it keeps happening, open `/api/diagnostics` from a computer, or look in the app's notification for a message.
- **No notification:** turn on notifications for Photon in the app (or Settings > Apps > Photon > Notifications). Photon runs either way, but the notification shows that it's running and has a Stop button.
- **Another computer or tablet can't open Photon on the phone:** that's on purpose. On a phone, Photon only opens in the Photon app on the phone itself, so your password never travels over the network. Webhooks from your media server still reach it.
- **Webhooks stopped after the phone's address changed:** give the phone a fixed address with a DHCP reservation in your router. Photon updates the Plex webhook by itself; update Jellyfin or Emby by hand.
- **Lights or TVs aren't found automatically:** type their IP addresses in the Photon card for them. Some Wi-Fi networks block the broadcast messages used for finding devices.
- **Installing an update fails with "App not installed" or "conflicts with an existing package":** the new APK was signed with a different key from the one already on the phone. Only install APKs from this repository's Releases page.
- **Use this device's location** (under **Settings > Your location**) doesn't work inside the app. Type the latitude and longitude, or open `http://localhost:8787` in the phone's own browser and use the button there.

## Still stuck?

Open an issue in this repository with what Photon's card or Activity says, and the output of `/api/diagnostics` (remove any IP addresses you'd rather not share).
