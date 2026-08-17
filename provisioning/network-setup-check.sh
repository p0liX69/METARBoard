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

mkdir -p "${DATA_DIR}"

connectivity="$(nmcli -t -f CONNECTIVITY general status 2>/dev/null || echo unknown)"
echo "[network-setup-check] connectivity: ${connectivity}"

if [[ "${connectivity}" == "full" || "${connectivity}" == "limited" ]]; then
    echo "[network-setup-check] already connected - no setup needed"
    rm -f "${FLAG_FILE}"
    exit 0
fi

echo "[network-setup-check] no connectivity - starting open setup hotspot"

if ! nmcli -t -f NAME connection show --active | grep -qxF "${HOTSPOT_CON_NAME}"; then
    if nmcli -t -f NAME connection show | grep -qxF "${HOTSPOT_CON_NAME}"; then
        nmcli connection delete "${HOTSPOT_CON_NAME}"
    fi
    nmcli connection add type wifi ifname "${WIFI_IFNAME}" con-name "${HOTSPOT_CON_NAME}" \
        autoconnect no ssid "${HOTSPOT_SSID}"
    nmcli connection modify "${HOTSPOT_CON_NAME}" \
        802-11-wireless.mode ap \
        802-11-wireless.band bg \
        ipv4.method shared
    nmcli connection up "${HOTSPOT_CON_NAME}"
fi

touch "${FLAG_FILE}"
echo "[network-setup-check] setup mode active - hotspot '${HOTSPOT_SSID}' (open) is up"
