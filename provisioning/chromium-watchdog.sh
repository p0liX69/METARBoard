#!/bin/sh
# Runs alongside chromium (launched from labwc-autostart) for the lifetime of
# the kiosk session. lwrespawn only relaunches chromium if the whole browser
# process exits - it can't see a renderer crash ("Aw, Snap! Error code 4")
# because the browser process and window stay alive, just showing a dead
# tab. Confirmed live: a reboot landed on that interstitial and sat there
# forever with no recovery. This polls the page title over chromium's
# loopback-only remote debugging port (see labwc-autostart) and forces a
# full relaunch if the real app isn't the front tab.
#
# Requires several consecutive bad checks before acting so it never fights
# the normal boot race (chromium's debug port and metarboard.service can
# each take a few seconds to come up) or a brief mid-reload title change.
set -eu

DEBUG_URL="http://127.0.0.1:9223/json"
EXPECTED_TITLE="METAR Board"
CHECK_INTERVAL=20
BAD_STREAK_THRESHOLD=3

bad_streak=0

while true; do
    sleep "${CHECK_INTERVAL}"

    title="$(curl -s --max-time 3 "${DEBUG_URL}" 2>/dev/null \
        | jq -r '([.[] | select(.type=="page")][0].title) // empty' 2>/dev/null || true)"

    if [ "${title}" = "${EXPECTED_TITLE}" ]; then
        bad_streak=0
        continue
    fi

    bad_streak=$((bad_streak + 1))
    if [ "${bad_streak}" -lt "${BAD_STREAK_THRESHOLD}" ]; then
        continue
    fi

    # Kill the real chromium binary (not the lwrespawn wrapper around it) so
    # lwrespawn sees the exit and relaunches a fresh instance.
    pkill -f '/usr/lib/chromium/chromium --js-flags' || true
    bad_streak=0
done
