# Troubleshooting Photon

Start with these two pages in Photon:

- **Activity** shows every event Photon received and what it did, including errors.
- **`http://<photon address>:8787/api/diagnostics`** shows the version, how long Photon has been running, recent crashes and the end of its log files.

## Photon won't open in the browser

- **On the same computer**, try `http://localhost:8787`. If that works but other devices can't reach it, it's the firewall: on Windows, run the installer again with "Let other devices on my network open Photon" turned on; on a Mac, allow incoming connections for `node` in System Settings > Network > Firewall.
- **Is the service running?**
  - Windows: open an admin PowerShell and run `Get-Service Photon`. Start it with `Start-Service Photon`.
  - Mac: `sudo launchctl print system/com.photon.server`. Restart it with `sudo launchctl kickstart -k system/com.photon.server`.
- **Logs:**
  - Windows: `C:\ProgramData\Photon\logs\photon.log` (open Notepad as administrator to read it).
  - Mac: `sudo tail -f "/Library/Application Support/Photon/logs/photon.log"`.

## "Changes aren't being saved" banner

Photon couldn't read its settings file, so it refuses to save over it (to protect your setup). Run the installer again; it repairs the settings folder's permissions. On Windows you can also run this in an admin PowerShell:

```
takeown /F C:\ProgramData\Photon /R /A /D Y
icacls "C:\ProgramData\Photon\*" /reset /T /C /Q
Restart-Service Photon
```

## My rooms or settings disappeared after an update

Nothing is deleted on update. Go to **Connections > Saved versions** and restore the newest version that lists your rooms. If you used to run Photon by hand from a folder, use **Import settings from another Photon** and pick that folder's `data\config.json`.

## The installer flashes and closes (Windows)

The details are saved in `%TEMP%\Photon-Setup-error.txt`. Run the installer again; if it still fails, that file says why.

## Lights don't react when something plays

1. Open **Activity** and start something playing.
   - **Nothing shows up:** Photon isn't hearing from the player. See the media server or Smart TV sections below.
   - **"isn't in a room yet":** add that player to a room (Activity has an *Add to a room* menu next to it).
   - **"ignored, X only reacts to …":** the room's *React to* setting excludes that kind of media or that person. Change it under the room's settings.
   - **"no behavior matches right now":** a time-of-day schedule excludes the current time, or the behavior for that event is turned off.
2. In the room, click **Run on real lights** for an event to test the lights themselves.

## Plex

- **Casting from a phone** works through server watching (no Plex Pass needed). Make sure *Watch playback on my server* is on.
- **Only Plex Home users** trigger lights when *Only react to people in my Plex Home* is on.
- **Webhook:** needs Plex Pass on the owner's account. The Plex card shows whether Photon set it up.
- **"Can't read playback from your Plex server":** type the server's address (for example `http://192.168.1.10:32400`) in the Plex card.

## Smart TVs

Open the TV's card under **Connections > Smart TVs**. It shows what each TV reported on the last check, or the exact problem.

- **Roku: "Limited" mode.** Newer Rokus block reading what's playing. On each Roku: Settings > System > Advanced system settings > Control by mobile apps > Network access > **Default** (or Permissive).
- **Roku or TV not found.** Make sure it's on and on the same network as Photon, then click *Find on my network*, or type its IP address in the card.
- **LG:** click *Pair* and choose *Accept* on the TV. Turn on "TV On With Mobile" (or "Mobile TV On") in the TV's settings.
- **Android TV / Fire TV:** turn on developer options and ADB or network debugging on the TV, then click *Pair* and choose *Allow* with "Always allow" ticked.
- **Vizio and Samsung** only report on/off, not play or pause. For real play and pause, cast to them or use their Plex app.
- **"Not answering (off, asleep or unplugged)"** is normal while the TV is off.

## Lights

- **Hue:** if pairing fails, press the round button on the bridge and click *Pair* within 30 seconds.
- **Govee:** turn on *LAN Control* for each light in the Govee app, or add a cloud API key.
- **IKEA:** click *Pair*, then press the button on the bottom of the DIRIGERA hub within a minute.
- **Lutron Caseta:** click *Pair*, then press the small black button on the back of the bridge.
- **Treatlife / Smart Life:** if Photon says the Tuya plan expired, extend it at platform.tuya.com (Cloud > Cloud Services > IoT Core).

## Still stuck?

Open an issue in this repository with what Photon's card or Activity says, and the output of `/api/diagnostics` (remove any IP addresses you'd rather not share).
