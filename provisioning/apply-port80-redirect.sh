#!/usr/bin/env bash
set -euo pipefail

# Redirect inbound TCP port 80 -> the app's port (8500) so users can
# reach the board at http://<hostname> without typing the non-standard
# :8500. Applied at boot by metarboard-port80.service.
#
# The app itself keeps listening ONLY on 8500, as the unprivileged
# `metarboard` user with NoNewPrivileges=yes - this is a pure kernel
# dstnat redirect, so nothing about the app process or its security model
# changes. If this script ever fails, port 80 simply doesn't work and
# :8500 keeps working unchanged.
#
# Scoped to its own isolated nft table (metarboard_nat) so the whole
# thing can be atomically deleted + re-added without touching any other
# firewall state on the device. Only the prerouting hook is used:
# loopback traffic (the kiosk's own http://localhost:8500, the OTA
# health check) never traverses prerouting, so those paths are untouched
# and must continue to use 8500 directly.
#
# nft lives in /usr/sbin, which isn't on a non-login PATH - always call
# it by absolute path so this works identically under systemd and a
# plain shell.

NFT="/usr/sbin/nft"
TARGET_PORT="${METARBOARD_HTTP_PORT:-8500}"

if [[ ! -x "${NFT}" ]]; then
    echo "[port80] ${NFT} not found - cannot install redirect" >&2
    exit 1
fi

# Idempotent: drop our own table if a previous run created it, then
# recreate it. Deleting only metarboard_nat leaves any unrelated tables
# alone.
"${NFT}" delete table ip metarboard_nat 2>/dev/null || true
"${NFT}" -f - <<EOF
table ip metarboard_nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        tcp dport 80 redirect to :${TARGET_PORT}
    }
}
EOF

echo "[port80] redirect tcp/80 -> tcp/${TARGET_PORT} installed"
