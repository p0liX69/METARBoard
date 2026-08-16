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
3/4 above will leave `/opt/metarboard/charts` empty. Copy them separately
from wherever you keep them (e.g. a dev machine that already has this repo
checked out with its charts), directly into the install directory:

```bash
# run from the machine that HAS the charts, not from the Pi
rsync -avz --progress ~/GitHub/METARBoard/charts/ pi@<pi-ip>:/opt/metarboard/charts/
```

Then fix ownership and restart so the server picks them up (chart databases
are loaded once at startup):

```bash
ssh pi@<pi-ip> 'sudo chown -R metarboard:metarboard /opt/metarboard/charts && sudo systemctl restart metarboard'
```

Re-running `setup-pi.sh` later will not touch or delete this directory.

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
page (Stratux IP, ports, etc.), edit `/opt/metarboard/settings.json` directly
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
  (`ls -la /opt/metarboard/charts`), then restart the service.
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
