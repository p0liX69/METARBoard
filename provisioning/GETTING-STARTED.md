# Setting up METARBoard on a Raspberry Pi

These are the steps to get METARBoard running on a Raspberry Pi from
scratch - no pre-built image needed, just a Pi and an SD card.

## What you need

- A Raspberry Pi 4 or 5 (2GB RAM or more)
- A microSD card, 16GB or larger
- Power supply for the Pi
- A TV or monitor with an HDMI input (this is what will show the display)
- A computer to flash the SD card and SSH in from
- Internet access on the Pi (WiFi or Ethernet, either works for setup)

## 1. Flash the SD card

1. Download and install [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
   on your computer.
2. Insert the SD card into your computer.
3. Open Raspberry Pi Imager:
   - **Device:** your Pi model
   - **Operating System:** Raspberry Pi OS (64-bit) - the regular
     desktop version, not "Lite"
   - **Storage:** your SD card
4. Click the gear/settings icon (or "Edit Settings" when prompted) and:
   - Enable SSH, set a username/password you'll remember
   - If you want it on WiFi during setup, enter your WiFi network name/password here too (this is just to get the Pi itself online for setup - the customer-facing setup wizard later is separate and doesn't need this)
5. Write the image, then insert the card into the Pi and power it on.
   Give it about a minute to boot.

## 2. Connect to the Pi

Find its IP address (check your router's device list, or try
`ping raspberrypi.local`), then SSH in from your computer:

```bash
ssh <the username you set>@<the Pi's IP address>
```

## 3. Get the code onto the Pi

```bash
git clone https://github.com/p0liX69/METARBoard.git ~/METARBoard
cd ~/METARBoard
```

## 4. Run the setup script

```bash
sudo ./provisioning/setup-pi.sh
```

This installs everything needed (Node.js, the app, the kiosk display
config) and starts METARBoard automatically. It takes a few minutes -
let it finish.

## 5. Reboot and connect the display

```bash
sudo reboot
```

Plug the Pi into your TV/monitor via HDMI if you haven't already. After
it boots, the screen will show setup instructions - connect a phone or
laptop to the **METARBoard Setup** WiFi network it broadcasts, then
open a browser to `10.42.0.1`. From there you can:

- Pick your home WiFi network and enter the password
- Enter your home airport code (e.g. `KJFK`)
- Optionally name the display and set an admin password

Once you submit that, the Pi connects to your WiFi and the TV
automatically loads the live map - no further steps needed.

## Troubleshooting

- **Nothing shows on the TV:** double check the HDMI cable and that the
  Pi actually finished booting (the power LED should be solid, not
  blinking).
- **Can't find "METARBoard Setup" WiFi:** wait a minute after boot, then
  check your phone's WiFi list again - it only appears once the Pi
  decides it has no working network connection.
- **Made a mistake in setup:** just reconnect to "METARBoard Setup" and
  redo the wizard - nothing is permanent until you submit it.
- **Something else:** email support@metarboard.io with what you're
  seeing and we'll help sort it out.
