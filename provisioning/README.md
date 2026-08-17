# Provisioning a Pi from scratch

This turns a freshly-flashed Raspberry Pi into a running METARBoard appliance.

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

After provisioning, `sudo reboot` and confirm the screen comes up directly
in the fullscreen map view with no login prompt or desktop visible. If
Chromium ever crashes, `lwrespawn` restarts it automatically.

If the desktop user or `chromium` binary isn't found, `setup-pi.sh` skips
this step and prints a warning — check that you flashed the desktop image
and re-run the script.

**Status as of 2026-08-16:** the app itself (charts, radar, METARs, live
traffic) is fully working and verified on the test Pi (192.168.9.189). The
kiosk autostart file is installed and correct (confirmed via SSH), but a
`sudo reboot` + actually watching the attached display hasn't happened
yet — that's the next thing to verify once it's hooked up to a real
screen/TV. If it doesn't come up fullscreen on its own, check
`~/.config/labwc/autostart` is still in place and that autologin is
actually enabled (`raspi-config` → System Options → Boot / Auto Login).

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
2. The kiosk display itself shows the setup wizard (same port, same
   Chromium session - nothing extra to configure) - but the customer
   doesn't need to look at the TV at all. They connect their **phone or
   laptop** to the `METARBoard Setup` network, open a browser, and go to
   `http://10.42.0.1:8500` (NetworkManager's default gateway address for
   a shared/hotspot connection - confirm this is actually what's assigned
   when testing on real hardware, since this is customer-facing and
   worth getting exactly right).
3. The wizard lists nearby WiFi networks, lets them pick one and enter
   its password (if secured), and set their home airport + timezone.
4. On submit, the device connects to that network, saves the settings,
   and the kiosk display reloads into the normal map view - no reboot,
   no SSH, no command line.

If setup is interrupted (power loss, walked away) the hotspot just stays
up - the device is never fully unreachable, and the customer can
reconnect and finish later. A device physically moved to a different
WiFi network later will drop back into setup mode on its own the next
time it can't connect, for the same reason.

**Testing this yourself:** `sudo nmcli connection delete <your-wifi-profile-name>`
on a provisioned Pi and reboot it to simulate a customer's out-of-the-box
first boot.

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
