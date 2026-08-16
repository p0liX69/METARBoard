#!/usr/bin/env bash
set -euo pipefail

# METARBoard Raspberry Pi provisioning script.
#
# Run as root from within a checkout of this repo, e.g.:
#   git clone <this-repo-url> ~/METARBoard
#   cd ~/METARBoard
#   sudo ./provisioning/setup-pi.sh
#
# Installs Node.js, a dedicated unprivileged system user, the app itself
# (copied to /opt/metarboard), and the systemd service, then starts
# METARBoard. Safe to re-run - existing settings.json and node_modules
# are left alone.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/metarboard"
SERVICE_USER="metarboard"
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

echo "==> Installing rsync/curl (if missing)"
apt-get update -y
apt-get install -y rsync curl

echo "==> Installing Node.js ${NODE_MAJOR}.x (if not already present)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//;s/\..*//')" -lt "${NODE_MAJOR}" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
else
    echo "    node $(node -v) already installed, skipping"
fi

echo "==> Creating system user '${SERVICE_USER}' (if needed)"
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
else
    echo "    user already exists, skipping"
fi

echo "==> Copying app to ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'settings.json' \
    "${REPO_ROOT}/" "${INSTALL_DIR}/"

echo "==> Seeding settings.json from settings.default.json (only if missing)"
if [[ ! -f "${INSTALL_DIR}/settings.json" ]]; then
    cp "${INSTALL_DIR}/settings.default.json" "${INSTALL_DIR}/settings.json"
fi

echo "==> Installing npm dependencies (production only)"
(cd "${INSTALL_DIR}" && npm ci --omit=dev)

echo "==> Fixing ownership"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

echo "==> Installing systemd service + journald size cap"
cp "${REPO_ROOT}/install/metarboard.service" /etc/systemd/system/metarboard.service
mkdir -p /etc/systemd/journald.conf.d
cp "${REPO_ROOT}/install/journald-size-cap.conf" /etc/systemd/journald.conf.d/metarboard-size-cap.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable --now metarboard

echo ""
echo "==> Done. METARBoard should be starting now."
echo "    Check status:  systemctl status metarboard"
echo "    View logs:     journalctl -u metarboard -f"
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "    Open in a browser: http://${IP_ADDR:-<pi-ip>}:8500"
