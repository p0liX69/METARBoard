#!/usr/bin/env bash
set -euo pipefail

# METARBoard OTA update checker. Run as root by metarboard-update.timer
# (daily, with jitter - see install/metarboard-update.timer). Deliberately
# bash, not Node: this must keep working even if the currently-installed
# app is broken.
#
# Distribution model: a separate PUBLIC GitHub repo (METARBOARD_RELEASES_REPO
# below) holding nothing but tagged Releases - two assets per release, a
# tarball and a minisign signature over that exact tarball. No GitHub auth
# needed anywhere in this script since the repo is public. The private dev
# repo is never touched by devices.
#
# Trust anchor: the release-signing PUBLIC key lives at RELEASE_PUBKEY,
# installed once by setup-pi.sh into /opt/metarboard-releases (NOT inside
# any versioned release directory / NOT the copy that ships inside each
# release tarball's provisioning/ folder) - it must never be replaced by
# the update process itself, or a malicious release could ship its own
# "public key" and self-validate.

METARBOARD_RELEASES_REPO="${METARBOARD_RELEASES_REPO:-p0liX69/METARBoard-releases}"
INSTALL_DIR="/opt/metarboard"
RELEASES_DIR="/opt/metarboard-releases"
DATA_DIR="/opt/metarboard-data"
RELEASE_PUBKEY="${RELEASES_DIR}/metarboard-release.pub"
CURRENT_VERSION_FILE="${DATA_DIR}/CURRENT_VERSION"
STATUS_FILE="${DATA_DIR}/update-status.json"
SERVICE_USER="metarboard"
KEEP_RELEASES=2
MIN_FREE_KB=524288  # 512MB
HEALTH_CHECK_RETRIES=10
HEALTH_CHECK_DELAY_SEC=2

log() {
    echo "[check-for-update] $*"
}

# Restarting metarboard.service swaps the server-side code, but the kiosk's
# already-running Chromium tab keeps executing whatever JS/CSS it already
# loaded into memory - confirmed live: a device updated straight through
# to a new release with the health check passing, yet the visible display
# kept showing a UI redesign from several releases earlier until this was
# added. lwrespawn (installed by provisioning, supervising chromium)
# relaunches it automatically once it exits, and --incognito (see
# labwc-autostart) means that relaunch is a genuine fresh navigation, not
# a restored stale tab - so killing just the main chromium process here is
# enough to get the new frontend on screen with no other intervention.
reload_kiosk_display() {
    local chrome_pid
    chrome_pid="$(pgrep -u pi -f '/usr/lib/chromium/chromium --js-flags' || true)"
    if [[ -n "${chrome_pid}" ]]; then
        log "reloading kiosk display (chromium pid ${chrome_pid})"
        kill -9 ${chrome_pid} || true
    fi
}

# Atomically record the outcome of this run so /admin (via server.js's
# /updatestatus) can show fleet health without SSH.
write_status() {
    local status="$1" message="$2" version="$3"
    local tmp="${STATUS_FILE}.tmp"
    mkdir -p "${DATA_DIR}"
    cat > "${tmp}" <<EOF
{"status":"${status}","message":"${message}","version":"${version}","checkedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
    mv -f "${tmp}" "${STATUS_FILE}"
}

fail() {
    log "FAILED: $*"
    write_status "error" "$*" "$(cat "${CURRENT_VERSION_FILE}" 2>/dev/null || echo unknown)"
    exit 1
}

if [[ $EUID -ne 0 ]]; then
    fail "must run as root"
fi

if [[ ! -f "${RELEASE_PUBKEY}" ]]; then
    fail "release signing public key missing at ${RELEASE_PUBKEY} - device was not provisioned correctly"
fi

CURRENT_VERSION="$(cat "${CURRENT_VERSION_FILE}" 2>/dev/null || echo v0.0.0)"
log "current version: ${CURRENT_VERSION}"

WORKDIR="$(mktemp -d /tmp/metarboard-update.XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

log "checking ${METARBOARD_RELEASES_REPO} for the latest release"
if ! curl -fsSL "https://api.github.com/repos/${METARBOARD_RELEASES_REPO}/releases/latest" -o "${WORKDIR}/latest.json"; then
    fail "could not reach GitHub releases API"
fi

LATEST_TAG="$(jq -r '.tag_name' "${WORKDIR}/latest.json")"
if [[ -z "${LATEST_TAG}" || "${LATEST_TAG}" == "null" ]]; then
    fail "could not parse latest release tag"
fi

# Strip a leading "v" so dpkg's version comparator never sees a
# non-numeric-led string; also guards against ever "updating" to
# something that isn't strictly newer than the highest version this
# device has ever run (blocks a compromised/stale distribution point
# from downgrading a device to a previously-patched vulnerability).
CURRENT_NUM="${CURRENT_VERSION#v}"
LATEST_NUM="${LATEST_TAG#v}"
if ! dpkg --compare-versions "${LATEST_NUM}" gt "${CURRENT_NUM}"; then
    log "already up to date (latest: ${LATEST_TAG})"
    write_status "up-to-date" "Already on latest release" "${CURRENT_VERSION}"
    exit 0
fi

log "newer release available: ${LATEST_TAG}"

TARBALL_URL="$(jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' "${WORKDIR}/latest.json")"
SIG_URL="$(jq -r '.assets[] | select(.name | endswith(".tar.gz.minisig")) | .browser_download_url' "${WORKDIR}/latest.json")"
if [[ -z "${TARBALL_URL}" || -z "${SIG_URL}" ]]; then
    fail "release ${LATEST_TAG} is missing expected assets (tarball/.minisig)"
fi

FREE_KB="$(df --output=avail "/opt" | tail -1 | tr -d ' ')"
if (( FREE_KB < MIN_FREE_KB )); then
    fail "insufficient disk space on /opt (${FREE_KB}KB free, need ${MIN_FREE_KB}KB)"
fi

TARBALL="${WORKDIR}/release.tar.gz"
SIGFILE="${WORKDIR}/release.tar.gz.minisig"
log "downloading release assets"
curl -fsSL "${TARBALL_URL}" -o "${TARBALL}" || fail "failed to download tarball"
curl -fsSL "${SIG_URL}" -o "${SIGFILE}" || fail "failed to download signature"

# Verify BEFORE trusting anything about the downloaded file - never
# extract/inspect it first and treat the signature as a bonus check.
log "verifying signature"
if ! minisign -Vm "${TARBALL}" -x "${SIGFILE}" -p "${RELEASE_PUBKEY}" >/dev/null 2>&1; then
    fail "signature verification failed for ${LATEST_TAG} - refusing to install"
fi
log "signature OK"

NEW_RELEASE_DIR="${RELEASES_DIR}/${LATEST_TAG}"
if [[ -d "${NEW_RELEASE_DIR}" ]]; then
    rm -rf "${NEW_RELEASE_DIR}"
fi
mkdir -p "${NEW_RELEASE_DIR}"
tar -xzf "${TARBALL}" -C "${NEW_RELEASE_DIR}" --no-same-owner || fail "failed to extract release"

log "installing dependencies"
NPM_OK=0
for attempt in 1 2 3; do
    if (cd "${NEW_RELEASE_DIR}" && npm ci --omit=dev); then
        NPM_OK=1
        break
    fi
    log "npm ci attempt ${attempt} failed, retrying in $((attempt * 10))s"
    sleep $((attempt * 10))
done
if [[ "${NPM_OK}" -ne 1 ]]; then
    rm -rf "${NEW_RELEASE_DIR}"
    fail "npm ci failed after 3 attempts - old release left in place"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${NEW_RELEASE_DIR}"

PREVIOUS_TARGET="$(readlink -f "${INSTALL_DIR}" || true)"

log "swapping ${INSTALL_DIR} -> ${NEW_RELEASE_DIR}"
ln -sfn "${NEW_RELEASE_DIR}" "${WORKDIR}/metarboard-link"
mv -Tf "${WORKDIR}/metarboard-link" "${INSTALL_DIR}"
# reset-failed first: if a previous attempt crash-looped, systemd's
# StartLimitBurst may still be blocking new start attempts entirely -
# confirmed live during testing (a broken release crash-looped fast
# enough to trip the limit within the health-check window, which then
# silently blocked the *rollback's* restart too).
systemctl reset-failed metarboard || true
systemctl restart metarboard || true

log "health-checking new release"
HEALTHY=0
for ((i = 0; i < HEALTH_CHECK_RETRIES; i++)); do
    sleep "${HEALTH_CHECK_DELAY_SEC}"
    if curl -fsS "http://localhost:8500/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
done

if [[ "${HEALTHY}" -eq 1 ]]; then
    log "healthy - promoting ${LATEST_TAG}"
    tmp_version="${CURRENT_VERSION_FILE}.tmp"
    mkdir -p "${DATA_DIR}"
    echo -n "${LATEST_TAG}" > "${tmp_version}"
    mv -f "${tmp_version}" "${CURRENT_VERSION_FILE}"
    write_status "success" "Updated to ${LATEST_TAG}" "${LATEST_TAG}"

    # setup-pi.sh's kiosk-provisioning steps (wait-loop, loading
    # background, cursor theme, etc.) only ever run at first provisioning
    # - an update swapping the app symlink never touches them, so a
    # device provisioned before a kiosk-level fix existed would otherwise
    # never receive it. Non-fatal: a failure here shouldn't roll back an
    # otherwise-healthy app update.
    log "applying kiosk config from ${LATEST_TAG}"
    "${NEW_RELEASE_DIR}/provisioning/apply-kiosk-config.sh" || log "kiosk config apply failed (non-fatal, app update still applied)"

    reload_kiosk_display

    # Prune old releases, keeping the current one plus KEEP_RELEASES-1
    # previous ones for rollback headroom.
    ls -1dt "${RELEASES_DIR}"/v* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
        log "pruning old release ${old}"
        rm -rf "${old}"
    done
    exit 0
fi

log "health check failed - rolling back"
ROLLBACK_RESTARTED=0
if [[ -n "${PREVIOUS_TARGET}" && -d "${PREVIOUS_TARGET}" ]]; then
    ln -sfn "${PREVIOUS_TARGET}" "${WORKDIR}/metarboard-link"
    mv -Tf "${WORKDIR}/metarboard-link" "${INSTALL_DIR}"
    systemctl reset-failed metarboard || true
    if systemctl restart metarboard; then
        ROLLBACK_RESTARTED=1
        reload_kiosk_display
    fi
fi
rm -rf "${NEW_RELEASE_DIR}"
if [[ "${ROLLBACK_RESTARTED}" -eq 1 ]]; then
    fail "release ${LATEST_TAG} failed its health check - rolled back to ${CURRENT_VERSION}"
else
    fail "release ${LATEST_TAG} failed its health check AND the rollback restart also failed - device may be down, needs manual intervention"
fi
