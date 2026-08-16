# Provisioning a Pi from scratch

This turns a freshly-flashed Raspberry Pi into a running METARBoard appliance.

## 1. Flash the SD card

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to write
**Raspberry Pi OS Lite (64-bit)** to the SD card. In the imager's advanced
options (gear icon / Ctrl+Shift+X), enable SSH and set a hostname/username/
password (or an SSH key) so you can connect headless.

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

There's no setup wizard yet (see the project's productization plan for that
follow-up work) — edit `/opt/metarboard/settings.json` directly for things
like home airport (`localStorage` in the browser today), Stratux IP, ports,
etc., then:

```bash
sudo systemctl restart metarboard
```

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
