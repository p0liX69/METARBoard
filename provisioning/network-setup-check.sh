#!/usr/bin/env bash
set -euo pipefail

# Runs as root via metarboard-network-setup.service, before
# metarboard.service starts. If this device has no working network
# connection, starts an OPEN WiFi hotspot and flags setup mode so
# server.js serves public/setup.html instead of the map.
#
# Deliberately doesn't use `nmcli device wifi hotspot` - its man page
# states it always secures the network (WPA, falling back to WEP), with
# no documented option for a genuinely open network. Building the
# connection profile manually and never touching any
# 802-11-wireless-security.* property is what actually produces an open
# network - confirmed against `man 5 nm-settings-nmcli`
# (802-11-wireless-security.key-mgmt: "This property must be set for any
# Wi-Fi connection that uses security" - the inverse being that a profile
# with no security properties at all has none).
#
# Idempotent/safe to re-run: does nothing if connectivity already exists
# or the hotspot is already up.

DATA_DIR="/opt/metarboard-data"
FLAG_FILE="${DATA_DIR}/setup-mode-active"
HOTSPOT_SSID="METARBoard Setup"
HOTSPOT_CON_NAME="METARBoard Setup"
WIFI_IFNAME="wlan0"
NMCLI_TIMEOUT_SEC=15

mkdir -p "${DATA_DIR}"

# Every nmcli call below runs under `timeout` - checking its exit code
# (see below) only helps if nmcli actually returns. A hung D-Bus call to
# NetworkManager (daemon unresponsive, etc.) would otherwise block
# indefinitely, relying on systemd's blunt service-level timeout to ever
# kill it - which would take the whole script down, flag file and all,
# before reaching the "always touch the flag" logic that exists
# specifically to avoid that.
nmcli() {
    timeout "${NMCLI_TIMEOUT_SEC}" /usr/bin/nmcli "$@"
}

# `nmcli general status CONNECTIVITY` is a single point-in-time read with
# no wait for DHCP to finish, and reports "unknown" unless
# connectivity.uri is configured in NetworkManager.conf - either gap can
# read as "no connectivity" on a device that's actually fine, just not
# finished negotiating yet this early in boot. A short poll avoids
# needlessly starting the setup hotspot on a working device.
connectivity=unknown
for attempt in 1 2 3; do
    connectivity="$(nmcli -t -f CONNECTIVITY general status 2>/dev/null || echo unknown)"
    echo "[network-setup-check] connectivity (attempt ${attempt}): ${connectivity}"
    if [[ "${connectivity}" == "full" || "${connectivity}" == "limited" ]]; then
        break
    fi
    sleep 3
done

if [[ "${connectivity}" == "full" || "${connectivity}" == "limited" ]]; then
    echo "[network-setup-check] already connected - no setup needed"
    rm -f "${FLAG_FILE}"
    exit 0
fi

echo "[network-setup-check] no connectivity - starting open setup hotspot"

# Every nmcli call below is explicitly checked (not left to `set -e`) so a
# failure here (radio soft-blocked, wlan0 not ready yet, no regulatory
# domain set) can't silently kill the script BEFORE the flag file gets
# written. Previously that would leave a non-technical customer with no
# network, no hotspot, and no visible setup wizard - just the plain map
# stuck showing nothing useful, with zero diagnostic trail and no
# keyboard/monitor to debug with.
HOTSPOT_OK=1
if ! nmcli -t -f NAME connection show --active | grep -qxF "${HOTSPOT_CON_NAME}"; then
    if nmcli -t -f NAME connection show | grep -qxF "${HOTSPOT_CON_NAME}"; then
        nmcli connection delete "${HOTSPOT_CON_NAME}" || echo "[network-setup-check] warning: failed to delete stale hotspot profile" >&2
    fi
    if ! nmcli connection add type wifi ifname "${WIFI_IFNAME}" con-name "${HOTSPOT_CON_NAME}" \
        autoconnect no ssid "${HOTSPOT_SSID}"; then
        echo "[network-setup-check] failed to create hotspot connection profile" >&2
        HOTSPOT_OK=0
    fi
    if [[ "${HOTSPOT_OK}" -eq 1 ]] && ! nmcli connection modify "${HOTSPOT_CON_NAME}" \
        802-11-wireless.mode ap \
        802-11-wireless.band bg \
        ipv4.method shared; then
        echo "[network-setup-check] failed to configure hotspot connection" >&2
        HOTSPOT_OK=0
    fi
    if [[ "${HOTSPOT_OK}" -eq 1 ]] && ! nmcli connection up "${HOTSPOT_CON_NAME}"; then
        echo "[network-setup-check] hotspot didn't come up on first try, retrying once..." >&2
        sleep 3
        if ! nmcli connection up "${HOTSPOT_CON_NAME}"; then
            echo "[network-setup-check] failed to bring up hotspot" >&2
            HOTSPOT_OK=0
        fi
    fi
fi

# Flag setup mode regardless of whether the hotspot itself came up, so
# the wizard/error state is at least visible instead of silently falling
# through to the normal map view.
touch "${FLAG_FILE}"
if [[ "${HOTSPOT_OK}" -eq 1 ]]; then
    echo "[network-setup-check] setup mode active - hotspot '${HOTSPOT_SSID}' (open) is up"
else
    echo "[network-setup-check] setup mode active but hotspot failed to start - device may be unreachable over WiFi, needs manual/wired intervention" >&2
fi
