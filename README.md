# METARBoard (based on ChartServer)

METARBoard is a Node.js web app for serving FAA sectional charts, METARs, TAFs, and PIREPs for use in aviation displays. It includes support for .mbtiles chart databases, WebSocket delivery of weather data, and a rich frontend built for displaying current flight conditions.

This project is based on [ChartServer by n129bz](https://github.com/n129bz/chartserver), with modifications for local deployments like Raspberry Pi-powered displays.

## Features

- Serves sectional, TAC, IFR enroute, and helicopter charts from MBTiles
- Displays weather overlays using:
  - METARs (color-coded for VFR, MVFR, IFR, LIFR)
  - TAFs and PIREPs
- Works offline (once tiles are downloaded)
- WebSocket-based real-time data delivery to browser clients
- Position tracking and ownship history
- Designed for large-screen wall displays

## Setup

### Raspberry Pi appliance install (recommended for a wall-display Pi)

See [`provisioning/README.md`](provisioning/README.md) for a script that
provisions a freshly-flashed Raspberry Pi end-to-end: installs Node.js,
creates a dedicated system user, and installs METARBoard as a self-healing
systemd service that starts on boot.

### Manual / development setup

### 1. Install dependencies

Ensure you have Node.js and npm installed. Then run:

```bash
npm install
```

### 2. Add chart databases

Place `.mbtiles` files into the `charts/` folder. You can generate these using the companion project [chartmaker](https://github.com/n129bz/chartmaker).

### 3. Run the app

```bash
node server.js
```

The server will start and listen on the port specified in `settings.json` (default: 8500). The WebSocket server runs on its own port (default: 8550).

### 4. Access the frontend

Open your browser and go to:

```
http://<your-device-ip>:8500
```

## Directory Structure

- `server.js`: Main Node.js server file
- `charts/`: Folder containing `.mbtiles` files
- `public/`: Static web frontend
- `settings.json`: Configuration (ports, map settings, etc.)
- `airports.json`: ICAO airport data with lat/lon
- `positionhistory.db`: Tracks user position over time

## Configuration

Edit `settings.json` to configure:

- Chart directory (`externalcharts`)
- Map settings (online vs offline base layer)
- ADDS weather URLs
- Update intervals
- WebSocket and HTTP ports

## Generating Charts

Use the [chartmaker](https://github.com/n129bz/chartmaker) tool to create `.mbtiles` files from FAA GeoTIFF charts. It handles tiling, merging, and packaging automatically.

## Credits

- [chartserver](https://github.com/n129bz/chartserver) — original project
- FAA VFR Sectional and Terminal charts (public domain)
- ADDS weather feed

## License

This project is provided under the MIT license. FAA chart data is public domain. Use at your own risk; not for navigation.
