#!/usr/bin/env bash
set -euo pipefail

# Cuts a METARBoard release: builds the tarball devices will download,
# signs it with minisign, and publishes it as a GitHub Release on the
# PUBLIC METARBOARD_RELEASES_REPO (never the private dev repo - devices
# only ever talk to the releases repo, unauthenticated).
#
# One-time setup before the first run:
#   1. Create the public "<owner>/METARBoard-releases" repo on GitHub
#      (empty - it exists purely to hold Releases).
#   2. Generate a signing keypair: minisign -G
#      Keep ~/.minisign/minisign.key (and its password) safe - ideally not
#      on the same machine/session that has push access to GitHub, so a
#      compromised GitHub login alone can't produce a validly-signed
#      malicious release. The PUBLIC key (minisign.pub) gets committed to
#      this repo as provisioning/metarboard-release.pub and baked onto
#      every device at provisioning time - it is the one thing that must
#      never change without physically updating each device.
#   3. `gh auth login` if you haven't already.
#
# Usage: ./provisioning/build-release.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
METARBOARD_RELEASES_REPO="${METARBOARD_RELEASES_REPO:-p0liX69/METARBoard-releases}"
MINISIGN_KEY="${MINISIGN_KEY:-$HOME/.minisign/minisign.key}"

command -v minisign >/dev/null 2>&1 || { echo "minisign not found - brew install minisign" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "gh CLI not found - brew install gh" >&2; exit 1; }
[[ -f "${MINISIGN_KEY}" ]] || { echo "No signing key at ${MINISIGN_KEY} - run: minisign -G" >&2; exit 1; }

VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
TAG="v${VERSION}"
echo "==> Building release ${TAG}"

if gh release view "${TAG}" --repo "${METARBOARD_RELEASES_REPO}" >/dev/null 2>&1; then
    echo "Release ${TAG} already exists on ${METARBOARD_RELEASES_REPO} - bump the version in package.json first." >&2
    exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
STAGE="${WORKDIR}/stage"
mkdir -p "${STAGE}"

echo "==> Staging release contents"
# Everything a running device needs, and nothing device-specific: no
# node_modules (rebuilt on-device via npm ci), no settings.json/charts/
# aircraft.db/.env/position history (those live in /opt/metarboard-data
# and must survive updates untouched).
cp "${REPO_ROOT}/server.js" "${STAGE}/"
cp "${REPO_ROOT}/package.json" "${STAGE}/"
cp "${REPO_ROOT}/package-lock.json" "${STAGE}/"
cp "${REPO_ROOT}/airports.json" "${STAGE}/"
cp "${REPO_ROOT}/settings.default.json" "${STAGE}/"
cp -R "${REPO_ROOT}/public" "${STAGE}/public"
cp -R "${REPO_ROOT}/provisioning" "${STAGE}/provisioning"
cp -R "${REPO_ROOT}/install" "${STAGE}/install"
cp -R "${REPO_ROOT}/images" "${STAGE}/images"

TARBALL="${WORKDIR}/metarboard-${TAG}.tar.gz"
SIGFILE="${TARBALL}.minisig"
# -C stage . so extraction drops files at the target dir's root - no
# wrapper directory for check-for-update.sh to strip.
tar -czf "${TARBALL}" -C "${STAGE}" .

echo "==> Signing"
minisign -S -m "${TARBALL}" -s "${MINISIGN_KEY}" -t "METARBoard ${TAG}"

echo "==> Publishing to ${METARBOARD_RELEASES_REPO}"
gh release create "${TAG}" \
    --repo "${METARBOARD_RELEASES_REPO}" \
    --title "${TAG}" \
    --notes "METARBoard ${TAG}" \
    "${TARBALL}" "${SIGFILE}"

echo "==> Done. Devices will pick this up on their next scheduled check"
echo "    (or immediately: sudo /opt/metarboard/provisioning/check-for-update.sh)"
