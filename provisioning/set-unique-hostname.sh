#!/usr/bin/env bash
set -euo pipefail

# Runs once, at first boot, via metarboard-hostname.service (before
# metarboard-network-setup.service). Every device imaged from the same
# golden SD card would otherwise share the literal same hostname
# ("METARBoard") - confirmed live that this breaks mDNS the moment a
# customer has more than one unit on their network (a second device
# answered for the first one's "metarboard.local"). This gives every
# device a hardware-derived unique name automatically, with zero customer
# input required.
#
# A customer-chosen friendly name (server.js's /setup/complete, "Display
# Name" field in the setup wizard) takes precedence over this and is
# applied afterwards - this script never runs again once
# HOSTNAME_FLAG exists, so it can never stomp on that later.
#
# Idempotent/safe to re-run: does nothing once the flag file exists.

DATA_DIR="/opt/metarboard-data"
HOSTNAME_FLAG="${DATA_DIR}/hostname-initialized"
HOSTNAME_PREFIX="metarboard-"

mkdir -p "${DATA_DIR}"

if [[ -f "${HOSTNAME_FLAG}" ]]; then
    echo "[set-unique-hostname] already initialized - nothing to do"
    exit 0
fi

# The CPU serial is present on every real Raspberry Pi and never changes -
# a much simpler and more universally-available source of per-device
# uniqueness than trying to key off a specific network interface's MAC
# (which may not exist yet this early in boot, e.g. Ethernet only).
SUFFIX="$(awk '/^Serial/ {print $3}' /proc/cpuinfo 2>/dev/null | tail -c 7)"

if [[ -z "${SUFFIX}" ]]; then
    # Not real Pi hardware (e.g. a dev/test environment) - fall back to
    # the wlan0 MAC, and failing that, a random suffix. Still guaranteed
    # unique per boot either way; only real hardware needs the stable,
    # reboot-proof serial-derived value above.
    SUFFIX="$(cat /sys/class/net/wlan0/address 2>/dev/null | tr -d ':' | tail -c 7)"
fi
if [[ -z "${SUFFIX}" ]]; then
    SUFFIX="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

OLD_HOSTNAME="$(hostname)"
NEW_HOSTNAME="${HOSTNAME_PREFIX}${SUFFIX}"
echo "[set-unique-hostname] setting hostname to ${NEW_HOSTNAME}"
hostnamectl set-hostname "${NEW_HOSTNAME}"

# hostnamectl does not touch /etc/hosts on this OS - confirmed live the
# 127.0.1.1 line kept the old name, which doesn't break mDNS (avahi reads
# the live kernel hostname, not this file) but does make every later sudo
# call print a spurious "unable to resolve host" warning. raspi-config's
# own do_hostname function fixes up both files for the same reason - this
# mirrors that.
if [[ -f /etc/hosts && -n "${OLD_HOSTNAME}" ]]; then
    sed -i "s/\b${OLD_HOSTNAME}\b/${NEW_HOSTNAME}/g" /etc/hosts
fi

# avahi-daemon does not pick up a hostnamectl change on its own - confirmed
# live it kept answering mDNS queries for the old hostname until this
# restart ran, despite that auto-follow behavior being commonly
# assumed/documented for some avahi builds.
systemctl restart avahi-daemon || true

touch "${HOSTNAME_FLAG}"
