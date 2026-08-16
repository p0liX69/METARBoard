const express = require('express');
const favicon = require('serve-favicon');
const cors = require('cors');
const url = require('url');
const fs = require("fs");
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
let DB_PATH = `${__dirname}/charts`;

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
        return JSON.parse(fs.readFileSync(`${__dirname}/settings.json`));
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
    let target = `${__dirname}/settings.json`;
    let tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(newSettings, null, "    "));
    fs.renameSync(tmp, target);
}

let settings = loadSettings();

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
    if (fs.existsSync(`${__dirname}/externalcharts`)) {
        DB_PATH = `${__dirname}/externalcharts`;
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
        histdb = new Database(`${__dirname}/${settings.historyDb}`);
    }
    catch (err) {
        console.log(`Failed to load: ${settings.historyDb}: ${err.message}`);
    }

    // Optional: only present once provisioning/import-aircraft-db.js has
    // been run manually. Traffic metadata lookups just come back empty
    // without it - not a startup requirement.
    try {
        aircraftDb = new Database(`${__dirname}/aircraft.db`, { fileMustExist: true });
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
    app.use(express.static('public'))
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
    
    app.get('/', (req, res) => {
        res.sendFile(`${__dirname}/public/index.html`);
    });

    app.get('/admin', (req, res) => {
        res.sendFile(`${__dirname}/public/admin.html`);
    });

    app.get("/getsettings", (req, res) => {
    let rawdata = fs.readFileSync(`${__dirname}/settings.json`);
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
        useOSMonlinemap: (value) => (typeof value === "boolean" ? value : undefined)
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
