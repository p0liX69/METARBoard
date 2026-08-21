#!/bin/sh
# Kiosk Chromium launcher, run under lwrespawn from labwc-autostart as:
#   /usr/bin/lwrespawn /bin/sh /opt/metarboard/provisioning/kiosk-chromium-launch.sh
# Referenced through the /opt/metarboard symlink (like chromium-watchdog.sh)
# so OTA updates carry changes here automatically, and invoked via
# `/bin/sh <path>` so it works regardless of this file's executable bit.
#
# Clearing Chromium's SingletonLock MUST happen before every (re)launch,
# not just once at session start. Chromium's SingletonLock records the
# hostname it was created under and refuses to break it when the current
# hostname differs (a safety check meant for shared/NFS-mounted profiles on
# different machines) - it then just silently fails to open a window and
# crash-loops invisibly, with the error only on its own stderr. The setup
# wizard's "Name This Display" field changes the hostname AT RUNTIME
# (server.js /setup/complete), after this session's first Chromium already
# created a lock under the old name. lwrespawn relaunches Chromium by
# re-running this script, so clearing the lock here makes every relaunch (a
# crash, an OTA reload_kiosk_display, the watchdog, or the next boot)
# self-heal instead of crash-looping. Safe on a single-purpose kiosk -
# there is never a legitimate second instance whose lock this protects.
rm -f "${HOME}/.config/chromium/SingletonLock" \
      "${HOME}/.config/chromium/SingletonCookie" \
      "${HOME}/.config/chromium/SingletonSocket"

# Flags of note:
# --ozone-platform=wayland: without it Chromium auto-detects the platform
#   and (confirmed live) can pick X11 on this hardware, dying instantly and
#   repeatedly ("Missing X server or $DISPLAY"). This is a fixed,
#   Wayland-only kiosk, so force it rather than rely on auto-detection.
# --incognito: no persistent profile to silently restore, so every launch
#   is a genuine fresh load of current server state, not a stale rendered tab.
# --password-store=basic: avoid the OS-keyring unlock dialog under autologin.
# --remote-debugging-port: loopback-only; chromium-watchdog.sh uses it to
#   tell a live app tab from a crashed one.
# exec so the running process IS chromium - chromium-watchdog.sh and
# check-for-update.sh's reload_kiosk_display both pgrep on
# '/usr/lib/chromium/chromium --js-flags'.
exec /usr/bin/chromium \
    --kiosk \
    --incognito \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000 \
    --password-store=basic \
    --start-fullscreen \
    --ozone-platform=wayland \
    --remote-debugging-port=9223 \
    --remote-debugging-address=127.0.0.1 \
    http://localhost:8500
