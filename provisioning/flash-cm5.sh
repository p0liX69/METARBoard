#!/usr/bin/env bash
set -euo pipefail

# Bulk-flashes a METARBoard golden image onto one or more Compute Module 5
# units that are already sitting in USB boot mode, exposed as external
# disks by rpiboot's mass-storage-gadget (see provisioning/README.md for
# the full capture/flash workflow and the EMMC-DISABLE jumper prerequisite
# - that's a physical step per unit this script can't do for you).
#
# Run this AFTER `sudo rpiboot -d mass-storage-gadget` has finished and
# each jumpered CM5 shows up as its own external disk in `diskutil list`.
# Connecting several units to one powered USB hub before running rpiboot
# lets it expose all of them at once, so this script flashes them all in
# parallel - that's the actual "don't touch each one" part; rpiboot/the
# physical jumper+cable-in step still needs a person.
#
# Usage: ./flash-cm5.sh /path/to/metarboard-golden.img[.gz]
#
# Safety model: this never auto-selects or auto-writes to a disk. It only
# lists disks diskutil itself reports as external+physical, then requires
# you to type each target disk's identifier twice (once to select, once
# to confirm) before anything is erased. dd to the wrong /dev/diskN can
# destroy data on THIS Mac, not just the CM5 - treat every prompt here as
# a real "are you sure" and read the disk info it prints before typing.

IMAGE="${1:?Usage: $0 /path/to/golden-image.img[.gz]}"
[[ -f "${IMAGE}" ]] || { echo "Image not found: ${IMAGE}" >&2; exit 1; }

echo "==> External physical disks currently visible:"
echo
diskutil list external physical
echo

read -rp "Type the disk identifiers to flash, space-separated (e.g. disk4 disk6), or 'abort': " -a TARGETS
if [[ "${TARGETS[0]:-}" == "abort" ]]; then
    echo "Aborted - nothing written."
    exit 0
fi

EXTERNAL_DISKS="$(diskutil list external physical | grep -o '^/dev/disk[0-9]*' | sed 's#/dev/##')"

PIDS=()
DISKS=()
for disk in "${TARGETS[@]}"; do
    if ! grep -qx "${disk}" <<< "${EXTERNAL_DISKS}"; then
        echo "Refusing to touch /dev/${disk} - it isn't in diskutil's external-disk list above." >&2
        exit 1
    fi

    echo
    echo "--- /dev/${disk} ---"
    diskutil info "/dev/${disk}" | grep -E "Device Identifier|Device / Media Name|Disk Size|Protocol"
    read -rp "Type '${disk}' again to confirm ERASING this disk and writing the image: " CONFIRM
    if [[ "${CONFIRM}" != "${disk}" ]]; then
        echo "Confirmation didn't match - skipping ${disk}."
        continue
    fi

    diskutil unmountDisk "/dev/${disk}"
    echo "==> Flashing /dev/${disk} in the background..."
    if [[ "${IMAGE}" == *.gz ]]; then
        (gunzip -c "${IMAGE}" | sudo dd of="/dev/r${disk}" bs=4m 2>&1 | sed "s/^/[${disk}] /"; echo "[${disk}] done") &
    else
        (sudo dd if="${IMAGE}" of="/dev/r${disk}" bs=4m 2>&1 | sed "s/^/[${disk}] /"; echo "[${disk}] done") &
    fi
    PIDS+=($!)
    DISKS+=("${disk}")
done

if [[ "${#PIDS[@]}" -eq 0 ]]; then
    echo "No disks confirmed - nothing written."
    exit 0
fi

echo
echo "==> Flashing ${#PIDS[@]} disk(s) in parallel: ${DISKS[*]}"
echo "    (dd on macOS is silent until it finishes a disk - this can take"
echo "    several minutes per unit for a multi-GB image; be patient)"
wait "${PIDS[@]}"

for disk in "${DISKS[@]}"; do
    diskutil eject "/dev/${disk}" || true
done

echo
echo "==> Done. Remove each unit's EMMC-DISABLE jumper before powering it"
echo "    on normally, or it'll boot back into USB boot mode instead of"
echo "    the flashed OS."
