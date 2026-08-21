#!/usr/bin/env bash
set -euo pipefail

# METARBoard Raspberry Pi provisioning script.
#
# Run as root from within a checkout of this repo, e.g.:
#   git clone <this-repo-url> ~/METARBoard
#   cd ~/METARBoard
#   sudo ./provisioning/setup-pi.sh
#
# Installs Node.js, a dedicated unprivileged system user, the app itself,
# and the systemd service, then starts METARBoard. Also lays out the
# structure the OTA updater (provisioning/check-for-update.sh) depends on
# going forward:
#   /opt/metarboard          - symlink to the currently-active release
#   /opt/metarboard-releases - versioned release directories + the
#                              release-signing public key (never touched
#                              by an update itself)
#   /opt/metarboard-data     - settings.json/charts/aircraft.db/.env/
#                              position history - survives every update
#
# Safe to re-run - existing settings.json, charts, and node_modules are
# left alone.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/metarboard"
RELEASES_DIR="/opt/metarboard-releases"
DATA_DIR="/opt/metarboard-data"
SERVICE_USER="metarboard"
DESKTOP_USER="pi"
NODE_MAJOR="22"

if [[ $EUID -ne 0 ]]; then
    echo "Please run as root: sudo $0" >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This script targets Raspberry Pi OS / Debian-based systems (needs apt-get)." >&2
    exit 1
fi

if [[ "${REPO_ROOT}" == "${INSTALL_DIR}" ]]; then
    echo "Please run this from a checkout outside of ${INSTALL_DIR} (e.g. ~/METARBoard)." >&2
    exit 1
fi

echo "==> Installing rsync/curl/jq/minisign (if missing)"
apt-get update -y
apt-get install -y rsync curl jq minisign swaybg

# Confirmed live on a Compute Module 5: NetworkManager's software WiFi
# radio ships soft-disabled by default on that image even though the
# onboard wireless (wlan0/brcmfmac) is present and working -
# metarboard-network-setup.service's hotspot fallback (and the customer's
# own home WiFi later) both depend on WiFi actually being usable. Harmless
# no-op on hardware where it's already on.
if command -v nmcli >/dev/null 2>&1; then
    nmcli radio wifi on || true
fi

echo "==> Installing Node.js ${NODE_MAJOR}.x (if not already present)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//;s/\..*//')" -lt "${NODE_MAJOR}" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
else
    echo "    node $(node -v) already installed, skipping"
fi

echo "==> Creating system user '${SERVICE_USER}' (if needed)"
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin "${SERVICE_USER}"
else
    echo "    user already exists, skipping"
fi

echo "==> Setting up persistent data directory (${DATA_DIR})"
mkdir -p "${DATA_DIR}/charts"
if [[ ! -f "${DATA_DIR}/settings.json" ]]; then
    cp "${REPO_ROOT}/settings.default.json" "${DATA_DIR}/settings.json"
fi

echo "==> Installing the release-signing public key"
mkdir -p "${RELEASES_DIR}"
# Deliberately installed here, not inside a versioned release dir - this
# must never be replaced by the update process itself, or a malicious
# release could ship its own "public key" and self-validate.
cp "${REPO_ROOT}/provisioning/metarboard-release.pub" "${RELEASES_DIR}/metarboard-release.pub"

VERSION="v$(node -p "require('${REPO_ROOT}/package.json').version")"
LOCAL_RELEASE_DIR="${RELEASES_DIR}/${VERSION}-local"
echo "==> Copying app to ${LOCAL_RELEASE_DIR}"
mkdir -p "${LOCAL_RELEASE_DIR}"
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'settings.json' \
    --exclude 'charts' \
    "${REPO_ROOT}/" "${LOCAL_RELEASE_DIR}/"

echo "==> Installing npm dependencies (production only)"
(cd "${LOCAL_RELEASE_DIR}" && npm ci --omit=dev)

echo "==> Fixing ownership"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${LOCAL_RELEASE_DIR}" "${DATA_DIR}"

echo "==> Pointing ${INSTALL_DIR} at ${LOCAL_RELEASE_DIR}"
ln -sfn "${LOCAL_RELEASE_DIR}" "${INSTALL_DIR}"
# Always write this to match what's actually running, not just on first
# provisioning - check-for-update.sh reads this file to decide whether an
# OTA update is needed, so re-running setup-pi.sh after a version bump
# without updating it would leave the OTA logic comparing against a
# version number that no longer matches the installed release.
echo -n "${VERSION}" > "${DATA_DIR}/CURRENT_VERSION"

echo "==> Installing the first-boot network setup + hostname polkit rules"
cp "${REPO_ROOT}/install/50-metarboard-network.rules" /etc/polkit-1/rules.d/50-metarboard-network.rules
cp "${REPO_ROOT}/install/51-metarboard-hostname.rules" /etc/polkit-1/rules.d/51-metarboard-hostname.rules
cp "${REPO_ROOT}/install/52-metarboard-update.rules" /etc/polkit-1/rules.d/52-metarboard-update.rules
systemctl restart polkit

echo "==> Installing systemd services + journald size cap"
cp "${REPO_ROOT}/install/metarboard.service" /etc/systemd/system/metarboard.service
cp "${REPO_ROOT}/install/metarboard-update.service" /etc/systemd/system/metarboard-update.service
cp "${REPO_ROOT}/install/metarboard-update.timer" /etc/systemd/system/metarboard-update.timer
cp "${REPO_ROOT}/install/metarboard-network-setup.service" /etc/systemd/system/metarboard-network-setup.service
cp "${REPO_ROOT}/install/metarboard-hostname.service" /etc/systemd/system/metarboard-hostname.service
mkdir -p /etc/systemd/journald.conf.d
cp "${REPO_ROOT}/install/journald-size-cap.conf" /etc/systemd/journald.conf.d/metarboard-size-cap.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable --now metarboard-hostname
systemctl enable --now metarboard-network-setup
systemctl enable --now metarboard
systemctl enable --now metarboard-update.timer

echo "==> Installing METARBoard boot splash (if plymouth is present)"
if [[ -x /usr/sbin/plymouth-set-default-theme ]]; then
    mkdir -p /usr/share/plymouth/themes/metarboard
    cp "${REPO_ROOT}/provisioning/plymouth/metarboard/"* /usr/share/plymouth/themes/metarboard/
    /usr/sbin/plymouth-set-default-theme -R metarboard
else
    echo "    plymouth not found, skipping boot splash (stock OS splash will show instead)"
fi

echo "==> Configuring kiosk auto-start for desktop user '${DESKTOP_USER}' (if present)"
"${REPO_ROOT}/provisioning/apply-kiosk-config.sh" "${DESKTOP_USER}"
echo "    (see provisioning/README.md if you need to set this up manually)"

echo ""
echo "==> Done. METARBoard should be starting now."
echo "    Check status:  systemctl status metarboard"
echo "    View logs:     journalctl -u metarboard -f"
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "    Open in a browser: http://${IP_ADDR:-<pi-ip>}:8500"
