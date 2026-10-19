#!/bin/sh
# Removes Photon from this Mac. Pass --all to delete rooms and settings too.
# Run as root (the Uninstall Photon app asks for an admin password).
launchctl bootout system/com.photon.server 2>/dev/null || launchctl unload /Library/LaunchDaemons/com.photon.server.plist 2>/dev/null
pkill -f "/Library/Photon/app/src/server.js" 2>/dev/null
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
[ -x "$FW" ] && "$FW" --remove /Library/Photon/node/bin/node >/dev/null 2>&1
rm -f /Library/LaunchDaemons/com.photon.server.plist
rm -rf /Library/Photon "/Applications/Photon.app" "/Applications/Utilities/Uninstall Photon.app"
pkgutil --forget com.photon.server.pkg >/dev/null 2>&1
if [ "${1:-}" = "--all" ]; then
  rm -rf "/Library/Application Support/Photon"
fi
# The hidden account the service ran as. Kept settings get handed to a new one on reinstall.
dscl . -delete /Users/_photon >/dev/null 2>&1
dscl . -delete /Groups/_photon >/dev/null 2>&1
exit 0
