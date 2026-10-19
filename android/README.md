# Photon for Android

The Android app runs the same Photon as the Windows and Mac versions, on a phone or tablet. It's meant for a spare device that stays at home on Wi-Fi and plugged in, so a computer doesn't have to be on all the time. How to install and use it is in [docs/INSTALL.md](../docs/INSTALL.md#android-phone-or-tablet).

## How it works

- **Node.js on the phone.** [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) (Node 18) provides `libnode.so`. A small C bridge (`jni/photon-node.c`) lets Java start it.
- **Photon itself** is packed into `assets/photon.zip`. On first start, and after every update, the app unpacks it into its private storage and runs `android-main.js`. That file handles the few Android differences and then loads `src/server.js` unchanged.
- **A foreground service** (`NodeService`) runs Photon in its own process (`:node`) and shows a notification with Photon's address and a Stop button. It holds a wake lock, a Wi-Fi lock and a multicast lock so Photon keeps working with the screen off and can hear lights and TVs on the network. If Photon crashes, Android starts the service again.
- **Settings** live in the app's private storage (`files/data/config.json`). Updating the app keeps them. Uninstalling deletes them.
- **The main screen** (`MainActivity`) shows whether Photon is running and its address, and has buttons for the battery and notification settings. **Open Photon** shows the normal web page in a web view (`WebActivity`). Plex sign-in and downloads open in the phone's browser.
- **Start on boot:** `BootReceiver` starts Photon when the phone turns on (if that option is on) and after the app is updated.

It needs Android 8 or newer. The APK includes 64-bit ARM (nearly every phone and tablet) and x86_64 (emulators and some Chromebooks).

## Building

`build-apk.sh` builds the APK on Linux using Ubuntu's Android packages. It doesn't need Android Studio, Gradle or the NDK.

```
sudo apt install android-sdk-build-tools android-sdk-platform-23 android-framework-res \
                 apksigner zipalign dalvik-exchange clang lld patchelf zip openjdk-21-jdk-headless nodejs npm
bash android/build-apk.sh
```

The result is `dist/Photon-<version>.apk`. The first build downloads two things and checks each against a fixed hash:

- **nodejs-mobile 18.20.4** from npm (`nodejs-mobile-react-native`), for `libnode.so`.
- **The NDK's `libc++_shared.so`** (NDK r27) from pyzmq's Android wheels on PyPI. `libnode.so` needs it, and this saves downloading the whole NDK.

Java is compiled against the Android 6 platform library, which is the newest one Ubuntu packages. Calls that need newer Android versions go through `Compat.java`. Resources are linked against Android 13's `framework-res.apk`.

## Signing

Android only installs an update over an existing install when both are signed with the same key. Release APKs are signed with Photon's release key:

```
PHOTON_KEYSTORE=/path/to/photon-release.p12 PHOTON_KEYSTORE_PASS='…' bash android/build-apk.sh
```

Keep the key and its password somewhere safe and **out of this repository**. If it's lost, the next version can't update existing installs; people would have to uninstall (losing their settings) and install again.

Without `PHOTON_KEYSTORE`, the build makes a throwaway test key. That's fine for testing, but the APK can't update a release install.

## Testing

`.github/workflows/android.yml` builds the APK and runs `test/emulator-test.sh` on Android 11 and Android 15 emulators whenever the app or Photon changes. The test installs the app and checks that Photon starts and answers, the page loads, settings save, the notification shows and the service runs in the foreground. It then kills Photon to check that Android brings it back, and tries Stop and Start. Screenshots and logs are kept with each run under **Actions**.

To run the same test against your own emulator or a phone connected with adb:

```
bash android/test/emulator-test.sh dist/Photon-1.4.3.apk
```

## Icons

`tools/make-icons.py` makes the launcher and notification icons from the Mac app icon. The results are committed, so it only needs running if the logo changes.
