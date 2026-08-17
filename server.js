const express = require('express');
const favicon = require('serve-favicon');
const cors = require('cors');
const url = require('url');
const fs = require("fs");
const { execFile } = require("child_process");
const WebSocket = require('ws');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const { XMLParser } = require('fast-xml-parser');
const { unzip, unzipSync } = require('zlib');

/**
 * These objects are used by the XMLParser to convert XML to JSON.
 * The alwaysArray object makes the parser translate sky_condition 
 * XML attributes as an array of values... which is good.
 */
const alwaysArray = [
    "response.data.METAR.sky_condition",
    "response.data.PIREP.sky_condition"
];
const xmlParseOptions = {
    ignoreAttributes : false,
    attributeNamePrefix : "",
    allowBooleanAttributes: true,
    ignoreDeclaration: true,
    isArray: (name, jpath, isLeafNode, isAttribute) => { 
        if( alwaysArray.indexOf(jpath) !== -1) return true;
    }
};
/**
 * now the actual parser object is instantiated with the above options
 */
const xmlparser = new XMLParser(xmlParseOptions);

/**
 * The sqlite database engine. Guarded because the native binary can fail to
 * load (wrong arch, missing prebuild) - if that happens we still want the
 * server to start and serve a diagnostic response instead of crash-looping.
 */
let Database = null;
try {
    Database = require('better-sqlite3');
}
catch (err) {
    console.log(`FATAL: failed to load better-sqlite3 native module: ${err.message}`);
}

/**
 * Global variables
 */
let airports = {};
let MessageTypes = {};

let wss;
let connections = new Map();

// Device-specific/mutable data (settings.json, charts/, aircraft.db,
// position history, .env) lives here instead of alongside the app code,
// so an OTA update can wholesale-replace __dirname's contents (a new
// versioned release directory) without touching any of it. Falls back to
// __dirname for local dev / any install that hasn't set this env var.
const DATA_DIR = process.env.METARBOARD_DATA_DIR || __dirname;

// Must match the SSID provisioning/network-setup-check.sh creates - used
// here only to exclude the hotspot from seeing itself in /setup/wifi-scan
// results.
const SETUP_HOTSPOT_SSID = "METARBoard Setup";

let DB_PATH = `${DATA_DIR}/charts`;

/**
 * Load settings.json, falling back to settings.default.json, and finally to
 * a minimal built-in default if both are missing or fail to parse - a fresh
 * or corrupted settings file must never prevent the server from starting.
 */
const BUILTIN_SETTINGS = {
    wxupdateintervalmsec: 480000,
    keepaliveintervalmsec: 30000,
    httpport: 8500,
    wsport: 8550,
    startupzoom: 9,
    useOSMonlinemap: false,
    homeAirport: "KHGR",
    showRadarByDefault: true,
    externalcharts: "",
    historyDb: "positionhistory.db",
    addscurrentxmlurl: "https://aviationweather.gov/data/cache/###.cache.xml",
    messagetypes: {
        metars: { type: "metars", token: "###" },
        tafs: { type: "tafs", token: "###" },
        pireps: { type: "aircraftreports", token: "###" },
        airports: { type: "airports", token: "" },
        keepalive: { type: "keepalive", token: "((💜))" }
    }
};

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(`${DATA_DIR}/settings.json`));
    }
    catch (err) {
        console.log(`WARNING: failed to load settings.json: ${err.message}`);
    }
    try {
        console.log("Falling back to settings.default.json");
        return JSON.parse(fs.readFileSync(`${__dirname}/settings.default.json`));
    }
    catch (err) {
        console.log(`WARNING: failed to load settings.default.json: ${err.message}`);
    }
    console.log("Using built-in fallback settings");
    return JSON.parse(JSON.stringify(BUILTIN_SETTINGS));
}

/**
 * Atomically write settings.json (write to a temp file, then rename over
 * the real file) so a power loss mid-write can't leave it corrupted.
 */
function writeSettings(newSettings) {
    let target = `${DATA_DIR}/settings.json`;
    let tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(newSettings, null, "    "));
    fs.renameSync(tmp, target);
}

let settings = loadSettings();

// FAA's public "Class Airspace" dataset (Class B/C/D surface areas), public
// domain federal data, no API key required.
const FAA_AIRSPACE_URL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query";
let homeAirspaceCache = new Map();

// FAA's public TFR site (tfr.faa.gov) - list/metadata API and GeoServer WFS
// boundary-geometry API, both public and unauthenticated.
const FAA_TFR_LIST_URL = "https://tfr.faa.gov/tfrapi/getTfrList";
const FAA_TFR_WFS_URL = "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsname=EPSG:4326";
const TFR_CACHE_TTL_MS = 15 * 60 * 1000;
let tfrCache = { data: null, fetchedAt: 0 };

// NWS/FAA public "FD" winds-and-temperatures-aloft text product. Fixed
// station list of ~180 major airports (not every field), so the home
// airport's actual station is usually a nearest-neighbor match, not an
// exact one - see /windsaloft below.
const WINDS_ALOFT_URL = "https://aviationweather.gov/api/data/windtemp?region=us&level=low&fcst=06";
const WINDS_ALOFT_CACHE_TTL_MS = 30 * 60 * 1000;
const WINDS_ALOFT_MAX_STATION_DISTANCE_NM = 150;
let windsAloftCache = { data: null, fetchedAt: 0 };
const airportCoordsByIdent = new Map();

function haversineNm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadiusNm = 3440.065;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusNm * Math.asin(Math.sqrt(a));
}

/**
 * Decode one FD cell for a low-altitude level (3000-12000ft, where a
 * temperature - if present - always has an explicit +/- sign; the
 * implicit-always-negative-above-24000ft format doesn't apply at these
 * altitudes, so this deliberately doesn't need to handle it).
 * @param {string} raw trimmed cell text, e.g. "2007+10", "9900+15", "0208", or ""
 * @returns {object|null} null if no forecast for this station/level
 */
function decodeWindCell(raw) {
    if (!raw) return null;

    if (raw.startsWith("9900")) {
        // Light and variable - wind under 5kt, direction not meaningful.
        const tempMatch = raw.slice(4).match(/^([+-]\d{2})$/);
        return { lightAndVariable: true, direction: null, speed: null, tempC: tempMatch ? Number(tempMatch[1]) : null };
    }

    const match = raw.match(/^(\d{2})(\d{2})([+-]\d{2})?$/);
    if (!match) return null;

    let directionTens = Number(match[1]);
    let speed = Number(match[2]);
    const tempC = match[3] ? Number(match[3]) : null;

    // Speeds >=100kt: 50 is added to the direction-tens digit and 100
    // subtracted from speed at encode time (e.g. 240deg/105kt -> "7405").
    if (directionTens >= 51) {
        directionTens -= 50;
        speed += 100;
    }

    return { lightAndVariable: false, direction: directionTens * 10, speed, tempC };
}

/**
 * Parse the FD product's fixed-width-ish text into {stationCode: [cell, cell, ...]}
 * for just the low-altitude levels (3000/6000/9000/12000ft) - field
 * boundaries are derived from the header row's altitude label positions,
 * not naive whitespace-splitting, since a station with no forecast at an
 * early level (common - see the module comment) collapses that column
 * entirely rather than leaving a fixed-width blank.
 */
function parseLowAltitudeWindsAloft(text) {
    const lines = text.split("\n");
    const headerLine = lines.find((line) => line.startsWith("FT "));
    if (!headerLine) return new Map();

    const labelEnds = [...headerLine.matchAll(/\d{4,5}/g)].map((m) => m.index + m[0].length);
    const fieldBounds = [3, ...labelEnds].slice(0, 5); // station code + first 4 low levels

    const stations = new Map();
    for (const line of lines) {
        const stationMatch = line.match(/^([A-Z0-9]{3,4}) /);
        if (!stationMatch) continue;

        const cells = [];
        for (let i = 0; i < fieldBounds.length - 1; i++) {
            cells.push(line.slice(fieldBounds[i], fieldBounds[i + 1]).trim());
        }
        stations.set(stationMatch[1], cells);
    }
    return stations;
}

/******************************************************
   if running in a docker container, check to see if an
   external volume for the database folder exists, if so,
   use it
*******************************************************/
function isRunningInDocker() {
    let isdocker = fs.existsSync('/.dockerenv');
    if (isdocker) {
        console.log("Running in docker!");
    }
    return isdocker;
}

/**
 * Non-blocking check for internet access, used to decide whether
 * the frontend can use the online OSM base map layer
 */
async function hasInternetAccess() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch('https://www.google.com', { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok;
    }
    catch (err) {
        return false;
    }
}

if (isRunningInDocker()) {
    if (fs.existsSync(`${DATA_DIR}/externalcharts`)) {
        DB_PATH = `${DATA_DIR}/externalcharts`;
    }
}
else {
    if (settings.externalcharts.length > 0) {
        if (fs.existsSync(settings.externalcharts)) {
            DB_PATH = settings.externalcharts;
        }
    }
}

let histdb;
let aircraftDb;
const databaselist = new Map();
const databases    = new Map();
const metadatasets = new Map();

/*
 * Load airports.json for immediate sending to client later upon winsock connection
 */
(() => {
    // check for internet access to see if OSM online maps can be used
    if (!settings.useOSMonlinemap) {
        hasInternetAccess().then((isOnline) => {
            settings.useOSMonlinemap = isOnline;
            writeSettings(settings);
        });
    }

    MessageTypes   = settings.messagetypes;
    try {
        let dbfiles    = fs.readdirSync(DB_PATH);
        dbfiles.forEach((dbname) => {
            if (dbname.endsWith(".db") || dbname.endsWith(".mbtiles")) {
                var key = dbname.toLowerCase().split(".")[0];
                var dbfile = `${DB_PATH}/${dbname}`;
                databaselist.set(key, dbfile);
            }
        });
    }
    catch(err) {
        console.log("NO CHART DATABASES FOUND!!");
    }

    rawdata = fs.readFileSync(`${__dirname}/airports.json`);
    airports = JSON.parse(rawdata);
    (airports.airports || []).forEach((airport) => {
        airportCoordsByIdent.set(airport.ident, { lat: airport.lat, lon: airport.lon });
    });

    wss = new WebSocket.Server({ port: settings.wsport });
    try {
        wss.on('connection', (ws) => {
            const id = Date.now();
            connections.set(ws, id);
            console.log(`Websocket connected, id: ${id}`);

            setTimeout(() => {
                let msg = {
                    type: "airports",
                    payload: JSON.stringify(airports)
                };
                ws.send(JSON.stringify(msg));
                runDownloads();
            }, 200);

            ws.on('close', function() {
                connections.delete(ws);
                console.log("connection closed");
            });

            ws.on('message', (data) => { });
        });
    }
    catch (err) {
        console.log(err);
    }
})();

loadDatabases();

loadMetadatasets();

function loadDatabases() {
    if (!Database) {
        console.log("Database engine unavailable - chart tiles and position history are disabled.");
        return;
    }

    databaselist.forEach((dbfile, key) => {
        try {
            let db = new Database(dbfile, { readonly: true, fileMustExist: true });
            databases.set(key, db);
        }
        catch (err) {
            console.log(`Failed to load: ${key}: ${err.message}`);
        }
    });

    try {
        histdb = new Database(`${DATA_DIR}/${settings.historyDb}`);
    }
    catch (err) {
        console.log(`Failed to load: ${settings.historyDb}: ${err.message}`);
    }

    // Optional: only present once provisioning/import-aircraft-db.js has
    // been run manually. Traffic metadata lookups just come back empty
    // without it - not a startup requirement.
    try {
        aircraftDb = new Database(`${DATA_DIR}/aircraft.db`, { fileMustExist: true });
    }
    catch (err) {
        console.log(`Aircraft database not loaded (run provisioning/import-aircraft-db.js to enable it): ${err.message}`);
    }
}

/**
 * Start the express web server
 */
let app = express();
try {
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json({}));
    app.use(cors());
    app.use(favicon(`${__dirname }/images/favicon.png`));
    console.log(`Server listening on port ${settings.httpport}`);
    app.listen(settings.httpport, '0.0.0.0'); 

    let appOptions = {
        dotfiles: 'ignore',
        etag: false,
        extensions: ['html'],
        index: false,
        redirect: false,
        setHeaders: function (res, path, stat) {
            res.set('x-timestamp', Date.now());
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader('Access-Control-Allow-Methods', '*');
            res.setHeader("Access-Control-Allow-Headers", "*");
        }
    };

    app.use(express.static(`${__dirname}/public`, appOptions));
    
    // provisioning/network-setup-check.sh (root, runs before this service
    // starts) writes this flag when the device has no working network
    // connection and has started an open setup hotspot instead. While
    // it's present, the kiosk browser is served the setup wizard instead
    // of the map - same port/process, no second web server.
    const SETUP_MODE_FLAG = `${DATA_DIR}/setup-mode-active`;
    const isSetupModeActive = () => fs.existsSync(SETUP_MODE_FLAG);

    app.get('/', (req, res) => {
        if (isSetupModeActive()) {
            res.sendFile(`${__dirname}/public/setup.html`);
            return;
        }
        res.sendFile(`${__dirname}/public/index.html`);
    });

    app.get('/admin', (req, res) => {
        res.sendFile(`${__dirname}/public/admin.html`);
    });

    // Setup-mode-only routes - 404 once setup is complete (SETUP_MODE_FLAG
    // gone), so there's no lingering wifi-scan/connect attack surface on
    // an already-provisioned device.
    app.get('/setup/wifi-scan', (req, res) => {
        if (!isSetupModeActive()) {
            res.writeHead(404);
            res.end();
            return;
        }

        execFile('nmcli', ['-t', '-f', 'SSID,SECURITY,SIGNAL', 'device', 'wifi', 'list'], (err, stdout) => {
            if (err) {
                console.log("Failed to scan wifi networks:", err.message);
                res.writeHead(502);
                res.end(JSON.stringify({ error: "Failed to scan for WiFi networks" }));
                return;
            }

            const seen = new Set();
            const networks = stdout.trim().split("\n").flatMap((line) => {
                const [ssid, security, signal] = line.split(":");
                if (!ssid || ssid === SETUP_HOTSPOT_SSID || seen.has(ssid)) return [];
                seen.add(ssid);
                return [{ ssid, secured: security !== "--" && security !== "", signal: Number(signal) || 0 }];
            }).sort((a, b) => b.signal - a.signal);

            res.writeHead(200);
            res.end(JSON.stringify(networks));
        });
    });

    const SETUP_STATUS_FILE = `${DATA_DIR}/setup-attempt-status.json`;

    function writeSetupStatus(state, message) {
        try {
            const tmp = `${SETUP_STATUS_FILE}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ state, message, at: new Date().toISOString() }));
            fs.renameSync(tmp, SETUP_STATUS_FILE);
        }
        catch (err) {
            console.log("Failed to write setup status:", err.message);
        }
    }

    // Polled by public/setup.html - both the phone that submitted the
    // form (after it reconnects to the still-alive hotspot, if the
    // attempt failed) and the kiosk's own copy of the page (waiting to
    // reload once it sees "success").
    app.get('/setup/status', (req, res) => {
        // Read into a local var before writing any headers - writeHead()
        // was previously called before this read, so a mid-poll race with
        // writeSetupStatus() rewriting the file could throw here *after*
        // headers were already sent, hitting ERR_HTTP_HEADERS_SENT in the
        // catch block below (confirmed live on the setup wizard).
        let body;
        try {
            body = fs.readFileSync(SETUP_STATUS_FILE);
        }
        catch (err) {
            body = JSON.stringify({ state: "idle" });
        }
        res.writeHead(200);
        res.end(body);
    });

    app.post('/setup/complete', (req, res) => {
        if (!isSetupModeActive()) {
            res.writeHead(404);
            res.end();
            return;
        }

        const ssid = String(req.body?.ssid || "").trim();
        const password = String(req.body?.password || "");
        const homeAirport = SETTINGS_VALIDATORS.homeAirport(req.body?.homeAirport);
        const timezone = SETTINGS_VALIDATORS.timezone(req.body?.timezone);

        if (!ssid) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "A WiFi network is required" }));
            return;
        }
        if (!homeAirport) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Home airport must be a 3-4 character ICAO/FAA code" }));
            return;
        }

        // Respond BEFORE touching the network - connecting to a new WiFi
        // network requires freeing wlan0 from the setup hotspot first
        // (confirmed live: a device actively running an open AP can't
        // scan for other networks at all, so attempting to connect
        // without doing this first reliably fails with "No network with
        // SSID found" - not a password problem, but this response's own
        // transport is the hotspot link the caller is currently on, so
        // this has to go out first, before that link gets torn down.
        writeSetupStatus("connecting", "Connecting - this will disconnect you from the Setup network");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, connecting: true }));

        execFile('nmcli', ['connection', 'down', SETUP_HOTSPOT_SSID], () => {
            // Delete any existing profile for this SSID first - confirmed
            // live that a stale/partial profile (e.g. one NetworkManager
            // auto-creates on its own when it sees a known SSID, or a
            // leftover from an earlier failed attempt) can get reused
            // instead of a fresh one built from the password just
            // submitted, failing with a confusing "key-mgmt property is
            // missing" error that has nothing to do with the real
            // password. Ignoring the error here - it's expected to fail
            // when no such profile exists yet.
            execFile('nmcli', ['connection', 'delete', ssid], () => {
                const connectArgs = ["device", "wifi", "connect", ssid];
                if (password) connectArgs.push("password", password);

                execFile('nmcli', connectArgs, { timeout: 45000 }, (err, stdout, stderr) => {
                    if (err) {
                        const reason = (stderr || err.message || "").trim();
                        console.log("Failed to connect to wifi:", reason);
                        writeSetupStatus("failed", reason || "Could not connect - check the password and try again");
                        execFile('nmcli', ['connection', 'up', SETUP_HOTSPOT_SSID], (hotspotErr) => {
                            if (hotspotErr) console.log("Failed to restore setup hotspot:", hotspotErr.message);
                        });
                        return;
                    }

                    const currentSettings = loadSettings();
                    const newSettings = { ...currentSettings, homeAirport };
                    if (timezone) newSettings.timezone = timezone;
                    writeSettings(newSettings);

                    try {
                        fs.unlinkSync(SETUP_MODE_FLAG);
                    }
                    catch (unlinkErr) {
                        console.log("Failed to clear setup-mode flag:", unlinkErr.message);
                    }

                    writeSetupStatus("success", `Connected to ${ssid}`);
                });
            });
        });
    });

    // Used by the OTA updater (provisioning/check-for-update.sh) to decide
    // whether a freshly-swapped-in release actually works before keeping
    // it - a syntax error or crash on startup means this route (and
    // everything else) never responds at all, which the updater's retry
    // loop already treats as unhealthy. The one thing worth asserting
    // explicitly here is that settings.json actually parses, since a
    // release could otherwise "start" against a corrupt settings file and
    // still look alive. Chart/aircraft DB status is reported but doesn't
    // affect the health verdict - both are legitimately optional.
    app.get("/health", (req, res) => {
        let settingsLoaded = false;
        try {
            JSON.parse(fs.readFileSync(`${DATA_DIR}/settings.json`));
            settingsLoaded = true;
        }
        catch (err) {
            settingsLoaded = false;
        }

        res.writeHead(settingsLoaded ? 200 : 500);
        res.end(JSON.stringify({
            status: settingsLoaded ? "ok" : "unhealthy",
            settingsLoaded,
            chartsLoaded: databaselist.size > 0,
            historyDbOpen: !!(histdb && histdb.open),
            aircraftDbOpen: !!(aircraftDb && aircraftDb.open)
        }));
    });

    // Last OTA update check/result, written by check-for-update.sh, so
    // Todd (or a customer) can see fleet health from /admin without SSH.
    app.get("/updatestatus", (req, res) => {
        try {
            const rawdata = fs.readFileSync(`${DATA_DIR}/update-status.json`);
            res.writeHead(200);
            res.end(rawdata);
        }
        catch (err) {
            res.writeHead(200);
            res.end(JSON.stringify({ status: "unknown", message: "No update check has run yet" }));
        }
    });

    app.get("/getsettings", (req, res) => {
    let rawdata = fs.readFileSync(`${DATA_DIR}/settings.json`);
    let json = JSON.parse(rawdata);

    res.writeHead(200);
    res.write(JSON.stringify(json));
    res.end();
    });

    // Whitelisted subset of settings.json that the admin page (and the
    // on-screen home-airport control) may update remotely. Each validator
    // returns the sanitized value, or undefined if the value is invalid.
    const SETTINGS_VALIDATORS = {
        homeAirport: (value) => {
            const icao = String(value || "").trim().toUpperCase();
            return /^[A-Z0-9]{3,4}$/.test(icao) ? icao : undefined;
        },
        showRadarByDefault: (value) => (typeof value === "boolean" ? value : undefined),
        useOSMonlinemap: (value) => (typeof value === "boolean" ? value : undefined),
        startupzoom: (value) => {
            const zoom = Number(value);
            return Number.isInteger(zoom) && zoom >= 1 && zoom <= 20 ? zoom : undefined;
        },
        timezone: (value) => {
            try {
                Intl.DateTimeFormat('en-US', { timeZone: value });
                return value;
            }
            catch {
                return undefined;
            }
        },
        favoriteAirports: (value) => {
            if (!Array.isArray(value)) return undefined;
            const idents = value
                .map((v) => String(v || "").trim().toUpperCase())
                .filter((v) => /^[A-Z0-9]{3,4}$/.test(v))
                .slice(0, 6);
            return idents;
        },
        nightDimEnabled: (value) => (typeof value === "boolean" ? value : undefined),
        nightDimStart: (value) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined),
        nightDimEnd: (value) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined),
        nightDimOpacity: (value) => {
            const opacity = Number(value);
            return Number.isInteger(opacity) && opacity >= 0 && opacity <= 90 ? opacity : undefined;
        }
    };

    app.post("/savesettings", (req, res) => {
        const updates = {};

        for (const key of Object.keys(SETTINGS_VALIDATORS)) {
            if (!(key in req.body)) continue;
            const validated = SETTINGS_VALIDATORS[key](req.body[key]);
            if (validated === undefined) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: `Invalid value for ${key}` }));
                return;
            }
            updates[key] = validated;
        }

        const currentSettings = loadSettings();
        const newSettings = { ...currentSettings, ...updates };
        writeSettings(newSettings);
        sendMessageToClients(JSON.stringify({ type: "settingsupdated", payload: "{}" }));

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, settings: newSettings }));
    });

    // Proxies OpenSky traffic requests so credentials stay server-side and
    // the browser isn't subject to OpenSky's CORS restrictions. OpenSky uses
    // OAuth2 client-credentials auth (OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET
    // in /opt/metarboard/.env, never committed to git) - the access token is
    // cached and refreshed shortly before its ~30 minute expiry.
    app.get("/opensky/states", async (req, res) => {
        try {
            const { lamin, lomin, lamax, lomax } = req.query;
            const params = new URLSearchParams({ lamin, lomin, lamax, lomax });

            const token = await getOpenSkyAccessToken();
            const headers = token ? { Authorization: `Bearer ${token}` } : {};

            const openSkyResponse = await fetch(`https://opensky-network.org/api/states/all?${params}`, { headers });
            const rawBody = await openSkyResponse.text();
            let data;
            try {
                data = JSON.parse(rawBody);
            }
            catch {
                console.log(`OpenSky returned a non-JSON response (status ${openSkyResponse.status}): ${rawBody}`);
                res.writeHead(502);
                res.end(JSON.stringify({ error: "OpenSky returned an unexpected response" }));
                return;
            }
            res.writeHead(openSkyResponse.status);
            res.end(JSON.stringify(data));
        }
        catch (err) {
            console.log(err);
            res.writeHead(502);
            res.end(JSON.stringify({ error: "Failed to fetch OpenSky traffic" }));
        }
    });

    // Batch icao24 -> {registration, manufacturer, model, operator, category}
    // lookup against the optional local aircraft database (see
    // provisioning/import-aircraft-db.js). Returns {} for every icao24 if
    // the database hasn't been imported.
    app.post("/aircraft/batch", (req, res) => {
        const icao24s = Array.isArray(req.body?.icao24s) ? req.body.icao24s : [];
        const result = {};

        if (aircraftDb && icao24s.length > 0) {
            const placeholders = icao24s.map(() => "?").join(",");
            const stmt = aircraftDb.prepare(
                `SELECT icao24, registration, manufacturer, model, operator, category FROM aircraft WHERE icao24 IN (${placeholders})`
            );
            const sanitized = icao24s.map((v) => String(v).toLowerCase());
            for (const row of stmt.all(...sanitized)) {
                result[row.icao24] = {
                    registration: row.registration,
                    manufacturer: row.manufacturer,
                    model: row.model,
                    operator: row.operator,
                    category: row.category
                };
            }
        }

        res.writeHead(200);
        res.end(JSON.stringify(result));
    });

    // Real FAA Class B/C/D/E-surface airspace boundary for the current home
    // airport, so the kiosk display can outline it instead of just marking
    // the airport with a dot. Queries the FAA's public Class Airspace
    // FeatureServer directly (no API key, public-domain federal data) and
    // caches the result per ICAO id in memory - airspace boundaries don't
    // change during a server's lifetime, so there's no need to re-fetch on
    // every page load. Returns an empty FeatureCollection (not an error) for
    // airports with no charted controlled airspace, or on any fetch failure.
    app.get("/homeairspace", async (req, res) => {
        const currentSettings = loadSettings();
        const icao = String(currentSettings.homeAirport || "").trim().toUpperCase();
        const emptyCollection = { type: "FeatureCollection", features: [] };

        if (!/^[A-Z0-9]{3,4}$/.test(icao)) {
            res.writeHead(200);
            res.end(JSON.stringify(emptyCollection));
            return;
        }

        if (homeAirspaceCache.has(icao)) {
            res.writeHead(200);
            res.end(JSON.stringify(homeAirspaceCache.get(icao)));
            return;
        }

        try {
            const params = new URLSearchParams({
                where: `ICAO_ID='${icao}'`,
                outFields: "IDENT,ICAO_ID,NAME,CLASS,LOCAL_TYPE,UPPER_VAL,LOWER_VAL",
                f: "geojson"
            });
            const response = await fetch(`${FAA_AIRSPACE_URL}?${params}`);
            const geojson = await response.json();

            // A busy Class B airport reports 20+ overlapping altitude
            // "shelves" of the same wedding-cake airspace - keep only the
            // surface-touching shelf of each distinct boundary (Mode C veil,
            // Class B core, Class D, etc.), deduped by name, so the display
            // shows a handful of clean nested outlines instead of a mess of
            // redundant rings.
            let result = emptyCollection;
            if (geojson?.type === "FeatureCollection") {
                const seenNames = new Set();
                const surfaceFeatures = geojson.features.filter((feature) => {
                    if (feature.properties?.LOWER_VAL !== 0) return false;
                    const name = feature.properties?.NAME;
                    if (seenNames.has(name)) return false;
                    seenNames.add(name);
                    return true;
                });
                result = { type: "FeatureCollection", features: surfaceFeatures };
            }

            homeAirspaceCache.set(icao, result);
            res.writeHead(200);
            res.end(JSON.stringify(result));
        }
        catch (err) {
            console.log(`Failed to fetch FAA airspace boundary for ${icao}:`, err);
            res.writeHead(200);
            res.end(JSON.stringify(emptyCollection));
        }
    });

    // Active FAA Temporary Flight Restrictions (nationwide - TFRs aren't
    // specific to the home airport). FAA's tfr.faa.gov site is a public,
    // unauthenticated Nuxt app backed by a REST API (TFR list/metadata) and
    // a GeoServer WFS instance (boundary polygons) - there's no single feed
    // with both, so this joins them on notam_id/NOTAM_KEY. Refetched at most
    // every TFR_CACHE_TTL_MS, since unlike airspace boundaries these change
    // throughout the day.
    app.get("/tfrs", async (req, res) => {
        const emptyCollection = { type: "FeatureCollection", features: [] };

        if (tfrCache.data && Date.now() - tfrCache.fetchedAt < TFR_CACHE_TTL_MS) {
            res.writeHead(200);
            res.end(JSON.stringify(tfrCache.data));
            return;
        }

        try {
            const [listResponse, wfsResponse] = await Promise.all([
                fetch(FAA_TFR_LIST_URL),
                fetch(FAA_TFR_WFS_URL)
            ]);
            const list = await listResponse.json();
            const wfs = await wfsResponse.json();

            const listByNotamId = new Map(
                Array.isArray(list) ? list.map((tfr) => [tfr.notam_id, tfr]) : []
            );

            const features = (wfs?.features || []).flatMap((feature) => {
                const notamKey = feature.properties?.NOTAM_KEY || "";
                const notamId = notamKey.split("-")[0];
                const tfr = listByNotamId.get(notamId);
                if (!tfr) return [];

                return [{
                    type: "Feature",
                    geometry: feature.geometry,
                    properties: {
                        notam_id: notamId,
                        type: tfr.type,
                        description: tfr.description,
                        state: tfr.state
                    }
                }];
            });

            tfrCache = { data: { type: "FeatureCollection", features }, fetchedAt: Date.now() };
            res.writeHead(200);
            res.end(JSON.stringify(tfrCache.data));
        }
        catch (err) {
            console.log("Failed to fetch FAA TFRs:", err);
            res.writeHead(200);
            res.end(JSON.stringify(tfrCache.data || emptyCollection));
        }
    });

    // Winds/temps aloft (low altitudes only - see parseLowAltitudeWindsAloft)
    // for the FD collective station nearest the home airport. The FD
    // station list covers ~180 major airports, not every field, so this is
    // almost always a nearest-neighbor match rather than an exact one -
    // the response reports which station and how far away it is so the
    // client can show that honestly instead of implying it's the home
    // airport's own forecast.
    app.get("/windsaloft", async (req, res) => {
        const empty = { station: null, distanceNm: null, levels: [] };
        const currentSettings = loadSettings();
        const homeIdent = String(currentSettings.homeAirport || "").trim().toUpperCase();
        const homeCoords = airportCoordsByIdent.get(homeIdent);

        if (!homeCoords) {
            res.writeHead(200);
            res.end(JSON.stringify(empty));
            return;
        }

        try {
            if (!windsAloftCache.data || Date.now() - windsAloftCache.fetchedAt >= WINDS_ALOFT_CACHE_TTL_MS) {
                const response = await fetch(WINDS_ALOFT_URL);
                const text = await response.text();
                windsAloftCache = { data: parseLowAltitudeWindsAloft(text), fetchedAt: Date.now() };
            }

            let nearestStation = null;
            let nearestDistanceNm = Infinity;
            for (const stationCode of windsAloftCache.data.keys()) {
                const stationCoords = airportCoordsByIdent.get(`K${stationCode}`);
                if (!stationCoords) continue;
                const distanceNm = haversineNm(homeCoords.lat, homeCoords.lon, stationCoords.lat, stationCoords.lon);
                if (distanceNm < nearestDistanceNm) {
                    nearestDistanceNm = distanceNm;
                    nearestStation = stationCode;
                }
            }

            if (!nearestStation || nearestDistanceNm > WINDS_ALOFT_MAX_STATION_DISTANCE_NM) {
                res.writeHead(200);
                res.end(JSON.stringify(empty));
                return;
            }

            const altitudes = [3000, 6000, 9000, 12000];
            const cells = windsAloftCache.data.get(nearestStation);
            const levels = cells
                .map((cell, i) => ({ altitude: altitudes[i], ...decodeWindCell(cell) }))
                .filter((level) => level.direction !== undefined || level.lightAndVariable);

            res.writeHead(200);
            res.end(JSON.stringify({
                station: nearestStation,
                distanceNm: Math.round(nearestDistanceNm),
                levels
            }));
        }
        catch (err) {
            console.log("Failed to fetch winds aloft:", err);
            res.writeHead(200);
            res.end(JSON.stringify(empty));
        }
    });

    app.get("/databaselist", (req, res) => {
        let obj = [];
        databaselist.forEach((value, key) => {
            obj.push(key);
        });
        let rawdata = JSON.stringify(obj);
        res.writeHead(200);
        res.write(rawdata);
        res.end();
    });

    app.get("/metadatasets", (req, res) => {
        let dbs = [];
        console.log("metadatasets count = ", metadatasets.size);
        metadatasets.forEach((item, key) => {
            let lineitem = {};
            lineitem["key"] = key;
            lineitem["value"] = item;
            dbs.push(lineitem);
        });
        let rawdata = JSON.stringify(dbs);
        res.writeHead(200);
        res.write(rawdata);
        res.end();
    });    

    app.get("/tiles/*", (req, res) => {
        let parts = req.url.split("/");
        let db = databases.get(parts[2]);
        handleTile(req, res, db);
    });

    app.get("/gethistory", (req,res) => {
        getPositionHistory(res);
    });

    app.post("/savehistory", (req, res) => {
        savePositionHistory(req.body);
        res.writeHead(200);
        res.end();
    });
}
catch (err) {
    console.log(err);
}

/**
 * Get the last recorded ownship position from the position history database
 * @param {response} http response 
 */
function getPositionHistory(response) {
    if (!histdb) {
        response.writeHead(503);
        response.end();
        return;
    }
    try {
        let sql = "SELECT * FROM position_history WHERE id IN ( SELECT max( id ) FROM position_history )";
        let row = histdb.prepare(sql).get();
        if (row !== undefined) {
            let obj = {
                longitude: row.longitude,
                latitude: row.latitude,
                heading: row.heading
            };
            response.writeHead(200);
            response.write(JSON.stringify(obj));
            response.end();
        }
        else {
            response.writeHead(200);
            response.end();
        }
    }
    catch (err) {
        console.log(err);
        response.writeHead(500);
        response.end();
    }
}

/**
 * Update the position history database with current position data
 * @param {json object} data, contains date, longitude, latitude, heading, and altitude 
 */
function savePositionHistory(data) {
    if (!histdb) {
        console.log("Cannot save position history: database engine unavailable.");
        return;
    }
    let datetime = new Date().toISOString();
    let sql = `INSERT INTO position_history (datetime, longitude, latitude, heading, gpsaltitude) ` +
              `VALUES (?, ?, ?, ?, ?)`;
    let params = [datetime, data.longitude, data.latitude, data.heading, data.altitude];

    try {
        histdb.prepare(sql).run(...params);
        console.log(`position: ${params.join(', ')}`);
    }
    catch (err) {
        console.log(err);
    }
}

/**
 * Parse the z,x,y integers, validate, and pass along to loadTile
 * @param {request} http request 
 * @param {response} http response 
 * @param {db} database 
 * @returns the results of calling loadTile
 */
function handleTile(request, response, db) {
    let x = 0;
    let y = 0;
    let z = 0;
    let idx = -1;

    let parts = request.url.split("/"); 
	if (parts.length < 5) {
		return
	}

	try {
        idx = parts.length - 1;
        let yparts = parts[idx].split(".");
        y = parseInt(yparts[0])

    } 
    catch(err) {
        res.writeHead(500, "Failed to parse y");
        response.end();
        return;
    }
    
    idx--
    x = parseInt(parts[idx]);
    idx--
    z = parseInt(parts[idx]);
    idx--
    loadTile(z, x, y, response, db); 
}

/**
 * Get all tiles from the passed database that match the supplied 
 * z,x,y indices and then send them back to the requesting client   
 * @param {integer} z 
 * @param {integer} x 
 * @param {integer} y 
 * @param {http response} http response object 
 * @param {database} sqlite database
 */
function loadTile(z, x, y, response, db) {
    if (!db) {
        response.writeHead(503);
        response.end();
        return;
    }
    try {
        let sql = `SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?`;
        let row = db.prepare(sql).get(z, x, y);
        if (row !== undefined && row.tile_data != undefined) {
            // Chart tiles are immutable for the lifetime of a deployed FAA
            // chart cycle - cache aggressively so repeat views/reloads never
            // re-fetch the same tile over the network.
            response.writeHead(200, {
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=2592000, immutable'
            });
            response.write(row.tile_data);
            response.end();
        }
        else {
            response.writeHead(200);
            response.end();
        }
    }
    catch (err) {
        console.log(err);
        response.writeHead(500, err.message);
        response.end();
    }
}

/**
 * Get Map object filled with metadata sets for all mbtiles databases
 */
function loadMetadatasets() {
    let sql = `SELECT name, value FROM metadata UNION SELECT 'minzoom', min(zoom_level) FROM tiles ` + 
              `WHERE NOT EXISTS (SELECT * FROM metadata WHERE name='minzoom') UNION SELECT 'maxzoom', max(zoom_level) FROM tiles ` +
              `WHERE NOT EXISTS (SELECT * FROM metadata WHERE name='maxzoom')`;
    
    databases.forEach((db, key) => {
        let item = { bounds: "", attribution: "" };
        try {
            let rows = db.prepare(sql).all();
            rows.forEach((row) => {
                if (row.value != null) {
                    item[row.name] = row.value;
                }
                if (row.name === "maxzoom" && row.value != null) {
                    let maxZoomInt = parseInt(row.value);
                    let boundsSql = `SELECT min(tile_column) as xmin, min(tile_row) as ymin, ` +
                                `max(tile_column) as xmax, max(tile_row) as ymax ` +
                            `FROM tiles WHERE zoom_level=?`;
                    let boundsRow = db.prepare(boundsSql).get(maxZoomInt);
                    if (boundsRow) {
                        let llmin = tileToDegree(maxZoomInt, boundsRow.xmin, boundsRow.ymin);
                        let llmax = tileToDegree(maxZoomInt, boundsRow.xmax + 1, boundsRow.ymax + 1);
                        item["bounds"] = `${llmin[0]}, ${llmin[1]}, ${llmax[0]}, ${llmax[1]}`;
                    }
                }
            });
            metadatasets.set(key, item);
        }
        catch (err) {
            console.log(err.message);
        }
    });
}

/**
 * Get the longitude and latitude for a given pixel position on the map
 * @param {integer} z - the zoom level 
 * @param {integer} x - the horizontal index
 * @param {integer} y - the vertical index
 * @returns 2 element array - [longitude, latitude]
 */
function tileToDegree(z, x, y) {
	y = (1 << z) - y - 1
    let n = Math.PI - 2.0*Math.PI*y/Math.pow(2, z);
    lat = 180.0 / Math.PI * Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));
    lon = x/Math.pow(2, z)*360.0 - 180.0;
    return [lon, lat]
}

const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
let openSkyAccessToken = null;
let openSkyTokenExpiresAt = 0;

/**
 * Get a cached OpenSky OAuth2 access token, fetching/refreshing it via the
 * client-credentials grant when missing or close to expiry. Returns null if
 * no credentials are configured (traffic proxy then falls back to
 * unauthenticated, rate-limited requests).
 */
async function getOpenSkyAccessToken() {
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    if (openSkyAccessToken && Date.now() < openSkyTokenExpiresAt) {
        return openSkyAccessToken;
    }

    const response = await fetch(OPENSKY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        })
    });
    if (!response.ok) {
        throw new Error(`OpenSky token request failed: ${response.status}`);
    }
    const data = await response.json();
    openSkyAccessToken = data.access_token;
    // Refresh a minute early rather than right at expiry.
    openSkyTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return openSkyAccessToken;
}

/**
 * Recursively run the file downloads from the ADDS server for
 * metars, tafs, & pireps which will then be sent to client(s)
 */
async function runDownloads() {
    downloadXmlFile(MessageTypes.metars);
    downloadXmlFile(MessageTypes.tafs); 
    downloadXmlFile(MessageTypes.pireps);
    setTimeout(() => {
        runDownloads();
    }, settings.wxupdateintervalmsec);
}

/**
 * Download an ADDS weather service file
 * @param {source} the type of file to download (metar, taf, or pirep)
 */
async function downloadXmlFile(source) {
    let xhr = new XMLHttpRequest();  
    let url = settings.addscurrentxmlurl.replace(source.token, source.type);
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Content-Type', 'text/csv');
    xhr.setRequestHeader("Access-Control-Allow-Origin", "*");
    xhr.setRequestHeader('Access-Control-Allow-Methods', '*');
    xhr.setRequestHeader("Access-Control-Allow-Headers", "*");
    xhr.responseType = 'document';
    xhr.onload = () => {
        if (xhr.readyState == 4 && xhr.status == 200) {
            let response = xhr.responseText;
            //var mxml = unzipSync(new Buffer.From(response).toString('base64'));
            let messageJSON = xmlparser.parse(response);
            switch(source.type) {
                case "tafs":
                    processTafJsonObjects(messageJSON);
                    break;
                case "metars":
                    processMetarJsonObjects(messageJSON);
                    break;
                case "aircraftreports":
                    processPirepJsonObjects(messageJSON);
                    break;
            }
        }
        else {
            console.log(`Unexpected status downloading ${source.type}: ${xhr.status}`);
        }
    };
    xhr.onerror = () => {
        console.log(`Network error downloading ${source.type} from ${url}`);
    };
    xhr.ontimeout = () => {
        console.log(`Timed out downloading ${source.type} from ${url}`);
    };
    xhr.timeout = 30000;
    try {
        xhr.send();
    }
    catch (err) {
        console.log(`Error getting message type ${source.type}: ${err}`);
    }
}

/**
 * Process the received downloaded tafs data and send to client(s)
 * @param {object} tafs json object 
 */
async function processTafJsonObjects(tafs) {
    let payload = JSON.stringify(tafs); 
    let message = {
        type: MessageTypes.tafs.type,
        payload: payload
    };
    const json = JSON.stringify(message);
    sendMessageToClients(json);
}

/**
 * Process the received downloaded metars data and send to client(s)
 * @param {object} metars json object 
 */
async function processMetarJsonObjects(metars) {
    let payload = JSON.stringify(metars);
    let message = {
        type: MessageTypes.metars.type,
        payload: payload
    };
    const json = JSON.stringify(message);
    sendMessageToClients(json);
}

/**
 * Process the received downloaded pireps data and send to client(s)
 * @param {object} pireps json object 
 */
async function processPirepJsonObjects(pireps) {
    let payload = JSON.stringify(pireps);
    let message = {
        type: MessageTypes.pireps.type,
        payload: payload
    }
    const json = JSON.stringify(message);
    sendMessageToClients(json);
}

/**
 * Iterate through any/all connected clients and send data
 * @param {string} stringified json message 
 */
async function sendMessageToClients(jsonmessage) {
    [...connections.keys()].forEach((client) => {
        client.send(jsonmessage);
    });
}
