#!/usr/bin/env bash
set -euo pipefail

# Installs/refreshes the kiosk-display-level files that make the map look
# right on boot: the labwc autostart script (backend-wait loop, loading
# background, ozone-platform), the system-wide labwc autostart override,
# and the transparent cursor theme. Idempotent - safe to run repeatedly.
#
# Split out of setup-pi.sh so check-for-update.sh can call it too: an OTA
# update only swaps /opt/metarboard and restarts the service, it never
# re-runs setup-pi.sh - so without this, a device provisioned before a
# kiosk-level fix existed would never receive that fix via OTA even after
# updating its app code, since the fix lives in files this script installs
# (~/.config/labwc/*, /usr/share/icons/metarboard-blank), not in the app.
#
# Usage: sudo ./provisioning/apply-kiosk-config.sh [desktop-user]
# (desktop-user defaults to "pi")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_USER="${1:-pi}"

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root: sudo $0" >&2
    exit 1
fi

if ! id "${DESKTOP_USER}" >/dev/null 2>&1 || [[ ! -x /usr/bin/chromium ]]; then
    echo "no '${DESKTOP_USER}' user or no chromium found, skipping kiosk config"
    exit 0
fi

DESKTOP_HOME="$(getent passwd "${DESKTOP_USER}" | cut -d: -f6)"
mkdir -p "${DESKTOP_HOME}/.config/labwc"
cp "${REPO_ROOT}/provisioning/labwc-autostart" "${DESKTOP_HOME}/.config/labwc/autostart"
cp "${REPO_ROOT}/provisioning/kiosk-loading-bg.png" "${DESKTOP_HOME}/.config/labwc/kiosk-loading-bg.png"
chmod +x "${DESKTOP_HOME}/.config/labwc/autostart"
chown -R "${DESKTOP_USER}:${DESKTOP_USER}" "${DESKTOP_HOME}/.config/labwc"

# labwc runs the stock /etc/xdg/labwc/autostart in addition to the user
# one above - confirmed live it briefly shows the desktop wallpaper/
# taskbar on every boot before Chromium's kiosk window covers them. Back
# up the original once, then replace it.
if [[ -f /etc/xdg/labwc/autostart && ! -f /etc/xdg/labwc/autostart.orig ]]; then
    cp /etc/xdg/labwc/autostart /etc/xdg/labwc/autostart.orig
fi
cp "${REPO_ROOT}/provisioning/labwc-system-autostart" /etc/xdg/labwc/autostart

# This kiosk has no mouse/touchpad attached, but labwc still renders an
# idle cursor sprite regardless of whether a real pointer device exists -
# confirmed live it sits visible (and never moves, since nothing ever
# generates motion events) over both the loading background and the map.
# There's no "just hide it" config option in labwc, so this installs a
# fully transparent cursor theme instead - the standard workaround for
# exactly this situation.
mkdir -p /usr/share/icons/metarboard-blank
cp -R "${REPO_ROOT}/provisioning/metarboard-blank-cursor/." /usr/share/icons/metarboard-blank/
ENV_FILE="${DESKTOP_HOME}/.config/labwc/environment"
if [[ -f "${ENV_FILE}" ]] && ! grep -q '^XCURSOR_THEME=' "${ENV_FILE}"; then
    printf '\nXCURSOR_THEME=metarboard-blank\nXCURSOR_SIZE=32\n' >> "${ENV_FILE}"
    chown "${DESKTOP_USER}:${DESKTOP_USER}" "${ENV_FILE}"
fi

echo "kiosk config applied for '${DESKTOP_USER}'"
