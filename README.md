# Photon

Photon sets each room's lights to match what's playing. When a movie starts on the living room TV, the lights you picked for that room dim down. When you pause, they come up, and when you stop, they go back to how they were. You decide what each event does, and you can make it depend on the time of day.

**Lighting systems:** Philips Hue, Govee, LIFX, WiZ, Nanoleaf, IKEA Home smart (DIRIGERA hub), Treatlife and other Tuya / Smart Life devices, Lutron Caseta, and Home Assistant. Through Home Assistant you can also use Zigbee and Z-Wave bulbs, TP-Link Kasa, Lutron, Sengled, Yeelight, smart plugs with lamps, and anything else HA controls.
**Media servers:** Plex, Jellyfin, Emby
**Smart TVs:** Roku, LG webOS, Android TV / Google TV / Fire TV, Chromecast, Vizio, Samsung

**Download:** get the Windows and Mac installers and the Android app from this repository's **Releases** page. Step-by-step guides: [Installing Photon](docs/INSTALL.md) and [Troubleshooting](docs/TROUBLESHOOTING.md).

You can use more than one of each at the same time. A single room can mix Hue and Govee lights, for example, and respond to both Plex and Jellyfin players.

**Version 1.5.** Photon now has a proper sign-in: you choose a password when you install it, and each browser stays signed in with a secure cookie. See [Signing in and security](#signing-in-and-security). 1.5.1 moves Photon's own options into a new **Settings** tab, so Connections is only for connecting lights, media servers and TVs. 1.4 added Smart TVs (Roku, LG, Android TV / Fire TV, Chromecast, Vizio and Samsung) as players, and 1.4.4 a layout made for phones and touch tablets. 1.3 added Lutron Caseta, 1.2 outdoor spaces. 1.1 added IKEA Home smart and Treatlife / Smart Life lights. The version number is shown next to the Photon name at the top of the app, printed when Photon starts, and available at `/api/version`. It comes from `version` in `package.json`, so that one field is all you change when releasing a new version.

## Install on Windows (easiest)

Run **Photon-Setup-1.5.4.exe** on the computer that should run Photon (often the same one as your media server) and say yes to the admin prompt. Setup:

- **Node.js:** checks for Node.js 18 or newer. If it's missing or too old, setup downloads the current LTS version from nodejs.org, checks it against nodejs.org's published SHA-256 checksums, and installs it to `C:\Program Files\nodejs`.
- **Photon:** installs Photon to `C:\Program Files\Photon`. Everything it needs is included.
- **Password:** asks you to choose the password you sign in to Photon with. When you update, you can keep the current one or choose a new one.
- **Settings:** keeps your settings in `C:\ProgramData\Photon`, where only the Photon service and Administrators can read them, since they hold your sign-in tokens and the password hash. Updating or removing Photon leaves them there. If you ran Photon by hand before, point setup at that folder and it brings your rooms and settings over.
- **Service:** runs Photon as the **Photon** Windows service, so it starts with the computer and restarts itself if it stops. The service runs under Windows' low-rights *Local Service* account with its own service identity, not as SYSTEM, and only uses a Node.js from Program Files. Its logs are in `C:\ProgramData\Photon\logs`.
- **Firewall:** adds firewall rules for your home network only (the web page port, the HTTPS port and Govee's reply port).
- **Shortcuts:** adds a Photon shortcut with the Photon logo to the Start menu and, unless you turn it off, the desktop. Both open Photon in your default browser. Photon also shows up in Settings > Apps, so you can remove it from there.

To update, run a newer Photon-Setup the same way. To remove Photon, use Settings > Apps. You can choose whether to keep your rooms and settings.

**Running setup from a script.** Setup also runs without a window:

```
set PHOTON_PASSWORD=the password you want
Photon-Setup-1.5.4.exe -Quiet [-Port 8787] [-InstallDir "D:\Photon"] [-ImportFrom "D:\old-photon"] [-NoFirewall] [-NoDesktopIcon]
"C:\Program Files\Photon\Uninstall Photon.exe" -Quiet [-DeleteData]
```

The password goes in the `PHOTON_PASSWORD` environment variable rather than on the command line, where other programs could see it. Leave it out and an update keeps the current password, while a new install prints a link with a one-time setup code for choosing one.

Windows SmartScreen may warn that the installer is from an unknown publisher, because it isn't code-signed. Choose *More info*, then *Run anyway*. If you have a code-signing certificate, sign `dist/Photon-Setup-*.exe` with `signtool` after building. To build the installer yourself, run `installer/build.sh` on Linux or macOS with Node.js and NSIS (`makensis`) installed.

## Install on a Mac

Open **Photon-1.5.4.pkg** and follow the steps. It needs macOS 11 or newer, on Apple silicon or Intel, and asks for an admin password. Setup:

- **Node.js:** downloads its own copy from nodejs.org the first time (checked against nodejs.org's checksums) and keeps it in `/Library/Photon/node`, so nothing else on your Mac changes.
- **Photon:** installs to `/Library/Photon` and runs as a background service (a launchd daemon, `com.photon.server`). It starts with the Mac, keeps running when nobody is logged in, and restarts if it stops.
- **Password:** asks you to choose the password you sign in to Photon with (typed twice, hidden). When you update, you can keep it or choose a new one. If you click *Choose it later*, Photon opens in your browser and asks for it there.
- **Service account:** Photon runs under its own hidden account, `_photon`, instead of root. The account can't log in and has no password.
- **Settings:** kept in `/Library/Application Support/Photon`, readable only by the service and admins. Updates never touch them.
- **Apps:** **Photon** in Applications opens Photon in your browser. **Uninstall Photon** is in Applications > Utilities and lets you keep or delete your settings.
- **Firewall:** if the macOS firewall is on, Photon is allowed through it so phones and other computers at home can open it.

To update, open a newer Photon pkg. The installer isn't signed by Apple, so the first time macOS says it can't verify it: right-click the pkg and choose **Open**, or go to System Settings > Privacy & Security and click **Open Anyway**. If something goes wrong, the details are in `/Library/Application Support/Photon/logs/install.log`.

Useful commands in Terminal: `sudo launchctl kickstart -k system/com.photon.server` restarts Photon, and `sudo tail -f "/Library/Application Support/Photon/logs/photon.log"` shows what it's doing.

To build the pkg yourself: `cd installer/mac && ./build-mac.sh` (needs Node.js, Python 3, xar and mkbom, and works on Linux or a Mac).

## Run it by hand

You need Node.js 18 or newer, on a machine that's always on and on the same network as your lights. A NAS, a mini PC, or the Plex server itself all work.

```bash
npm install
npm start
```

Open `http://<that-machine's-IP>:8787` in a browser.

With Docker:

```bash
docker compose up -d --build
```

The compose file uses host networking, because Govee and WiZ find lights with UDP broadcasts that don't get through Docker's default bridge network. Set `TZ` to your time zone so the time-of-day behaviors line up.

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Web UI and webhook port |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `UI_PASSWORD` | none | Older setups used this for a browser password prompt. If Photon has no password yet, it becomes the sign-in password once (if it's at least 10 characters and not a common one). After that, change the password in the app. |
| `PHOTON_HOSTNAMES` | none | Extra names Photon answers to, comma separated, such as `photon.home.lan`. See [Signing in and security](#signing-in-and-security). |
| `CONFIG_PATH` | `./data/config.json` | Where settings are stored. Remembered players are kept next to it in `players.json`. |
| `TZ` | system | Time zone for the time windows |
| `HTTPS_PORT` | from settings (`8443`) | Overrides the HTTPS port set in the app |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | none | Paths to a PEM certificate and key. If set, Photon always uses them, which is handy with Let's Encrypt or a cert managed elsewhere. |

## Setup in three steps

The app walks you through these in order the first time you open it.

### 1. Connect your lights (Connections tab)

Turn on each system you own. Its color is how you'll tell its lights apart on the room plans, and you can change it.

| System | What you need |
|---|---|
| **Philips Hue** | Click *Find bridge* (or type the bridge IP), press the round button on the bridge, then click *Pair* within 30 seconds. |
| **Govee** | In the Govee app, open each light's settings and turn on **LAN Control**. Photon finds those lights by itself. For models without LAN control, add a cloud API key (Govee app → Profile → Settings → Apply for API Key). The cloud API allows about two commands per second per device, so LAN control is faster. |
| **LIFX** | A personal access token from cloud.lifx.com → Settings. |
| **WiZ** | Nothing. Bulbs are found by broadcast. If they're on a different subnet, list their IPs. |
| **Nanoleaf** | Enter the panel IPs. Hold the power button on the controller for 5–7 seconds until the lights flash, then click *Pair*. Your effects show up as scenes. |
| **IKEA Home smart** | Needs the DIRIGERA hub. Enter its IP (IKEA Home smart app → Hub settings, or your router's device list), click *Pair*, then press the action button on the bottom of the hub within a minute. Rooms from the IKEA app show up as groups, IKEA scenes show up as scenes, and smart plugs show up as plugs. The older TRÅDFRI gateway isn't supported directly: pair those bulbs to a Hue Bridge (they work as ordinary Zigbee bulbs there) or use Home Assistant's IKEA TRÅDFRI integration. |
| **Treatlife / Smart Life** | Treatlife bulbs, strips, dimmers, switches and plugs are Tuya devices, so Photon reaches them through Tuya's cloud. Once: make a free account at platform.tuya.com, create a Cloud project (Smart Home, pick your data center), and under *Devices → Link App Account* scan the QR code with the **Smart Life** app (if your devices are in the Treatlife app, add them to Smart Life first; Treatlife's app can't be linked). Copy the project's Access ID and Access Secret into Photon. Tuya's free trial has to be extended every so often from the project page; if Photon says the plan expired, that's why. |
| **Lutron Caseta** | Needs a Caseta Smart Bridge or Smart Bridge Pro (RadioRA 3 works too). Enter the bridge's IP (Lutron app > Settings > Advanced > Integration, or your router's device list), click *Pair*, then press the small black button on the back of the bridge. Photon gets its own certificate from the bridge and keeps it with your settings. Rooms from the Lutron app show up as groups and your Lutron scenes as scenes. Dimmers fade smoothly to the brightness a behavior asks for; switches turn on or off. Caseta has no color, so color settings (including random colors) are skipped for these lights, and their brightness is still used. |
| **Home Assistant** | Your HA URL and a long-lived access token (HA profile → Security). Every `light.*` and `switch.*` entity shows up as a light, and every `scene.*` as a scene. |

### 2. Connect your media server

Each server gets its own webhook address, which you'll see on its card. The address includes a secret key, and you can generate a new key under **Settings > Webhook security**.

**Plex:** click **Sign in with Plex**. A plex.tv window opens, you sign in there, and it closes by itself. Photon only receives a sign-in token, never your password. If you can't use the popup, there's also a field to paste a token. Once you're signed in:
- **Your server:** Photon only reacts to playback on the server you pick. Other servers your account can reach are ignored.
- **People in your Plex Home:** with *Only react to people in my Plex Home* on, which is the default, playback from friends you've shared libraries with is dropped completely. It doesn't change any lights and doesn't show up in Activity.
- **Players:** your Plex players are listed in rooms right away, without waiting for them to play something.
- **Watching your server:** once you're signed in, Photon checks your server's live playback every couple of seconds. It catches everything that plays on your server, however it was started, including **casting from your phone** to a TV or Chromecast. It doesn't need Plex Pass. If Photon can't reach the server by itself, type its address (like `http://192.168.1.10:32400`) under Connections > Plex.
- **Webhook (optional, set up for you):** a Plex webhook makes Photon react a moment faster. It needs Plex Pass on the owner's account. While you're signed in, Photon adds its webhook address to your Plex account by itself and keeps it current: after an update, a new webhook key, or a new IP address for this computer, it swaps out the old Photon address and leaves any other webhooks (Home Assistant, Tautulli and so on) alone. The Plex card shows whether it's set. Turn off *Add Photon's webhook to my Plex account* if you'd rather manage it in Plex Web yourself. Using the webhook and server watching together never makes anything happen twice.
- **Players only from your network:** the player list only shows devices on your home network. That means the ones plex.tv sees at your internet address, plus the ones your server can see on your network right now. Devices in other homes and old devices elsewhere are left out. Hover over a player and click × to hide it. "Show them again" brings hidden players back.
- **Cast devices:** if a TV you cast to shows up under a different ID than the one in your room, Photon still matches it by its name. Any player that isn't in a room yet appears in Activity with an **Add to a room** menu.

**Jellyfin**, either way works, and you can use both:
- *Polling, no plugin:* add the server URL and an API key (Dashboard → API Keys), then turn on *Poll for playback*. Photon checks every 2 seconds.
- *Webhook:* install the **Webhook** plugin from the catalog and restart Jellyfin. Add a *Generic Destination* with Photon's Jellyfin address, tick **Send All Properties**, and choose Playback Start, Playback Progress and Playback Stop. Jellyfin reports pauses through progress events, which Photon turns into pause and resume.

**Emby:** Use polling (URL and API key) or Emby Premiere webhooks with Playback Start, Pause, Unpause and Stop.

### Smart TVs (optional)

Under **Connections > Smart TVs**, Photon can follow whatever is playing on a TV or streaming box, from any app (Netflix, YouTube, Disney+, Prime Video and so on), not only your media server. Turn on the kinds you have, then pick the TV as a room's player like any other.

| TV | What it reports | Setup |
|---|---|---|
| **Roku** (TVs and players) | Play, pause and stop for any app | Nothing to pair. Photon finds Rokus by itself. Newer Rokus ship in *Limited* mode, which blocks this: on each Roku set Settings > System > Advanced system settings > Control by mobile apps > Network access to *Default*. |
| **LG webOS TV** | Play and pause for most apps | Click *Pair* and choose *Accept* on the TV. Turn on "TV On With Mobile" (or "Mobile TV On") in the TV's settings so Photon can reach it. |
| **Android TV / Fire TV** (Google TV, Chromecast with Google TV, Fire TV, NVIDIA Shield, Sony, TCL, Hisense) | Play and pause for every app | One time: turn on developer options and ADB/network debugging on the TV. Type the TV's IP, click *Pair*, and choose *Allow* on the TV with "Always allow" ticked. |
| **Chromecast** (and TVs with Chromecast built in, including most Vizio, Sony, TCL and Hisense TVs) | Play and pause for anything cast from a phone or computer | Nothing to pair. Found by itself. |
| **Vizio** | Only on/off and which input is showing, so "TV on" counts as playing and "TV off" as stopped | Click *Pair*, type the PIN the TV shows, and click *Finish pairing*. For real play and pause on a Vizio, cast to it or use its Plex app. |
| **Samsung TV** | Only on/off, used the same way as Vizio | Nothing to pair. |

Apple TV isn't included: it has no local interface Photon can use for this. A TV that's off or asleep simply shows as stopped.

### 3. Create rooms

- **Lights:** the list on the right is grouped the way your lighting app groups them. That means Hue rooms, IKEA rooms, Home Assistant areas and LIFX groups. Click a room to open it and see its zones and individual lights. A light only appears on its own if it isn't in any room or zone. You can drag a whole room onto the plan or pick out a single zone or light.
  - When you add a whole room, each of its lights appears on the plan so you can place them where they really are, but Photon controls them together as one group.
  - Drag lights around to move them, or drag them back to the list to remove them.
  - Click a light to set its **shape** (bulb, lamp, strip or panel) and its height, or to make it flash so you can find it. Strips and panels can be turned, and strips also get a length, *Line up with nearest wall* and *Behind the TV*. Photon guesses the shape from the product name, so Hue lightstrips, Play gradient, LIFX Z, Govee strips and Nanoleaf panels usually come out right on their own.
- **Furniture:** drag pieces from the Furniture list onto the plan: TV, projector screen, TV stand, sofa, sectional, loveseat, armchair, chair, queen and king beds, nightstand, dresser, coffee table, side table, desk, dining table, bookshelf, rug, plant, door and window. Click a piece to turn it (or press R), resize it, name it, duplicate it or remove it. TVs, doors and windows snap to the nearest wall. New rooms start with a TV, sofa and coffee table. A room named Bedroom starts with a bed and nightstands instead.
- **Outside:** turn on **Outdoor space** in a room's settings for a yard, patio or deck. The plan turns to grass, there are no walls or ceiling, and it can be up to 200 ft across. The Outdoor structures and Yard groups have a pergola, gazebo, fence, deck railing, deck, patio, path, house wall, shed, pool, hot tub, fire pit, table with umbrella, lounge chair, outdoor sofa, grill, tree, shrub, hedge and garden bed. Click a light strip near a fence, railing, house wall, pergola, deck, pool or similar and choose *Run along the …* to line it up with that edge at the usual height.
- **3D:** the **3D** view builds the room from the plan, with the furniture, lamps, strips and panels, all lit the way the selected event would light them.
- **Players:** drag the TVs, streaming boxes or apps that are in this room into *Players in this room*. Any player that has played something shows up in the list.
- **Random colors:** in a behavior, set Color to **Random** and every time it runs, the lights get a new color. That can be any vivid color, or a pick from colors you choose under *My colors*. Turn on *Give each light its own color* to have every light pick its own, including the lights inside a Hue room or Home Assistant area. Otherwise they all share one.
- **Behaviors:** each one has *when playback…* events (starts, paused, resumes, near the end, stops), an optional time window, and what the lights do. The options are set a brightness with a warm-to-cool white or a color, recall a scene, restore how they were before playback, turn off, or leave them alone. **When several behaviors match, the one nearest the top wins**, so put time-limited ones above the general ones and drag to reorder.
- **Time windows** take clock times (`22:30`) or sun events with an offset in minutes (`sunset`, `sunset-30`, `sunrise+15`, `dawn`, `dusk`). Windows can wrap past midnight, and a window that starts Friday night still applies at 1am Saturday. Set your location under Connections so sunrise and sunset are accurate.
- **Show when it…** above the plan previews the lights for each event, based on whichever behavior would run *right now*. **Run on real lights** sends that event to the room as if your media server had, so you can test without starting a movie.

New rooms come with a starter set of behaviors: dim to 8% warm when playback starts, 45% when paused, restore on stop, and "credits" and "daytime: leave alone" behaviors that start switched off.

### Room settings

- **React to:** movies, TV episodes, music, or other (live TV, clips). For example, you could leave music out.
- **Who can trigger this room:** pick people from your Plex Home, for example so only your playback changes the bedroom lights. Jellyfin or Emby user names can be typed in.
- **Wait after stop:** players report a stop between episodes. Photon waits this many seconds, and if the next episode starts in that time, it keeps the current lighting.
- **Remember how the lights were:** saves each light's state when playback starts, so *Restore* can put it back exactly.

If two players in the same room are playing, stopping one leaves the lights alone until the other stops too.

## Secure connection (HTTPS)

Under **Settings > Secure connection (HTTPS)** you can turn on HTTPS in one of two ways. Plain HTTP keeps working alongside it on port 8787.

**Photon's certificate.** Browsers warn about any certificate they don't already trust, and a self-signed one is no exception. So instead, Photon creates its own small certificate authority, valid for 10 years, and uses it to sign a certificate for this machine. That certificate covers localhost, the machine's name, `name.local`, its network IP addresses, and any extra names you add, such as `photon.home.lan`.
- Click **Download Photon's certificate authority** and install it once on each device you open Photon from. The app shows the steps for Windows, Mac, iPhone/iPad, Android, Firefox and Linux. After that, the warning is gone for good.
- Photon renews its certificate before it expires, and again if the machine's IP address changes. Both happen on their own and use the same authority, so you never have to reinstall anything.
- The authority's private key never leaves the machine. It's stored with owner-only permissions in `data/tls`.

**My own certificate.** Upload a certificate and private key as PEM files (plus an optional chain file), or a single `.pfx`/`.p12` file with its password. Photon checks that the key matches the certificate and that it hasn't expired. The certificate has to include the address you type to open Photon.

Other settings:
- **HTTPS port:** defaults to 8443.
- **Always open Photon over HTTPS:** sends browsers from the plain address to the secure one.
- **Webhooks** from Plex, Jellyfin and Emby stay on plain HTTP, so you don't need to change them, and your media server never has to trust Photon's certificate.

Turning on HTTPS also lets **Use this device's location** work from other devices, because browsers only share location with secure pages.

## Connections and Settings

**Connections** is only for connecting things: your lights, media servers and TVs. **Settings** is for how Photon itself runs: **Password and sign-in** (including fingerprint or face in the Android app), **Secure connection (HTTPS)**, **Your location** for sunrise and sunset, **Saved versions** (restore, import and download your settings) and **Webhook security**.

## Signing in and security

**Your password.** The installers ask for it. If you run Photon by hand, the first time you open it Photon asks you to choose one, and for that it wants a one-time **setup code**. The code is printed when Photon starts and saved in the `setup-code` file next to your settings, so only someone with access to the computer running Photon can claim it. Passwords need at least 10 characters, and very common ones are refused. A few words together make a strong password that's easy to remember. Photon keeps only a salted scrypt hash of it, in `auth.json` next to the settings, never in `config.json`.

**Staying signed in.** Signing in gives that browser a session cookie that page scripts can't read and other websites can't make the browser send. It lasts 30 days from the last time you used it, and 180 days at most. Every change also needs a token that only Photon's own page has, so another website, or another program on the same computer, can't change settings, reset anything or sign people out. Wrong passwords are slowed down, and after five in a row from one device it has to wait 15 minutes.

**Change the password or sign everyone out** under **Settings > Password and sign-in**. Changing the password signs out every other device.

**Fingerprint or face in the Android app.** After you sign in with the password in the app, Photon offers to use your fingerprint or face next time (you can also turn it on or off under **Settings > Password and sign-in**). The app keeps a device key that Android's keystore only unlocks right after a strong fingerprint or face match; your fingerprint never leaves Android, and Photon keeps only a hash of the key. The key only works from the phone Photon runs on. Adding a fingerprint or face to the phone, changing Photon's password, or *Sign out everywhere* turns it off, and the app asks for the password once. It needs Android 9 or newer and a screen lock.

**Forgot the password?** Run the installer again and choose a new one. Or, from an admin command prompt (Windows) or Terminal (Mac), run Photon's password tool:

```
# Windows (admin command prompt)
set CONFIG_PATH=C:\ProgramData\Photon\config.json
"C:\Program Files\nodejs\node.exe" "C:\Program Files\Photon\app\src\password.js" set

# Mac
sudo env CONFIG_PATH="/Library/Application Support/Photon/config.json" /Library/Photon/node/bin/node /Library/Photon/app/src/password.js set

# Running by hand
node src/password.js set
```

`password.js reset` removes the password instead, so Photon asks for a new one with a new setup code. On Android, clearing the app's storage does the same, but also clears its settings.

**Keys and tokens stay on the server.** Your Plex token, light keys and TV pairing keys are never sent to the browser. The page sees that one is saved, and that's all.

**Android: only on the phone itself.** When Photon runs in the Android app, its page and settings only open in the app on that phone. Other devices on the network can reach the webhooks (which have their own secret key) and nothing else, so HTTPS isn't offered there.

**Only its own addresses.** Photon answers at localhost, this computer's IP addresses, its name and `name.local`. A request for any other name is refused, which stops a trick called DNS rebinding, where a website points its own name at your network to talk to Photon. If you reach Photon by another name, such as `photon.home.lan` or a reverse proxy's name, add it under **Settings > Secure connection (HTTPS) > Other names**, or list it in `PHOTON_HOSTNAMES`.

**Another Photon on the network.** Each Photon announces itself on the home network every 30 seconds (a UDP broadcast on port 47883, with no keys or settings in it) and shows a warning on every page while it hears another one, since two Photons fight over the same lights.

**Webhooks** don't sign in. They're checked against their secret key before Photon reads anything else from the request.

## Light and dark

The three buttons at the top right switch between **Match this device**, **Light** and **Dark**. Each browser remembers its own choice, so your phone can follow its system setting while your desktop stays dark. The floor plan and 3D view stay dark in both themes so the light previews look the way they will in a dark room.

## Your settings are safe

- **Open in more than one window or device:** if another window or device saves a newer change, a page that's out of date can't overwrite it. That page loads the newer version and tells you. Pages that are just sitting open pick up changes from elsewhere on their own within a few seconds.
- **A time Photon can't read** (say "9pm" instead of 21:00) doesn't block saving. Everything else saves, and that one behavior waits until its time is fixed.
- **Closing the tab right after a change** still saves it. If Photon is restarting while you work, the page keeps trying until the save goes through.
- **Saved versions:** under **Settings > Saved versions**, Photon keeps copies of your rooms, layouts and behaviors. It makes one every 10 minutes while you're making changes, one each time it starts (so there's always a copy from before an update), and one whenever you click *Save a copy now*. Restoring one first saves your current setup as another copy, so a restore can be undone. The copies are kept in `data/backups`, up to the last 60.
- **Moving settings from another Photon:** if you ran Photon by hand before installing it, click *Import settings from another Photon* under **Settings > Saved versions** and pick the `config.json` in the old copy's `data` folder. Rooms, layouts, behaviors, the Plex sign-in, light keys and the webhook address all come across. Updates done with the installer keep your settings on their own, since they live in `C:\ProgramData\Photon` and the installer never touches that folder.

## Activity

The Activity tab shows every event Photon receives and what it did with it. That includes which behavior ran, and any light that failed to respond along with the reason.

## Project layout

```
src/server.js          web server, webhooks, API
src/engine.js          rooms, behaviors, saved light states
src/schedule.js        time windows, sunrise/sunset
src/lighting/*.js      one file per lighting system (same interface)
src/media/*.js         Plex, Jellyfin/Emby, and the event de-duplicator
public/                the web UI (no build step), 3D view in room3d.js, furniture sizes in furniture.js
test/tv-mocks.js       stand-in Roku, LG, Android TV, Chromecast, Vizio and Samsung TVs
test/mocks.js          fake Hue bridge, Home Assistant, IKEA hub, Lutron bridge, Tuya cloud and plex.tv for trying things out (run Photon with PLEX_TV_URL=http://127.0.0.1:8124
                       DIRIGERA_EXTRA_CA=test/fixtures/dirigera-cert.pem LUTRON_EXTRA_CA=test/fixtures/lutron-ca.pem TUYA_BASE_URL=http://127.0.0.1:8125)
```

To add another lighting system, create a file in `src/lighting/` that implements `list`, `apply`, `snapshot` and `restore` (and optionally `scene`), then add it to `src/lighting/index.js`. The UI picks it up automatically.
