# Provisioning a Pi from scratch

This turns a freshly-flashed Raspberry Pi into a running METARBoard appliance.

**Compute Module 5:** confirmed working with this exact same flow, no code
changes required - same SoC (BCM2712) and OS as a Pi 5, so Chromium,
`better-sqlite3`'s native module, and the vc4/v3d GPU stack all just work.
The one thing to check on a fresh CM5 image: `nmcli general status` may
show `WIFI disabled` even though the onboard wireless hardware and firmware
are fine (`WIFI-HW enabled`) - `setup-pi.sh` now runs `nmcli radio wifi on`
itself to cover this, but if you're troubleshooting a hotspot that never
comes up, check that first. When buying/flashing a CM5, get the **wireless
SKU** - the zero-IT setup flow depends on the device broadcasting its own
hotspot.

## 1. Flash the SD card

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to write
**Raspberry Pi OS (64-bit)** — the full desktop image, *not* the Lite one —
to the SD card. The appliance boots straight into a fullscreen kiosk browser
(see step 8), which needs the desktop image to run on. In the imager's
advanced options (gear icon / Ctrl+Shift+X):

- Enable SSH and set a hostname/username/password (or an SSH key) so you can
  connect headless during setup.
- Under "General", **enable autologin to desktop** for that same user. This
  is required for the kiosk to come up with no keyboard/mouse attached —
  without it the Pi will sit at a login prompt forever.

## 2. Boot it and connect

Boot the Pi, find its IP (check your router, or `ping raspberrypi.local`),
then:

```bash
ssh <user>@<pi-ip>
```

## 3. Get this repo onto the Pi

```bash
git clone <this-repo-url> ~/METARBoard
cd ~/METARBoard
```

(Or `scp -r` a local checkout instead of cloning, if the Pi has no network
access to your git remote yet.)

## 4. Run the provisioning script

```bash
sudo ./provisioning/setup-pi.sh
```

This installs Node.js, creates a dedicated `metarboard` system user, copies
the app to `/opt/metarboard`, installs production dependencies, and installs
+ starts the `metarboard` systemd service (auto-restart on crash, auto-start
on boot).

The script is safe to re-run — it won't clobber an existing `settings.json`,
and it skips steps that are already done (Node install, user creation).

## 5. Copy the chart data onto the device

**`charts/*.mbtiles` are not in this git repo** — they're several GB each
(8+ GB total across all regions) and are deliberately `.gitignore`d, so step
3/4 above will leave `/opt/metarboard-data/charts` empty. Copy them separately
from wherever you keep them (e.g. a dev machine that already has this repo
checked out with its charts), directly into the persistent data directory
(not `/opt/metarboard` — that's a symlink to the current release and gets
replaced by every update):

```bash
# run from the machine that HAS the charts, not from the Pi
rsync -avz --progress ~/GitHub/METARBoard/charts/ pi@<pi-ip>:/opt/metarboard-data/charts/
```

Then fix ownership and restart so the server picks them up (chart databases
are loaded once at startup):

```bash
ssh pi@<pi-ip> 'sudo chown -R metarboard:metarboard /opt/metarboard-data/charts && sudo systemctl restart metarboard'
```

Re-running `setup-pi.sh` later will not touch or delete this directory.

## 5b. Enable traffic aircraft info/icons (optional)

Live traffic (ADS-B via OpenSky) works without this step, but shows a
generic icon and no registration/model on click. To enable real aircraft
info and type-differentiated icons (helicopter/jet/GA/etc.), build a local
lookup database **once, on your own machine** (not the Pi — it needs
`devDependencies` installed, and there's no reason to make the Pi do a
616k-row CSV parse):

```bash
# from a checkout on your dev machine, with npm ci (not --omit=dev) already run
curl -o /tmp/aircraft-database-complete.csv \
  https://s3.opensky-network.org/data-samples/metadata/aircraft-database-complete-2025-08.csv
node provisioning/import-aircraft-db.js /tmp/aircraft-database-complete.csv
```

This produces `aircraft.db` (~40MB) in the repo root — not checked into
git (same reasoning as `charts/*.mbtiles`). Copy it to the Pi's persistent
data directory and restart:

```bash
rsync -avz aircraft.db pi@<pi-ip>:/opt/metarboard-data/aircraft.db
ssh pi@<pi-ip> 'sudo chown metarboard:metarboard /opt/metarboard-data/aircraft.db && sudo systemctl restart metarboard'
```

The server logs "Aircraft database not loaded" at startup and the
`/aircraft/batch` endpoint just returns `{}` if you skip this step — it's
optional, not required for the app to run.

## 6. Verify

```bash
systemctl status metarboard      # should show "active (running)"
journalctl -u metarboard -f      # live logs
curl -s http://localhost:8500/databaselist   # should list your chart regions, not []
```

Then open `http://<pi-ip>:8500` in a browser.

## 7. Configure

From any device on the same network (phone, laptop — no keyboard/mouse on
the appliance itself required), open:

```
http://<pi-ip>:8500/admin
```

This lets you set the home airport, and toggle the default radar background
and online map layer. Saving pushes a live-reload signal to the kiosk
display over its existing WebSocket connection, so it updates on its own
within a second or two — no need to touch the appliance.

There's no auth on this page (by design, for LAN-only appliance use) — don't
expose port 8500 to the open internet. For settings not covered by the admin
page (Stratux IP, ports, etc.), edit `/opt/metarboard-data/settings.json` directly
and `sudo systemctl restart metarboard`.

## 8. Kiosk display (no keyboard/mouse)

`setup-pi.sh` installs a `labwc` autostart entry (`~/.config/labwc/autostart`
for the desktop-login user, default `pi`) that launches Chromium in kiosk
mode pointed at the app on boot — fullscreen, no browser chrome, no desktop
taskbar. This requires:

- The full **Raspberry Pi OS (64-bit)** desktop image (not Lite) — see
  step 1.
- Autologin to desktop enabled for that user — also step 1. Without it, the
  desktop session (and therefore the kiosk browser) never starts.

Before launching Chromium, the autostart script also:
- Starts `swaybg` showing the METARBoard mark (`kiosk-loading-bg.png`) as
  the Wayland background, so there's branded content instead of a plain
  black screen during the gap between Plymouth's boot splash handing off
  and Chromium's first paint. Chromium's `--start-fullscreen` covers it
  completely once it paints - no need to kill it afterward.
- Waits for a real `200` from `/health` before ever launching Chromium -
  without this, Chromium routinely wins the boot race against
  `metarboard.service` and lands on its own `ERR_CONNECTION_REFUSED`
  interstitial for ~15-20s. The `curl --max-time` on this check is not
  optional - confirmed live that a single hung attempt with none can
  stall the whole loop forever, which is worse than the problem it fixes.
- Forces `--ozone-platform=wayland` explicitly rather than trusting
  Chromium's "auto" platform detection - confirmed live that combining
  the wait above with auto-detection made Chromium pick X11 instead and
  crash-loop with zero recovery ("Missing X server or $DISPLAY").

**Hiding the mouse cursor:** this kiosk has no mouse/touchpad attached,
but `labwc` still renders an idle cursor sprite regardless - there's no
config option to simply turn it off. `setup-pi.sh` installs a fully
transparent cursor theme (`provisioning/metarboard-blank-cursor/`,
prebuilt with `xcursorgen` - `labwc`'s environment file needs
`XCURSOR_THEME` set to an actual theme, not left unset, for this to take
effect) and points `~/.config/labwc/environment`'s `XCURSOR_THEME` at it,
appending rather than overwriting the keyboard settings already in that
file. Note that `grim` (used for all the screenshot verification
elsewhere in this doc) never captures the cursor either way - it lives on
a compositor overlay the wlr-screencopy protocol excludes by design - so
confirming this one requires actually looking at the physical screen.

After provisioning, `sudo reboot` and confirm the screen comes up directly
in the fullscreen map view with no login prompt or desktop visible. If
Chromium's whole process ever crashes, `lwrespawn` restarts it
automatically.

**Renderer-crash recovery:** `lwrespawn` can't see a crashed *tab* -
Chromium's browser process and window stay alive and just show its "Aw,
Snap!" interstitial (confirmed live: a reboot landed there and sat forever
with no recovery). `chromium-watchdog.sh` runs alongside it, polling the
page title over a loopback-only remote debugging port
(`--remote-debugging-port=9223`, bound to `127.0.0.1`, never reachable off
the device) and force-killing Chromium - so `lwrespawn` relaunches it - if
the real app title (`METAR Board`) isn't showing after several consecutive
checks. Verified live by forcing the same detect → kill → relaunch cycle
on the test Pi and confirming the kiosk came back healthy each time.

If the desktop user or `chromium` binary isn't found, `setup-pi.sh` skips
this step and prints a warning — check that you flashed the desktop image
and re-run the script.

**No desktop flash on boot:** labwc runs the stock Raspberry Pi OS
`/etc/xdg/labwc/autostart` *in addition to* the per-user one above -
confirmed live its `pcmanfm-pi` (wallpaper/desktop icons) and
`wf-panel-pi` (taskbar) were still launching and briefly visible before
Chromium's kiosk window came up and covered them, even though the user
autostart deliberately omits both. `setup-pi.sh` backs up the original
to `/etc/xdg/labwc/autostart.orig` and replaces it with
`provisioning/labwc-system-autostart`, which drops those two lines.
Like the autostart file itself, this lives outside `/opt/metarboard`, so
a device provisioned before this shipped needs it applied once manually.

**Status as of 2026-08-16:** the app itself (charts, radar, METARs, live
traffic) is fully working and verified on the test Pi (192.168.9.189). The
kiosk autostart file is installed and correct (confirmed via SSH), but a
`sudo reboot` + actually watching the attached display hasn't happened
yet — that's the next thing to verify once it's hooked up to a real
screen/TV. If it doesn't come up fullscreen on its own, check
`~/.config/labwc/autostart` is still in place and that autologin is
actually enabled (`raspi-config` → System Options → Boot / Auto Login).

### Boot splash

`setup-pi.sh` installs a custom Plymouth theme (`provisioning/plymouth/metarboard/`)
so the boot screen shows the METARBoard mark on navy instead of the stock
Raspberry Pi raspberries. The background color is set as the actual window
background (not baked into the logo image), so it fills the screen
edge-to-edge on any resolution/aspect the display reports.

Re-applying it on an already-provisioned device (or after changing the
logo/script) requires a full theme install + initramfs rebuild:

```bash
sudo mkdir -p /usr/share/plymouth/themes/metarboard
sudo cp provisioning/plymouth/metarboard/* /usr/share/plymouth/themes/metarboard/
sudo plymouth-set-default-theme -R metarboard
```

Like `~/.config/labwc/autostart`, this lives outside `/opt/metarboard` -
OTA updates never touch it, so a device provisioned before this shipped
needs this run once manually.

## 9. OTA updates

Every device checks for updates on its own (a systemd timer, once a day
with up to an hour of random jitter) and installs them automatically -
no SSH access to the field device required.

**How it works:** devices poll a separate **public** GitHub repo
(`METARBoard-releases`, set via `METARBOARD_RELEASES_REPO` if you name it
differently) that holds nothing but tagged Releases - two assets per
release, a tarball and a [minisign](https://jedisct1.github.io/minisign/)
signature over it. No GitHub auth is needed anywhere in this flow. The
private dev repo (this one) is never touched by any device. Once a
signature check passes, `provisioning/check-for-update.sh` extracts the
release into a new `/opt/metarboard-releases/vX.Y.Z/` directory, runs
`npm ci` there, atomically re-points the `/opt/metarboard` symlink at it,
restarts the service, and health-checks it (`GET /health`) - if that
fails, it rolls the symlink back to the previous release automatically.
`settings.json`, `charts/`, `aircraft.db`, and `.env` all live in
`/opt/metarboard-data/`, untouched by any of this.

Current version and last update result are shown at the top of `/admin`.

**One-time setup, before cutting your first release:**

1. Create a **public** repo named `METARBoard-releases` on GitHub - it
   should stay empty except for Releases you publish to it.
2. Generate a signing keypair: `minisign -G`. Keep the private key
   (`~/.minisign/minisign.key`) and its password safe - ideally not on a
   machine/session that also has push access to GitHub, so a compromised
   GitHub login alone can't produce a validly-signed malicious release.
3. Replace `provisioning/metarboard-release.pub` in this repo with your
   real public key (the placeholder committed here is for pipeline
   testing only, not a real trust anchor) and re-provision any devices
   that were set up before you did this, so they pick up the real key.

**Cutting a release** (from a machine with `gh` authenticated and
`minisign` installed):

```bash
# bump "version" in package.json first
./provisioning/build-release.sh
```

Devices pick it up on their next scheduled check, or immediately via
`sudo /opt/metarboard/provisioning/check-for-update.sh`.

## 10. Shipping to a customer (zero-SSH first-boot setup)

Steps 1-9 above are what *you* do once, ahead of time, to build a
device's SD card image (or a golden image you clone onto many). None of
it requires the customer to touch a command line - here's what happens
when they actually power the device on for the first time, with no WiFi
credentials on it yet:

1. `metarboard-network-setup.service` (runs automatically at boot, before
   the main app) detects there's no working network connection and
   starts an **open** WiFi hotspot named `METARBoard Setup`.
2. The kiosk display itself shows a big-screen instruction card (`public/
   setup-display.html`) - "connect your phone to this WiFi network /
   open a browser to this address" - not the wizard form itself. The
   customer does the actual setup on their **phone or laptop**: connect
   to the `METARBoard Setup` network, open a browser, and go to
   `http://10.42.0.1:8500` (NetworkManager's default gateway address for
   a shared/hotspot connection - confirm this is actually what's assigned
   when testing on real hardware, since this is customer-facing and
   worth getting exactly right).

   Both the TV and the phone hit the same `/` route while setup mode is
   active - `server.js` tells them apart by request origin (the kiosk's
   own Chromium always connects over loopback; a phone always comes in
   over the hotspot subnet) and serves the big-screen version to the TV,
   the interactive wizard to everything else. The TV's version polls the
   same `/setup/status` the wizard does, so it flips to "Connected!
   Loading your display…" and reloads into the map on its own once the
   phone finishes.
3. The wizard lists nearby WiFi networks, lets them pick one and enter
   its password (if secured), and set their home airport + timezone. An
   optional "Name This Display" field (e.g. "Front Desk") is also offered
   - see the hostname note below for why this matters once a customer has
   more than one unit.
4. On submit, the device connects to that network, saves the settings,
   and the kiosk display reloads into the normal map view - no reboot,
   no SSH, no command line. The success message reports the device's
   final mDNS address (e.g. `metarboard-front-desk.local:8500/admin`) so
   the customer has something to note down for later.

If setup is interrupted (power loss, walked away) the hotspot just stays
up - the device is never fully unreachable, and the customer can
reconnect and finish later. A device physically moved to a different
WiFi network later will drop back into setup mode on its own the next
time it can't connect, for the same reason.

### Hostname uniqueness

Every device imaged from the same golden SD card would otherwise share
the literal same hostname ("METARBoard") - confirmed live that this
breaks mDNS the moment a customer has more than one unit on their network
(a second device answered for the first one's `metarboard.local`).
`metarboard-hostname.service` (runs once, at first boot, before the
network setup check) assigns every device a hardware-derived unique
hostname automatically (`metarboard-<suffix>`, derived from the CPU
serial) - no customer input required, and guaranteed not to collide. If
the customer names their display during the setup wizard, that name
(slugified, e.g. "Front Desk" -> `metarboard-front-desk`) overrides the
auto-generated one; if they leave it blank, the auto-generated name is
what they'll see in the wizard's success message.

**Testing this yourself:** `sudo nmcli connection delete <your-wifi-profile-name>`
on a provisioned Pi and reboot it to simulate a customer's out-of-the-box
first boot.

## 11. Building a golden image for bulk flashing (CM5)

Once a device is fully provisioned (steps 1-9 above) and confirmed
working, you can capture its eMMC/SD as a "golden image" and flash that
directly onto other units instead of re-running setup-pi.sh on each one.

**Before capturing - reset everything that must be unique per device.**
A freshly-provisioned unit has already been through first boot once, so
it's not the blank slate a truly new unit would be. Skipping this step
means every device flashed from the image would share the same hostname,
SSH host keys, and machine-id - the exact mDNS collision bug the hostname
uniqueness feature (above) exists to prevent, reintroduced via imaging
instead of literal duplicate hostnames.

```bash
sudo systemctl stop metarboard
sudo rm -f /opt/metarboard-data/hostname-initialized   # re-enables set-unique-hostname.sh
sudo rm -f /opt/metarboard-data/settings.json          # falls back to settings.default.json
sudo rm -f /opt/metarboard-data/positionhistory.db /opt/metarboard-data/setup-attempt-status.json
sudo rm -rf ~/METARBoard                               # your provisioning checkout, not needed at runtime
sudo truncate -s 0 /etc/machine-id                     # triggers systemd's own first-boot detection...
sudo rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*  # ...which also regenerates SSH host keys
rm -f ~/.bash_history
sudo systemctl start metarboard
```

Leave `/opt/metarboard-data/charts`, `aircraft.db`, and `CURRENT_VERSION`
alone - those are exactly what you want every shipped unit to start with.

**Capturing the image (Compute Module 5).** A CM5's eMMC isn't a
removable card - it has to be exposed as a USB mass-storage device:

1. Fit the CM5's **EMMC-DISABLE / nRPIBOOT jumper** (BCM2712 GPIO 20) to
   force the boot ROM into USB boot mode instead of loading the normal
   bootloader. This is a physical jumper on the carrier/IO board - check
   yours if it's not the official Raspberry Pi CM5 IO board.
2. Connect the board's USB-C port to your Mac and power it on.
3. Build/run [`rpiboot`](https://github.com/raspberrypi/usbboot) on the
   Mac (`brew install libusb pkg-config`, then clone+`make
   INSTALL_PREFIX=/usr/local`), then:
   ```bash
   sudo rpiboot -d mass-storage-gadget
   ```
   Once it finishes, the eMMC shows up as a normal external disk in
   `diskutil list`.
4. Image it and compress the result:
   ```bash
   diskutil unmountDisk /dev/diskN
   sudo dd if=/dev/rdiskN bs=4m | gzip > metarboard-golden-v1.img.gz
   ```
   (`/dev/rdiskN`, the raw device, is much faster than the buffered
   `/dev/diskN`.) Store that file wherever you keep build artifacts.

**Bulk-flashing new units.** Connecting several jumpered CM5s to one
powered USB hub before running `rpiboot` lets it expose all of them as
separate disks at once - `provisioning/flash-cm5.sh` then writes the
golden image to as many of them in parallel as you confirm:

```bash
./provisioning/flash-cm5.sh /path/to/metarboard-golden-v1.img.gz
```

It only ever touches disks you explicitly type and re-confirm by name -
see the comments at the top of the script for the safety model (a `dd`
to the wrong `/dev/diskN` can destroy data on your Mac, not just the
CM5). Remove the EMMC-DISABLE jumper from each unit before powering it on
normally afterward, or it'll boot back into USB boot mode instead of the
flashed OS.

Each flashed unit still generates its own unique hostname/SSH
keys/machine-id on its real first boot, since that's derived from its own
CPU serial at runtime, not baked into the image.

## Re-provisioning / updating an existing Pi

Re-running `sudo ./provisioning/setup-pi.sh` from an updated checkout will
sync the new app code into `/opt/metarboard`, reinstall dependencies, and
restart the service — without touching the existing `settings.json` or the
chart/position-history databases already on the device.

## Troubleshooting

- **Service won't start / crash-loops:** `journalctl -u metarboard -n 100`
  for the actual error. `server.js` is designed to still start and serve a
  degraded response even if `settings.json` is corrupt or the database
  engine fails to load, so a total failure to start usually means a Node.js
  or `npm ci` problem — check `node -v` matches what's expected and that
  `/opt/metarboard/node_modules` exists.
- **Charts not showing / `databaselist` returns `[]`:** you likely haven't
  done step 5 yet (`charts/*.mbtiles` are not in git). Confirm the files
  exist and are readable by the `metarboard` user
  (`ls -la /opt/metarboard-data/charts`), then restart the service.
- **Update didn't apply / device stuck on an old version:** check
  `/admin`'s device status line, or `journalctl -u metarboard-update -n
  50` for the actual failure. A failed signature check, disk-space
  preflight, or `npm ci` all abort cleanly and leave the previous release
  running untouched - it'll retry on the next scheduled check. A failed
  post-update health check rolls back automatically and logs why.
- **Wrong chart region showing, or none at all:** there's no manual chart
  picker on the display anymore — the app always shows the single regional
  chart whose center is geographically closest to the home airport set in
  `/admin`. If nothing shows, double-check the home airport is set and is a
  real ICAO/FAA code the airports dataset recognizes.
- **Radar toggled on in `/admin` but nothing appears:** this is usually not
  a bug — the NEXRAD tiles are transparent wherever there's no precipitation,
  so a clear-weather view can legitimately look empty. Confirm it's actually
  requesting tiles by checking the browser's Network tab for requests to
  `mesonet.agron.iastate.edu`.
