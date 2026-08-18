'use strict';

if (!localStorage.getItem("homeAirport")) {
    localStorage.setItem("homeAirport", "KHGR");
}

// Guards against persisting/restoring the map's placeholder [0,0] view
// that exists before any real data has loaded - see centerOnHomeAirport().
let hasCenteredOnHomeAirport = false;

/**
 * Show every chart whose real bounds overlap the current viewport, and
 * hide the rest - so adjacent regions tile together like paper sectionals
 * taped side by side, instead of only ever showing one fixed region.
 * Nationwide reference charts (enroute, wall planning) are left alone for
 * manual toggling, since they'd otherwise always match everywhere.
 */
function updateVisibleCharts() {
    const viewExtent = map.getView().calculateExtent(map.getSize());
    map.getLayers().forEach(layer => {
        const title = layer.get("title");
        if (!title || !title.toLowerCase().includes("chart")) return;

        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes("enroute") || lowerTitle.includes("wall planning")) return;

        const chartExtent = layer.getExtent();
        layer.setVisible(!!chartExtent && ol.extent.intersects(chartExtent, viewExtent));
    });
}

/**
 * Fetch the real FAA Class B/C/D/E-surface airspace boundary for the given
 * ICAO id (via the server-side /homeairspace proxy) and render it as a
 * highlighted outline. Only fetches once per identifier - airspace
 * boundaries don't change during a session, so repeated calls from
 * centerOnHomeAirport() are otherwise no-ops.
 */
async function fetchHomeAirspace(icao) {
    if (!icao || homeAirspaceIcaoFetched === icao) return;
    if (settings && settings.showHomeAirspace === false) return;
    homeAirspaceIcaoFetched = icao;

    try {
        const response = await fetch(URL_GET_HOME_AIRSPACE);
        const geojson = await response.json();
        const features = new ol.format.GeoJSON().readFeatures(geojson, {
            featureProjection: 'EPSG:3857'
        });
        homeAirspaceFeatures.clear();
        homeAirspaceFeatures.extend(features);
    }
    catch (err) {
        console.log(`Failed to load home airspace boundary for ${icao}:`, err);
    }
}

let windsAloftIcaoFetched = null;
let homeAirportLonLat = null;

/**
 * Fetch and render low-altitude winds aloft for the FD collective station
 * nearest the home airport (via the server-side /windsaloft proxy - see
 * its comment for why this is a nearest-neighbor match, not exact).
 */
async function fetchWindsAloft(icao) {
    if (!icao || windsAloftIcaoFetched === icao) return;
    windsAloftIcaoFetched = icao;

    try {
        const response = await fetch(URL_GET_WINDS_ALOFT);
        const data = await response.json();
        renderWindsAloftPanel(data);
    }
    catch (err) {
        console.log(`Failed to load winds aloft for ${icao}:`, err);
    }
}

function formatWindLevel(level) {
    if (level.lightAndVariable) {
        return `Light/variable${level.tempC !== null ? ` (${level.tempC}°C)` : ""}`;
    }
    const tempPart = level.tempC !== null ? ` ${level.tempC}°C` : "";
    return `${String(level.direction).padStart(3, "0")}° @ ${level.speed}kt${tempPart}`;
}

function renderWindsAloftPanel(data) {
    const panel = document.getElementById("windsAloftBox");
    if (!data || !data.station || !data.levels.length) {
        panel.style.display = "none";
        return;
    }

    panel.style.display = "block";
    const rows = data.levels.map((level) =>
        `<tr><td>${level.altitude.toLocaleString()} ft:</td><td>${formatWindLevel(level)}</td></tr>`
    ).join("");
    panel.innerHTML = `
        <div class="windsaloft-header">Winds Aloft - ${escapeHtml(data.station)} (${data.distanceNm}nm)</div>
        <table class="windsaloft-table">${rows}</table>
    `;
}

const TFR_REFRESH_MS = 15 * 60 * 1000;

/**
 * Fetch active nationwide FAA TFRs (via the server-side /tfrs proxy, which
 * joins FAA's list API to its WFS boundary geometry) and render them.
 * Refetched periodically since, unlike airspace boundaries, TFRs come and
 * go throughout the day.
 */
async function fetchTfrs() {
    if (settings && settings.showTfrOverlay === false) {
        tfrFeatures.clear();
        return;
    }

    try {
        const response = await fetch(URL_GET_TFRS);
        const geojson = await response.json();
        const features = new ol.format.GeoJSON().readFeatures(geojson, {
            featureProjection: 'EPSG:3857'
        });
        features.forEach((feature) => feature.set("datatype", "tfr"));
        tfrFeatures.clear();
        tfrFeatures.extend(features);
    }
    catch (err) {
        console.log("Failed to load TFRs:", err);
    }
}

const LIGHTNING_REFRESH_MS = 15 * 1000;

/**
 * Fetch recent lightning strikes (via the server-side /lightning proxy,
 * which buffers a persistent Blitzortung feed connection) and render them.
 * Refetched frequently since, unlike TFRs, strikes are near-real-time.
 */
async function fetchLightning() {
    if (settings && settings.showLightning === false) {
        lightningFeatures.clear();
        return;
    }

    try {
        const response = await fetch(URL_GET_LIGHTNING);
        const geojson = await response.json();
        const features = new ol.format.GeoJSON().readFeatures(geojson, {
            featureProjection: 'EPSG:3857'
        });
        features.forEach((feature) => feature.set("datatype", "lightning"));
        lightningFeatures.clear();
        lightningFeatures.extend(features);
    }
    catch (err) {
        console.log("Failed to load lightning strikes:", err);
    }
}

const SIGMET_REFRESH_MS = 10 * 60 * 1000;

/**
 * Fetch active domestic SIGMETs (via the server-side /sigmets proxy,
 * which strips the legacy IFR-hazard entries the underlying feed can
 * still return - see /airmets for those) and render them.
 */
async function fetchSigmets() {
    if (settings && settings.showSigmets === false) {
        sigmetFeatures.clear();
        updateHazardLegend();
        return;
    }

    try {
        const response = await fetch(URL_GET_SIGMETS);
        const geojson = await response.json();
        const features = new ol.format.GeoJSON().readFeatures(geojson, {
            featureProjection: 'EPSG:3857'
        });
        features.forEach((feature) => feature.set("datatype", "sigmet"));
        sigmetFeatures.clear();
        sigmetFeatures.extend(features);
        updateHazardLegend();
    }
    catch (err) {
        console.log("Failed to load SIGMETs:", err);
    }
}

/**
 * Fetch the current G-AIRMET panel (via the server-side /airmets proxy)
 * and render it.
 */
async function fetchAirmets() {
    if (settings && settings.showAirmets === false) {
        airmetFeatures.clear();
        updateHazardLegend();
        return;
    }

    try {
        const response = await fetch(URL_GET_AIRMETS);
        const geojson = await response.json();
        const features = new ol.format.GeoJSON().readFeatures(geojson, {
            featureProjection: 'EPSG:3857'
        });
        features.forEach((feature) => feature.set("datatype", "airmet"));
        airmetFeatures.clear();
        airmetFeatures.extend(features);
        updateHazardLegend();
    }
    catch (err) {
        console.log("Failed to load AIRMETs:", err);
    }
}

/**
 * Center on the saved home airport. If a previous map view (center/zoom)
 * was saved, that view is restored instead so routine calls (e.g. after a
 * settings-triggered reload) don't clobber whatever the user last panned/
 * zoomed to. loadInitialData() clears the saved view when the home airport
 * itself changes, so this still moves to the new location in that case.
 */
function centerOnHomeAirport() {
    const home = localStorage.getItem("homeAirport");
    if (!home || !airportNameKeymap.has(home)) return;

    let apt = null;
    airportFeatures.forEach((feature) => {
        if (feature.get("ident") === home) {
            apt = feature;
        }
    });

    if (apt) {
        hasCenteredOnHomeAirport = true;
        fetchHomeAirspace(home);
        fetchWindsAloft(home);
        homeAirportLonLat = ol.proj.toLonLat(apt.getGeometry().getCoordinates());
        const savedView = JSON.parse(localStorage.getItem("lastMapView") || "null");
        const hasValidSavedView = savedView
            && Array.isArray(savedView.center)
            && savedView.center.length === 2
            && savedView.center.every(Number.isFinite)
            && Number.isFinite(savedView.zoom);
        if (hasValidSavedView) {
            map.getView().setCenter(savedView.center);
            map.getView().setZoom(savedView.zoom);
        }
        else {
            const coords = apt.getGeometry().getCoordinates();
            map.getView().setCenter(coords);
            map.getView().setZoom(settings.startupzoom || 9);
        }

        metarVectorLayer.setVisible(true);
        updateVisibleCharts();
        setTimeout(() => {
            const metarFeature = metarFeatures.getArray().find(f => {
                const metar = f.get("metar");
                const featureId = f.getId();
                return metar && (metar.station_id?.toUpperCase() === home || featureId?.toUpperCase() === home);
            });

            if (metarFeature && popupoverlay) {
                const metar = metarFeature.get("metar");
                const rawmetar = metar?.raw_text;
                if (rawmetar) {
                    displayMetarPopup(metarFeature);
                    const popupEl = popupoverlay.getElement();
                    popupEl.style.position = 'fixed';
                    popupEl.style.bottom = '10px';
                    popupEl.style.right = '10px';
                    popupEl.style.top = 'unset';
                    popupEl.style.left = 'unset';
                    popupEl.style.display = 'block';
                    popupEl.style.zIndex = '2000';
                } else {
                    console.log("METAR data missing raw_text for", home);
                }
            } else {
                
            }
        }, 2000);

    }
}


 /**
 * Construct all of the application urls 
 */
let URL_LOCATION            =  location.hostname;
let URL_PROTOCOL            =  location.protocol;
let URL_PORT                =  location.port;
let URL_HOST_BASE           =  URL_LOCATION;
if (parseInt(URL_PORT) > 0) {
    URL_HOST_BASE += `:${URL_PORT}`;
}
let URL_HOST_PROTOCOL       = `${URL_PROTOCOL}//`;
let URL_SERVER              = `${URL_HOST_PROTOCOL}${URL_HOST_BASE}`;
let URL_WINSOCK             = `ws://${URL_LOCATION}:`;
let URL_GET_METADATASETS    = `${URL_SERVER}/metadatasets`;
let URL_GET_DBLIST          = `${URL_SERVER}/databaselist`;
let URL_GET_TILE            = `${URL_SERVER}/tiles/{dbname}/{z}/{x}/{-y}`;
let URL_GET_HISTORY         = `${URL_SERVER}/gethistory`;
let URL_GET_SETTINGS        = `${URL_SERVER}/getsettings`;
let URL_PUT_HISTORY         = `${URL_SERVER}/savehistory`;
let URL_GET_HELIPORTS       = `${URL_SERVER}/getheliports`;
let URL_GET_HOME_AIRSPACE   = `${URL_SERVER}/homeairspace`;
let URL_GET_TFRS            = `${URL_SERVER}/tfrs`;
let URL_GET_LIGHTNING       = `${URL_SERVER}/lightning`;
let URL_GET_SIGMETS         = `${URL_SERVER}/sigmets`;
let URL_GET_AIRMETS         = `${URL_SERVER}/airmets`;
let URL_GET_WINDS_ALOFT     = `${URL_SERVER}/windsaloft`;

let deg = 0;
let alt = 0;
let lng = 0;
let lat = 0;

/**
 * Classes used by the on-the-fly weather SVG in metar popups
 */
class METAR {
    /**
     * Extracted Metar data in a human readable format.
     * @param metarString raw metar string if provided station and time will be ignored and replaced with the content in the raw METAR
     * @param station staion name for instance creation
     * @param time time for instance creation
     */
    constructor (metarString, station, time) {
        //Wind speed, direction and unit
        this.wind;// = new Wind();
        //List of weather conditions reported
        this.weather = new Array();
        //List of Cloud observations
        this.clouds = new Array();
        this.station = station !== null && station !== void 0 ? station : "----";
        this.time = time !== null && time !== void 0 ? time : new Date();
        this.flightCategory = "";
        if (metarString != null) {
            parseMetar(metarString, this);
        }
    }
}
class Wind {
    direction = 0;
    speed = 0;
    unit = "";
    constructor() {}
};
class Variation {
    constructor() {
    }
};
class Cloud {
    constructor() {
    }
};
/**************** END OF SVG GENERATION CLASSES *****************/

/**
 * global variables
 */
let settings = {};
let dblist = {};
let metadatasets = {};
let last_longitude = 0;
let last_latitude = 0;
let last_heading = 0;
let currentZoom = 9.0;
let lastcriteria = "allregions";

/**
 * Map objects used for various keyname lookups
 */
let airportNameKeymap = new Map();
let airportElevationKeymap = new Map();

const AIRPORTS_RETRY_BASE_DELAY_MS = 1000;
const AIRPORTS_RETRY_MAX_DELAY_MS = 30000;
let airportsRetryAttempts = 0;

function loadAirports() {
    fetch("us_airports.json")
        .then(res => res.json())
        .then(data => {
            airportsRetryAttempts = 0;
            processAirports({ airports: data });
        })
        .catch(err => {
            const delay = Math.min(AIRPORTS_RETRY_BASE_DELAY_MS * (2 ** airportsRetryAttempts), AIRPORTS_RETRY_MAX_DELAY_MS);
            airportsRetryAttempts++;
            console.log(`Failed to load us_airports.json, retrying in ${delay}ms:`, err);
            setTimeout(loadAirports, delay);
        });
}
loadAirports();
let tafFieldKeymap = new Map();
let metarFieldKeymap = new Map();
let weatherAcronymKeymap = new Map();
let icingCodeKeymap = new Map();
let turbulenceCodeKeymap = new Map();
let skyConditionKeymap = new Map();
let trafficMap = new Map();
// icao24 (lowercase) -> {registration, manufacturer, model, operator, category}
let aircraftInfoCache = new Map();
/*******keymap loading ******/
loadTafFieldKeymap();
loadMetarFieldKeymap();
loadWeatherAcronymKeymap();
loadTurbulenceCodeKeymap();
loadIcingCodeKeymap();
loadSkyConditionmKeymap();

/**
 * ol.Collections hold features like
 * metars, tafs, airport info, etc.
 */
let metarFeatures = new ol.Collection();
let metarMarkers = [];
let airportFeatures = new ol.Collection();
let tafFeatures = new ol.Collection();
let pirepFeatures = new ol.Collection();
let trafficFeatures = new ol.Collection();
let homeAirspaceFeatures = new ol.Collection();
let homeAirspaceIcaoFetched = null;
let tfrFeatures = new ol.Collection();
let lightningFeatures = new ol.Collection();
let sigmetFeatures = new ol.Collection();
let airmetFeatures = new ol.Collection();

/**
 * Vector sources
 */
let metarVectorSource;
let airportVectorSource;
let tafVectorSource;
let pirepVectorSource;
let trafficVectorSource;
let homeAirspaceVectorSource;
let tfrVectorSource;
let lightningVectorSource;
let sigmetVectorSource;
let airmetVectorSource;

/**
 * Vector layers
 */
let airportVectorLayer;
let metarVectorLayer;
let tafVectorLayer;
let pirepVectorLayer;
let trafficVectorLayer;
let homeAirspaceVectorLayer;
let tfrVectorLayer;
let lightningVectorLayer;
let sigmetVectorLayer;
let airmetVectorLayer;

/**
 * Tile layers
 */
let debugTileLayer;

/**
 * Radar animation frames - one persistent WMS layer per historical
 * timestamp, pre-created so playback just swaps visibility between
 * already-loaded layers instead of re-fetching tiles every frame.
 */
let radarFrameLayers = [];
let radarFrameTimestamps = [];
let currentRadarFrameIndex = 0;

/**
 * Websocket objects, flag, and message definition
 * JSON object that is filled by returned settings
 */
let wsSituation;
let wsTraffic;
let wsServer;
let wssurl;
let myairplane;
let wsServerOpen = false;
let MessageTypes = {};
let DistanceUnits = {};
let distanceunit = "";
let airplaneElement = document.getElementById('airplane');

/**
 * Animation variables 
 */
let animationId = null;
let frameRate = 0.33; // frames per second (one frame every 3s, gives tiles time to load)
const animatecontrol = document.getElementById('wxbuttons');

/**
 * Controls for dropdown select when viewing all airports
 */
const regioncontrol = document.getElementById('isoregion');
const regionselect = document.getElementById("regionselect");
let regionmap = new Map();

// Floating wall-clock overlays: local time top-left, Zulu top-right
const localClockContainer = document.createElement("div");
localClockContainer.className = "wall-clock wall-clock-local";
localClockContainer.id = "clockLocal";
document.body.appendChild(localClockContainer);

const utcClockContainer = document.createElement("div");
utcClockContainer.className = "wall-clock wall-clock-utc";
utcClockContainer.id = "clockUtc";
document.body.appendChild(utcClockContainer);

// Software night-dimming overlay. There's no standard way to control an
// arbitrary HDMI TV's actual backlight from the Pi side (no DDC/CI
// support to assume), so "dimming" here means reducing this page's own
// output via a black overlay - the same approach most software-only
// night modes use when they don't control real display hardware.
const nightDimOverlay = document.createElement("div");
nightDimOverlay.id = "nightDimOverlay";
document.body.appendChild(nightDimOverlay);

// Bottom-center strip of favorite airports (configured in /admin) - a
// quick-glance row separate from the home airport's own detailed panel.
const favoritesStrip = document.createElement("div");
favoritesStrip.id = "favoritesStrip";
document.body.appendChild(favoritesStrip);

// Bottom-left winds aloft panel, mirroring the home METAR panel's
// bottom-right position.
const windsAloftBox = document.createElement("div");
windsAloftBox.id = "windsAloftBox";
windsAloftBox.className = "static-metar-popup windsaloft-popup";
document.body.appendChild(windsAloftBox);

// Top-center sunrise/sunset badge, between the two wall clocks.
const sunPanel = document.createElement("div");
sunPanel.id = "sunPanel";
document.body.appendChild(sunPanel);

// Hazard-color key for SIGMET/AIRMET, below the local clock.
const hazardLegend = document.createElement("div");
hazardLegend.id = "hazardLegend";
document.body.appendChild(hazardLegend);

/**
 * NOAA's standard solar position formulas (equation of time + solar
 * declination + hour angle) - verified against a known reference
 * (Washington DC summer solstice 2024: sunrise/sunset within a minute of
 * published values) before use here.
 * @returns {{sunriseMinutes: number, sunsetMinutes: number}} minutes past UTC midnight
 */
function calculateSunTimes(date, lat, lon) {
    const deg2rad = (deg) => deg * Math.PI / 180;
    const rad2deg = (rad) => rad * 180 / Math.PI;

    const julianDay = date.getTime() / 86400000 + 2440587.5;
    const julianCentury = (julianDay - 2451545) / 36525;

    const geomMeanLongSun = (280.46646 + julianCentury * (36000.76983 + julianCentury * 0.0003032)) % 360;
    const geomMeanAnomSun = 357.52911 + julianCentury * (35999.05029 - 0.0001537 * julianCentury);
    const eccentEarthOrbit = 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);

    const sunEqOfCtr = Math.sin(deg2rad(geomMeanAnomSun)) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury))
        + Math.sin(deg2rad(2 * geomMeanAnomSun)) * (0.019993 - 0.000101 * julianCentury)
        + Math.sin(deg2rad(3 * geomMeanAnomSun)) * 0.000289;

    const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
    const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(125.04 - 1934.136 * julianCentury));

    const meanObliqEcliptic = 23 + (26 + (21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813))) / 60) / 60;
    const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos(deg2rad(125.04 - 1934.136 * julianCentury));

    const sunDeclin = rad2deg(Math.asin(Math.sin(deg2rad(obliqCorr)) * Math.sin(deg2rad(sunAppLong))));

    const varY = Math.tan(deg2rad(obliqCorr / 2)) * Math.tan(deg2rad(obliqCorr / 2));
    const eqOfTime = 4 * rad2deg(
        varY * Math.sin(2 * deg2rad(geomMeanLongSun))
        - 2 * eccentEarthOrbit * Math.sin(deg2rad(geomMeanAnomSun))
        + 4 * eccentEarthOrbit * varY * Math.sin(deg2rad(geomMeanAnomSun)) * Math.cos(2 * deg2rad(geomMeanLongSun))
        - 0.5 * varY * varY * Math.sin(4 * deg2rad(geomMeanLongSun))
        - 1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * deg2rad(geomMeanAnomSun))
    );

    const haSunrise = rad2deg(Math.acos(
        (Math.cos(deg2rad(90.833)) / (Math.cos(deg2rad(lat)) * Math.cos(deg2rad(sunDeclin))))
        - Math.tan(deg2rad(lat)) * Math.tan(deg2rad(sunDeclin))
    ));

    const solarNoonMinutes = 720 - 4 * lon - eqOfTime;
    return {
        sunriseMinutes: solarNoonMinutes - haSunrise * 4,
        sunsetMinutes: solarNoonMinutes + haSunrise * 4
    };
}

function formatMinutesUntil(targetMinutesUtc, nowUtcMinutes) {
    let delta = targetMinutesUtc - nowUtcMinutes;
    if (delta < 0) delta += 1440;
    const h = Math.floor(delta / 60);
    const m = Math.round(delta % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function updateSunPanel() {
    if (!homeAirportLonLat) {
        sunPanel.style.display = "none";
        return;
    }

    const now = new Date();
    const [lon, lat] = homeAirportLonLat;
    const { sunriseMinutes, sunsetMinutes } = calculateSunTimes(now, lat, lon);
    const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;

    const timeZone = getConfiguredTimeZone();
    const utcMinutesToLocalString = (minutes) => {
        const asDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, Math.round(minutes)));
        return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(asDate);
    };

    const isDaytime = nowUtcMinutes >= sunriseMinutes && nowUtcMinutes < sunsetMinutes;
    const countdownLabel = isDaytime
        ? `Sunset in ${formatMinutesUntil(sunsetMinutes, nowUtcMinutes)}`
        : `Sunrise in ${formatMinutesUntil(sunriseMinutes, nowUtcMinutes)}`;

    sunPanel.style.display = "block";
    sunPanel.innerHTML = `
        <div class="sun-times">☀ ${utcMinutesToLocalString(sunriseMinutes)} &nbsp;|&nbsp; ${utcMinutesToLocalString(sunsetMinutes)} 🌙</div>
        <div class="sun-countdown">${countdownLabel}</div>
    `;
}

/**
 * Refresh the favorites strip from whatever METAR data is already loaded
 * for the map - no separate fetch, this reuses metarFeatures.
 */
function updateFavoritesStrip() {
    const favorites = (settings && settings.favoriteAirports) || [];
    if (!favorites.length) {
        favoritesStrip.innerHTML = "";
        favoritesStrip.style.display = "none";
        return;
    }

    favoritesStrip.style.display = "flex";
    favoritesStrip.innerHTML = favorites.map((ident) => {
        const feature = metarFeatures.getArray().find((f) => f.getId() === ident);
        const metar = feature ? feature.get("metar") : null;
        const cat = metar ? (metar.flight_category || "VFR") : null;
        const catClass = cat ? cat.toLowerCase() : "unknown";
        return `<div class="favorite-chip ${catClass}">`
            + `<span class="favorite-ident">${escapeHtml(ident)}</span>`
            + `<span class="favorite-category">${escapeHtml(cat || "N/A")}</span>`
            + `</div>`;
    }).join("");
}

/**
 * @returns {number} minutes since local midnight, in the configured timezone
 */
function getLocalMinutesOfDay(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return get('hour') * 60 + get('minute');
}

function parseHHMM(value) {
    const [h, m] = String(value || "").split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function updateNightDimOverlay() {
    if (!settings || !settings.nightDimEnabled) {
        nightDimOverlay.style.opacity = 0;
        return;
    }

    const startMinutes = parseHHMM(settings.nightDimStart);
    const endMinutes = parseHHMM(settings.nightDimEnd);
    if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
        nightDimOverlay.style.opacity = 0;
        return;
    }

    const nowMinutes = getLocalMinutesOfDay(new Date(), getConfiguredTimeZone());
    const withinWindow = startMinutes < endMinutes
        ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
        : (nowMinutes >= startMinutes || nowMinutes < endMinutes); // wraps past midnight

    const opacityPercent = Number.isFinite(settings.nightDimOpacity) ? settings.nightDimOpacity : 70;
    nightDimOverlay.style.opacity = withinWindow ? opacityPercent / 100 : 0;
}

/**
 * The IANA timezone to display "Local" time in, from /admin's Timezone
 * setting - falls back to the browser/OS default if unset, which is the
 * old behavior (and is wrong for a kiosk shipped to a different timezone
 * than it was originally imaged in).
 * @returns {string}
 */
function getConfiguredTimeZone() {
    return (settings && settings.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatWallClock(date, timeZone) {
    const time = new Intl.DateTimeFormat('en-CA', {
        timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
    const dateStr = new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    }).format(date);
    return { time, date: dateStr };
}

function updateClockOverlay() {
    const now = new Date();
    const local = formatWallClock(now, getConfiguredTimeZone());
    const utc = formatWallClock(now, 'UTC');

    localClockContainer.innerHTML = `
        <div class="wall-clock-label">LOCAL</div>
        <div class="wall-clock-time">${local.time}</div>
        <div class="wall-clock-date">${local.date}</div>
    `;
    utcClockContainer.innerHTML = `
        <div class="wall-clock-label">ZULU</div>
        <div class="wall-clock-time">${utc.time}</div>
        <div class="wall-clock-date">${utc.date}</div>
    `;
}

setInterval(() => {
    updateClockOverlay();
    updateNightDimOverlay();
    updateSunPanel();
}, 1000);
updateClockOverlay();
updateNightDimOverlay();
updateSunPanel();

/**
 * Load settings, metadatasets, database list, and last known position
 * from the server (in that order, since later requests depend on
 * settings having been parsed), then open the websocket connection(s).
 */
async function loadInitialData() {
    try {
        const response = await fetch(URL_GET_SETTINGS);
        settings = JSON.parse(await response.text());
        MessageTypes = settings.messagetypes;
        DistanceUnits = settings.distanceunits;
        distanceunit = settings.distanceunit;
        currentZoom = settings.startupzoom;

        if (settings.homeAirport) {
            const previousHomeAirport = localStorage.getItem("homeAirport");
            if (previousHomeAirport && previousHomeAirport !== settings.homeAirport) {
                // Home airport changed (e.g. via /admin) - forget the old
                // saved view so centerOnHomeAirport() moves to the new one
                // instead of restoring wherever the map was previously.
                localStorage.removeItem("lastMapView");
            }
            localStorage.setItem("homeAirport", settings.homeAirport);
        }

        if (settings.startupzoom != null) {
            const previousStartupZoom = localStorage.getItem("startupzoom");
            // Note: Number(null) is 0, so this also clears on the very first
            // run (before "startupzoom" has ever been recorded) rather than
            // only on later changes - otherwise a view saved before this
            // tracking existed would survive untouched forever.
            if (Number(previousStartupZoom) !== settings.startupzoom) {
                // Configured default zoom changed - forget the saved view so
                // the new default actually takes effect instead of restoring
                // whatever zoom level was saved under the old default.
                localStorage.removeItem("lastMapView");
            }
            localStorage.setItem("startupzoom", settings.startupzoom);
        }
        setupRadarAnimation();
        if (settings.showRadarByDefault) {
            showLatestRadarFrame();
            setInterval(refreshRadarFrames, 5 * 60 * 1000);
        }

        fetchTfrs();
        setInterval(fetchTfrs, TFR_REFRESH_MS);

        fetchLightning();
        setInterval(fetchLightning, LIGHTNING_REFRESH_MS);

        fetchSigmets();
        setInterval(fetchSigmets, SIGMET_REFRESH_MS);

        fetchAirmets();
        setInterval(fetchAirmets, SIGMET_REFRESH_MS);
    }
    catch (err) {
        console.log(err);
    }

    try {
        const response = await fetch(URL_GET_METADATASETS);
        metadatasets = JSON.parse(await response.text());
    }
    catch (err) {
        console.log(err);
    }

    try {
        const response = await fetch(URL_GET_DBLIST);
        dblist = JSON.parse(await response.text());
    }
    catch (err) {
        console.log(err);
    }

    addChartLayers();
    // Re-run chart auto-select now that chart layers actually exist on the
    // map - centerOnHomeAirport() may have already run once (triggered by
    // the independent us_airports.json fetch) before this point, in which
    // case there was nothing to select yet. Idempotent, safe to call again.
    centerOnHomeAirport();

    try {
        const response = await fetch(URL_GET_HISTORY);
        let histobj = JSON.parse(await response.text());
        last_longitude = histobj.longitude;
        last_latitude = histobj.latitude;
        last_heading = histobj.heading;
    }
    catch (err) {
        console.log(err);
    }

    connectWebSocket();
    if (settings.usestratux) {
        setupStratuxWebsockets();
    }
}

loadInitialData();

/**
 * Websocket connection and message handling, reconnects with
 * exponential backoff (capped) if the connection drops
 */
const WS_RECONNECT_BASE_DELAY_MS = 1000;
const WS_RECONNECT_MAX_DELAY_MS = 30000;
let wsReconnectAttempts = 0;

function connectWebSocket() {
    try {
        let wsurl = `${URL_WINSOCK}${settings.wsport}`;
        console.log(`OPENING: ${wsurl}`);
        wsServer = new WebSocket(wsurl);
        wsServer.onmessage = (evt) => {
            try {
                let message = JSON.parse(evt.data);
                let payload = JSON.parse(message.payload);

                switch (message.type) {
                    case MessageTypes.metars.type:
                        processMetars(payload);
                        break;
                    case MessageTypes.tafs.type:
                        processTafs(payload);
                        break;
                    case MessageTypes.pireps.type:
                        processPireps(payload);
                        break;
                    case "settingsupdated":
                        location.reload();
                        break;
                }
            }
            catch (err) {
                console.log("Failed to process websocket message:", err);
            }
        }

        wsServer.onerror = function(evt){
            console.log("Websocket ERROR: " + evt.data);
        }

        wsServer.onopen = function(evt) {
            console.log("Websocket CONNECTED.");
            wsServerOpen = true;
            wsReconnectAttempts = 0;
            keepAlive();
        }

        wsServer.onclose = function(evt) {
            cancelKeepAlive();
            wsServerOpen = false;
            console.log("Websocket CLOSED.");
            scheduleWebSocketReconnect();
        }
    }
    catch (error) {
        console.log(error);
        scheduleWebSocketReconnect();
    }
}

function scheduleWebSocketReconnect() {
    const delay = Math.min(WS_RECONNECT_BASE_DELAY_MS * (2 ** wsReconnectAttempts), WS_RECONNECT_MAX_DELAY_MS);
    wsReconnectAttempts++;
    console.log(`Reconnecting websocket in ${delay}ms...`);
    setTimeout(connectWebSocket, delay);
}

function setupStratuxWebsockets() {
    connectStratuxTraffic();
    connectStratuxSituation();
}

function connectStratuxTraffic() {
    let wsturl = settings.stratuxtrafficws.replace("[stratuxip]", settings.stratuxip);
    wsTraffic = new WebSocket(wsturl);
    wsTraffic.onmessage = function(evt){
        let tdata = JSON.parse(evt.data);
        addTrafficItem(tdata);
    }
    wsTraffic.onerror = function(evt) {
        console.log("Stratux traffic websocket ERROR.");
    }
    wsTraffic.onclose = function(evt) {
        console.log("Stratux traffic websocket CLOSED, retrying...");
        setTimeout(connectStratuxTraffic, 5000);
    }
}

function connectStratuxSituation() {
    let wssurl = settings.stratuxsituationws.replace("[stratuxip]", settings.stratuxip);
    wsSituation = new WebSocket(wssurl);
    wsSituation.onmessage = function(evt){
        if (myairplane !== null) {
            let sdata = JSON.parse(evt.data);
            setOwnshipOrientation(sdata);
        }
    }
    wsSituation.onerror = function(evt) {
        console.log("Stratux situation websocket ERROR.");
    }
    wsSituation.onclose = function(evt) {
        console.log("Stratux situation websocket CLOSED, retrying...");
        setTimeout(connectStratuxSituation, 5000);
    }
}

/**
 * Add a qualified Traffic item to the traffic Map collection
 * @param {json object} jsondata 
 */
function addTrafficItem(jsondata) {
    trafficMap.delete(jsondata.Icao_addr);
    if (jsondata.AgeLastAlt < 50 && jsondata.Speed > 0) {
        trafficMap.set(jsondata.Icao_addr, { ...jsondata, lastUpdated: Date.now() });
        processTraffic();
    }
}

/**
 * Icon markers for different METAR categories 
 */
let ifrMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/ifr_metar_wind.svg`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .30
});
/*--------------------------------------*/
let lifrMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/lifr_metar_wind.svg`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .30
});
/*--------------------------------------*/
let mvfrMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/mvfr_metar_wind.svg`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .30
});
/*--------------------------------------*/
let vfrMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/vfr_metar_wind.svg`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .30
});

/**
 * Icon markers for airports, TAFs, heliports, etc.
 */
let tafMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/taf.svg`,
    size: [126, 90],
    offset: [0, 0],
    opacity: 1,
    scale: .2
});
/*--------------------------------------*/
let airportMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/dot.png`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .30
});
/*--------------------------------------*/
let heliportMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/helipad.png`,
    size: [55, 55],
    offset: [0, 0],
    opacity: 1,
    scale: .50
});
/*--------------------------------------*/
let pirepMarker = new ol.style.Icon({
    crossOrigin: 'anonymous',
    src: `${URL_SERVER}/img/pirep.png`,
    size:[85, 85],
    offset: [0,0],
    opacity: 1,
    scale: .50
});

/**
 * ol.Style objects 
 */
const vfrStyle = new ol.style.Style({
    image: vfrMarker
});
const mvfrStyle = new ol.style.Style({
    image: mvfrMarker
});
const ifrStyle = new ol.style.Style({
    image: ifrMarker
});
const lifrStyle = new ol.style.Style({
    image: lifrMarker
});
const tafStyle = new ol.style.Style({
    image: tafMarker
})
const airportStyle = new ol.style.Style({
    image: airportMarker
});
const heliportStyle = new ol.style.Style({
    image: heliportMarker
});
const pirepStyle = new ol.style.Style({
    image: pirepMarker
});

// Loosely follows sectional chart convention (Class B/blue solid, Class
// C/magenta solid, Class D/blue dashed, Class E surface/magenta dashed),
// falling back to a thin gray dash for anything else (e.g. a Mode C veil).
const HOME_AIRSPACE_STYLE_BY_CLASS = {
    B: { color: '30, 144, 255', width: 3, dash: null },
    C: { color: '255, 0, 200', width: 3, dash: null },
    D: { color: '30, 144, 255', width: 2, dash: [8, 6] },
    E: { color: '255, 0, 200', width: 2, dash: [8, 6] }
};
const HOME_AIRSPACE_STYLE_DEFAULT = { color: '160, 160, 160', width: 1.5, dash: [4, 4] };

function homeAirspaceStyle(feature) {
    const config = HOME_AIRSPACE_STYLE_BY_CLASS[feature.get('CLASS')] || HOME_AIRSPACE_STYLE_DEFAULT;
    return new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: `rgba(${config.color}, 0.9)`,
            width: config.width,
            lineDash: config.dash
        }),
        fill: new ol.style.Fill({
            color: `rgba(${config.color}, 0.08)`
        })
    });
}

// Hazard-orange dashed outline for active TFRs - deliberately loud since
// these are safety notices, not routine airspace/chart reference.
const tfrStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({
        color: 'rgba(255, 60, 0, 0.95)',
        width: 3,
        lineDash: [10, 6]
    }),
    fill: new ol.style.Fill({
        color: 'rgba(255, 60, 0, 0.12)'
    })
});

// Strikes fade from full brightness to invisible over their max displayed
// age, so the overlay reads as "recent storm activity" rather than an
// ever-growing pile of dots. A style function (not a static style) re-runs
// on every render, which is what makes the fade actually animate as time
// passes - see the lightningVectorSource.changed() tick below.
const LIGHTNING_DISPLAY_MAX_AGE_MS = 10 * 60 * 1000;

function lightningStyle(feature) {
    const ageMs = Date.now() - feature.get("time");
    const opacity = Math.max(0, 1 - ageMs / LIGHTNING_DISPLAY_MAX_AGE_MS);
    return new ol.style.Style({
        image: new ol.style.Circle({
            radius: 5,
            fill: new ol.style.Fill({ color: `rgba(255, 235, 60, ${opacity})` }),
            stroke: new ol.style.Stroke({ color: `rgba(120, 90, 0, ${opacity * 0.9})`, width: 1 })
        })
    });
}

// Color-coded by hazard type, same map-lookup-with-default pattern as
// homeAirspaceStyle above. Both SIGMET and AIRMET APIs return "hazard" as
// a short code whose exact casing/separators vary by product, hence the
// normalize step before lookup.
function normalizeHazardCode(hazard) {
    return String(hazard || "").toUpperCase().replace(/[\s_]+/g, "-");
}

// Vivid, mutually-distinct hues per hazard (not muted grays/tans that
// blend into the sectional chart's own palette) plus a short text label,
// following the same "color = hazard type" convention EFB apps like
// ForeFlight use so a glance is enough to tell IFR from icing from
// turbulence without opening a legend.
const SIGMET_STYLE_BY_HAZARD = {
    "CONV": { color: '220, 20, 20', width: 3, label: 'CONV' },
    "CONVECTIVE": { color: '220, 20, 20', width: 3, label: 'CONV' },
    "TURB": { color: '210, 110, 0', width: 3, label: 'TURB' },
    "ICE": { color: '130, 60, 200', width: 3, label: 'ICE' }
};
const SIGMET_STYLE_DEFAULT = { color: '220, 20, 20', width: 3, label: 'SIGMET' };

function labelText(config) {
    return new ol.style.Text({
        text: config.label,
        font: 'bold 14px sans-serif',
        fill: new ol.style.Fill({ color: '#fff' }),
        stroke: new ol.style.Stroke({ color: `rgb(${config.color})`, width: 3 }),
        overflow: true
    });
}

function sigmetStyle(feature) {
    const config = SIGMET_STYLE_BY_HAZARD[normalizeHazardCode(feature.get('hazard'))] || SIGMET_STYLE_DEFAULT;
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: `rgba(${config.color}, 0.95)`, width: config.width, lineDash: [2, 4] }),
        fill: new ol.style.Fill({ color: `rgba(${config.color}, 0.22)` }),
        text: labelText(config)
    });
}

// Key names match the actual "hazard" values the G-AIRMET API returns
// (confirmed against live data: e.g. "MT_OBSC", not the "mtn_obs" query-
// param spelling the API docs use) after normalizeHazardCode's uppercase +
// hyphenate pass. Colors loosely follow the AIRMET Sierra/Tango/Zulu
// families ForeFlight uses (blue/gray = IFR & obscuration, amber/brown =
// turbulence & wind, purple/teal = icing & freezing level).
const AIRMET_STYLE_BY_HAZARD = {
    "IFR": { color: '30, 110, 220', label: 'IFR' },
    "TURB-HI": { color: '200, 120, 10', label: 'TURB' },
    "TURB-LO": { color: '200, 120, 10', label: 'TURB' },
    "ICE": { color: '150, 60, 190', label: 'ICE' },
    "MT-OBSC": { color: '139, 90, 43', label: 'MT OBSC' },
    "FZLVL": { color: '0, 160, 160', label: 'FZLVL' },
    "LLWS": { color: '200, 170, 0', label: 'LLWS' },
    "SFC-WIND": { color: '150, 180, 0', label: 'SFC WIND' }
};
const AIRMET_STYLE_DEFAULT = { color: '110, 110, 110', label: 'AIRMET' };

// A G-AIRMET panel is often a single polygon spanning several states, so a
// zoomed-in kiosk view can sit entirely inside one with no border ever in
// frame - the fill has to be visible on its own, not just the outline, or
// the overlay is effectively invisible against a busy sectional chart.
function airmetStyle(feature) {
    const config = AIRMET_STYLE_BY_HAZARD[normalizeHazardCode(feature.get('hazard'))] || AIRMET_STYLE_DEFAULT;
    return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: `rgba(${config.color}, 0.9)`, width: 2.5, lineDash: [8, 5] }),
        fill: new ol.style.Fill({ color: `rgba(${config.color}, 0.24)` }),
        text: labelText(config)
    });
}

/**
 * A SIGMET/AIRMET polygon's on-map text label only renders if its
 * geometry's interior point happens to fall inside the current view -
 * for a polygon spanning several states on a fixed-zoom kiosk display,
 * that's unreliable (confirmed: often 4+ degrees outside the visible
 * area even though the polygon's fill covers the whole screen). This
 * fixed on-screen key is what actually lets someone tell hazard types
 * apart, using ol.source.Vector#getFeaturesInExtent so it only lists
 * hazards actually present in the current view, not every hazard
 * nationwide.
 */
function updateHazardLegend() {
    if (!map || !sigmetVectorSource || !airmetVectorSource) return;

    const extent = map.getView().calculateExtent(map.getSize());
    const entries = new Map();

    sigmetVectorSource.getFeaturesInExtent(extent).forEach((feature) => {
        const config = SIGMET_STYLE_BY_HAZARD[normalizeHazardCode(feature.get('hazard'))] || SIGMET_STYLE_DEFAULT;
        entries.set(`SIGMET-${config.label}`, { group: 'SIGMET', label: config.label, color: config.color });
    });
    airmetVectorSource.getFeaturesInExtent(extent).forEach((feature) => {
        const config = AIRMET_STYLE_BY_HAZARD[normalizeHazardCode(feature.get('hazard'))] || AIRMET_STYLE_DEFAULT;
        entries.set(`AIRMET-${config.label}`, { group: 'AIRMET', label: config.label, color: config.color });
    });

    if (entries.size === 0) {
        hazardLegend.style.display = "none";
        return;
    }

    const rows = [...entries.values()].map((entry) => `
        <div class="hazard-legend-row">
            <span class="hazard-legend-swatch" style="background: rgb(${entry.color})"></span>
            <span>${entry.group} - ${escapeHtml(entry.label)}</span>
        </div>
    `).join("");
    hazardLegend.innerHTML = `<div class="hazard-legend-title">Active Hazards</div>${rows}`;
    hazardLegend.style.display = "block";
}

/**
 * Load airports into their feature collection 
 * @param {jsonobj} airport JSON object 
 */
function processAirports(jsonobj) {
    let usastates = new Map();
    let isoregions = new Map();
    try {
        for (let i=0; i< jsonobj.airports.length; i++) {
            let airport = jsonobj.airports[i];
            let lon = airport.lon;
            let lat = airport.lat;
            let isoregion = airport.isoregion;
            let country = airport.country;
            if (isoregion.search("US-") > -1) { 
                usastates.set(country, country);
            } 
            else {
                isoregions.set(country, country);
            }
            let airportFeature = new ol.Feature({
                ident: airport.ident,
                type: airport.type,
                datatype: "airport",
                isoregion: isoregion,
                country: country,
                geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
            });
            airportFeature.setId(airport.ident);
            if (airport.type === "heliport") {
                airportFeature.setStyle(heliportStyle);
            }
            else {
                airportFeature.setStyle(airportStyle);
            }
            airportFeatures.push(airportFeature);
            airportNameKeymap.set(airport.ident, airport.name);
            airportElevationKeymap.set(airport.ident, airport.elev);
            airportFeature.changed();
        }
 
        const savedHome = localStorage.getItem("homeAirport");
        if (savedHome && airportNameKeymap.has(savedHome)) {
            centerOnHomeAirport();
        }

        /**
         * This is for the region select dropdown list
         * Map sort all region airports in alpha order by US state 
         * we want US states to be at the top of the list followed
         * by the rest of the isoregions 
         */
        usastates[Symbol.iterator] = function* () {
            yield* [...this.entries()].sort((a, b) => a[1] - b[1]);
        }
        usastates.forEach((country, isoregion) => {
            let option = document.createElement("option");
            option.value = isoregion;
            option.text = country;
            regionselect.appendChild(option);
        });
        
        regionmap[Symbol.iterator] = function* () {
            yield* [...this.entries()].sort((a, b) => a[1] - b[1]);
        }
        isoregions.forEach((country, isoregion) => { 
            let option = document.createElement("option");
            option.value = isoregion;
            option.text = country;
            regionselect.appendChild(option);
        });
    }
    catch(err){
        console.error(err);
    }
}

/**
 * Region dropdown select event
 */
regionselect.addEventListener('change', (event) => {
    lastcriteria = event.target.value;
    selectFeaturesByCriteria();
});

/**
 * Called by select event to manipulate features
 * @param {*} criteria: string
 */
function selectFeaturesByCriteria() {
    airportFeatures.forEach((feature) => {
        let type = feature.get("type");
        let country = feature.get("country");
        if (type === "heliport") {
            feature.setStyle(heliportStyle);
        }
        else {
            feature.setStyle(airportStyle);
        }
        if (lastcriteria === "small_airport" || lastcriteria === "medium_airport" || 
            lastcriteria === "large_airport" || lastcriteria === "heliport") {
            if (type !== lastcriteria) {
                feature.setStyle(new ol.style.Style(undefined));
            }
        }
        else if (country !== lastcriteria && lastcriteria !== "allregions") {
            feature.setStyle(new ol.style.Style(undefined));        
        }
    });
}

/**
 * Websocket heartbeat
 */
let timerId = 0;
function keepAlive() { 
    var timeout = settings.keepaliveintervalmsec;  
    if (wsServerOpen) {  
        wsServer.send(Date.now());  
    }  
    timerId = setTimeout(keepAlive, timeout);  
}  
function cancelKeepAlive() {  
    if (timerId) {  
        clearTimeout(timerId);  
    }  
}

/**
 * Metar popup object
 */
const popup = document.getElementById('popup');
const popupcontent = document.getElementById('popup-content');
const popupoverlay = new ol.Overlay({
    element: popup,
    autoPan: true,
    autoPanAnimation: {
      duration: 500,
    },
});

/**
 * popup close event handler
 * @returns false!!
 */
function closePopup() {
    popupoverlay.setPosition(undefined);
    return false;
}

/**
 * Ownship image 
 */
if (settings.usestratux) {
    airplaneElement.style.transform = "rotate(" + last_heading + "deg)";
    airplaneElement.src = `img/${settings.ownshipimage}`;
    airplaneElement.addEventListener("mouseover", (event) => {
        console.log("MY AIRPLANE!!")
    });
}
else {
    airplaneElement.setAttribute('style', 'visibility:hidden');
}

/**
 * set the global view position from last saved history 
 */
let viewposition = ol.proj.fromLonLat([last_longitude, last_latitude]);

/**
 * Viewport extent for setting up map view
 */
let viewextent = [-180, -85, 180, 85];
let offset = [-18, -18];

/**
 * The scale of miles shown on lower left corner of map
 */
const scaleLine = new ol.control.ScaleLine({
    units: 'imperial',
    bar: true,
    steps: 4,
    minWidth: 140
});

/**
 * The map object that gets put in index.html <div> element
 */
const map = new ol.Map({
    target: 'map',
    view: new ol.View({
        center: viewposition,
        zoom: settings.startupzoom || 9,
        enableRotation: false,
        minZoom: 1,
        maxZoom: 22
    }),
    controls: ol.control.defaults().extend([scaleLine]),
    // This is a fixed ambient display with no input device in the field -
    // disable all pan/zoom/rotate interactions rather than picking them off
    // one at a time.
    interactions: [],
    overlays: [popupoverlay]
});


/**
 * Positioning of the ownship image feature
 */
if (settings.usestratux) {
    console.log("SETTING UP MYAIRPLANE!!");
    myairplane = new ol.Overlay({
        element: airplaneElement
    });
    myairplane.setOffset(offset);
    myairplane.setPosition(viewposition);
    map.addOverlay(myairplane);
}

/**
 * Event to handle scaling of feature images
 */
map.on('moveend', function(e) {
    const moveendCenter = map.getView().getCenter();
    const moveendZoom = map.getView().getZoom();
    if (hasCenteredOnHomeAirport && Array.isArray(moveendCenter) && moveendCenter.every(Number.isFinite) && Number.isFinite(moveendZoom)) {
        localStorage.setItem("lastMapView", JSON.stringify({ center: moveendCenter, zoom: moveendZoom }));
        updateVisibleCharts();
    }

    let newZoom = map.getView().getZoom();
    let inAnimation = false;
    if (currentZoom != newZoom) {
        if (animationId !== null) {
            inAnimation = true;
            stopWeatherRadar();
        }
        resizeDots(newZoom);
        currentZoom = newZoom;
        closePopup();
        if (inAnimation) {
            playWeatherRadar();
        }
    }
});

/**
 * Event to view Metar/TAF popup & closure
 */
map.on('click', (evt) => {
    let hasfeature = false;
    let coords = ol.proj.toLonLat(evt.coordinate);
    
    map.forEachFeatureAtPixel(evt.pixel, (feature) => {
        if (feature) {
            let datatype = feature.get("datatype");
    
            if (datatype === "metar") {
                return;
            } else if (datatype === "traffic") {
                displayTrafficPopup(feature);
            } else if (datatype === "taf") {
                displayTafPopup(feature);
            } else if (datatype === "pirep") {
                displayPirepPopup(feature);
            } else if (datatype === "airport") {
                displayAirportPopup(feature);
            } else if (datatype === "tfr") {
                displayTfrPopup(feature);
            }
    
            let coordinate = evt.coordinate;
            popupoverlay.setPosition(coordinate);
        }
    });
    // if (!hasfeature) {
    //     closePopup();
    // }
});

/**
 * Escape a value for safe interpolation into HTML built via template strings
 * @param {*} value
 * @returns {string} escaped string, safe to insert via innerHTML
 */
function escapeHtml(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Standard density altitude formula: pressure altitude corrects field
 * elevation for non-standard pressure, then density altitude corrects
 * that for non-standard (ISA) temperature.
 * @param {number} elevationFt field elevation, feet MSL
 * @param {number} tempC current outside air temperature, Celsius
 * @param {number} altimeterInHg current altimeter setting, inHg
 * @returns {number|null} density altitude in feet, or null if inputs are missing
 */
function calculateDensityAltitude(elevationFt, tempC, altimeterInHg) {
    if (!Number.isFinite(elevationFt) || !Number.isFinite(tempC) || !Number.isFinite(altimeterInHg)) {
        return null;
    }
    const pressureAltitude = elevationFt + (29.92 - altimeterInHg) * 1000;
    const isaTempC = 15 - (2 * pressureAltitude / 1000);
    return Math.round(pressureAltitude + 120 * (tempC - isaTempC));
}

/**
 * Plain-language gloss for a flight category, for non-pilot/student viewers.
 * @param {string} cat VFR/MVFR/IFR/LIFR
 * @returns {string}
 */
function describeFlightCategory(cat) {
    switch (cat) {
        case "VFR": return "Good flying weather";
        case "MVFR": return "Marginal - check ceilings/visibility";
        case "IFR": return "Instrument conditions - not VFR flyable";
        case "LIFR": return "Low instrument conditions - poor visibility/ceiling";
        default: return "";
    }
}

/**
 * Create the html for a METAR popup element
 * @param {feature} ol.Feature: the metar feature the user clicked on
 */
 function displayMetarPopup(feature) {
    let metar = feature.get("metar");
    let rawmetar = metar["raw_text"];
    let ident = metar.station_id;
    let svg = feature.get("svgimage");
    let cat = metar.flight_category;
    if (cat == undefined || cat == "undefined"){
        cat = "VFR";
    }
    let time = metar.observation_time;
    if (settings.uselocaltime) {
        time = getLocalTime(time);
    }
    let tempC = metar.temp_c;
    let dewpC = metar.dewpoint_c;
    let temp = convertCtoF(metar.temp_c);
    let dewp = convertCtoF(metar.dewpoint_c);
    let windir = metar.wind_dir_degrees;
    let winspd = metar.wind_speed_kt + "";
    let wingst = metar.wind_gust_kt + ""; 
    let altim = getAltimeterSetting(metar.altim_in_hg);
    let vis = getDistanceUnits(metar.visibility_statute_mi);
    let wxcode = metar.wx_string !== undefined ? decodeWxDescriptions(metar.wx_string) : "";
    let taflabelcssClass = "taflabel"
    let skycondition = metar.sky_condition;
    let skyconditions;
    let icingconditions;
    if (skycondition !== undefined) {
        skyconditions = decodeSkyCondition(skycondition, taflabelcssClass);
    }
    let icingcondition = metar.icing_condition;
    if (icingcondition !== undefined) {
        icingconditions = decodeIcingOrTurbulenceCondition(icingcondition, taflabelCssClass);
    }

    const elevationFt = airportElevationKeymap.get(ident);
    const densityAlt = calculateDensityAltitude(elevationFt, tempC, parseFloat(metar.altim_in_hg));
    const plainLanguage = describeFlightCategory(cat);

    if (ident != "undefined") {
        let name = getFormattedAirportName(ident);
        let html = `
    <div class="metar-header">${name}<br>${ident} - <span class="metar-category ${cat.toLowerCase()}">${cat}</span></div>
    <div class="metar-plainlanguage">${plainLanguage}</div>
    <table class="metar-table">
      <tr><td>Time:</td><td>${time}</td></tr>
      <tr><td>Temp:</td><td>${tempC} °C (${temp})</td></tr>
      <tr><td>Dewpoint:</td><td>${dewpC} °C (${dewp})</td></tr>
      <tr><td>Wind:</td><td>${windir}° @ ${winspd} kt</td></tr>
      <tr><td>Altimeter:</td><td>${altim} inHg</td></tr>
      <tr><td>Visibility:</td><td>${vis}</td></tr>
      <tr><td>Sky cover:</td><td>${skyconditions || ""}</td></tr>
      ${densityAlt !== null ? `<tr><td>Density Alt:</td><td>${densityAlt.toLocaleString()} ft</td></tr>` : ""}
    </table>
    <div class="wind-graphic">${svg}</div>
    <textarea class="rawdata">${escapeHtml(rawmetar)}</textarea>
  `;
        const existingBox = document.getElementById("homeMetarBox");
        if (existingBox) {
            existingBox.innerHTML = html;
        } else {
            const box = document.createElement("div");
            box.id = "homeMetarBox";
            box.className = "static-metar-popup";
            box.innerHTML = html;
            document.body.appendChild(box);
        }
    }
}

/**
 * Create the html for a TAF popup element
 * @param {feature} ol.Feature: the taf feature the user clicked on
 */
function displayTafPopup(feature) {
    let taf = feature.get("taf");
    let rawtaf = taf["raw_text"];
    let forecast = taf.forecast;
    let outerhtml = `<div class="taftitle">` + 
                        `<label class="taftitlelabel">Terminal Area Forecast - ${feature.get("ident")}</label>` +
                    `</div>` +
                    `<div class="taf">` + 
                        `<pre><code>` +
                        `<table class="tafmessage" id="taftable">` +
                            `<tr class="tafbody">` + 
                                `<td id="tafdata">###</td>` +
                            `</tr>` +
                        `</table>` +
                        `</code></pre>` +                 
                    `</div>` + 
                    `<br /><br />`;

    let html = "<div>";
    
    for (const item in forecast) {
        let value = forecast[item];
        if (typeof(value) === 'object') {
            for (const subitem in value) {
                let subvalue = value[subitem];
                html += parseForecastField(subitem, subvalue);
            }
            html += "</p><hr>";
        } 
        else {
            html += parseForecastField(item, value);
        }
    }
    
    html += `</p></div><textarea class="rawdata">${escapeHtml(rawtaf)}</textarea><br />`;
    html += `<p><button class="ol-popup-closer" onclick="closePopup()">close</button></p></div>`;
    let innerhtml = outerhtml.replace("###", html);
    popupcontent.innerHTML = innerhtml;
}

/**
 * Parse forcast fields from metars or tafs
 * @param {string} rawfieldname - the object key before "cleaning" underscores, etc.
 * @param {object} fieldvalue json object corresponding to the key
 * @returns 
 */
function parseForecastField(rawfieldname, fieldvalue) {
    let fieldname = tafFieldKeymap.get(rawfieldname);
    let html = "";
    let formattedvalue = "";
    switch (rawfieldname) {
        case "fcst_time_from":
            let thistime = fieldvalue;
            if (settings.uselocaltime) {
                thistime = getLocalTime(fieldvalue);
            }
            html = `<label class="fcstlabel"><b>${thistime}</b></label></b><br />`;
            break;
        case "fcst_time_to": // I'm going to ignore this field to save space on the popup
            //html = `&nbspto&nbsp<b>${fieldvalue}</b></label><br />`
            //html = `<label class="fcstlabel">${formattedvalue}</label><br />`;
            break;
        case "change_indicator":
            let changevalue = getWeatherAcronymDescription(fieldvalue);
            html = `<label class="taflabel">${fieldname}: <b>${changevalue}</b></label><br />`;
            break;
        case "temperature":
        case "time_becoming":
        case "probability":
        case "wind_speed_kt":
        case "wind_gust_kt":
        case "wind_shear_hgt_ft_agl":
        case "wind_shear_speed_kt":
        case "altim_in_hg":
        case "vert_vis_ft":
        case "wx_string":
            if (fieldname === "wx_string") {
                formattedvalue = decodeWxDescriptions(fieldvalue);
                html = `<label class="tafwxlabel">${fieldname}: <b>${formattedvalue}</b></label><br />`;
            }
            else {
                html = `<label class="taflabel">${fieldname}: <b>${fieldvalue}</b></label><br />`;
            }
            break;
        case "sky_condition":
            formattedvalue = decodeSkyCondition(fieldvalue);
            html = `<label class="tafskyheader">${fieldname}</label><br />${formattedvalue}`;
            break;
        case "turbulence_condition":
        case "icing_condition":
            formattedvalue = decodeIcingOrTurbulenceCondition(fieldvalue);
            html = `<label class="tafskyheader">${fieldname}</label><br />${formattedvalue}`;
            break;
        case "wind_dir_degrees":
        case "wind_shear_dir_degrees":
            html = `<label class="taflabel">${fieldname}: <b>${fieldvalue} Degrees</b></label><br />`;
            break;

    }
    return html;
}

/**
 * Create the html for a PIREP popup element
 * @param {object} feature: the pirep the user clicked on
 */
 function displayPirepPopup(feature) {
    let aircraftreport = feature.get("pirep");
    let rawaircraftreport = aircraftreport["raw_text"];
    let outerhtml = `<div class="taftitle">` + 
                        `<label class="taftitlelabel">${aircraftreport.report_type} FROM AIRCRAFT: ${aircraftreport.aircraft_ref}</label><p></p>` +
                    `</div>` +
                    `<div class="taf">` + 
                        `<pre><code>` +
                        `<table class="tafmessage" id="taftable">` +
                            `<tr class="tafbody">` + 
                                `<td id="tafdata">###</td>` +
                            `</tr>` +
                        `</table>` +
                        `</code></pre>` +                 
                    `</div>` + 
                    `<br /><br />`;

    let html = "<div>";
    let pireplabel = `<label class="pirepitem">`
    let thistime = "";
    for (const pirepkey in aircraftreport) {
        let pirepvalue = aircraftreport[pirepkey];
        let fieldname = getFieldDescription(pirepkey);
        switch (pirepkey) {
            case "receipt_time":
                thistime = pirepvalue;
                if (settings.uselocaltime) {
                    thistime = getLocalTime(pirepvalue);
                }
                html += `${pireplabel}${fieldname}: <b>${thistime}</b></label><br />`;
                break;
            case "observation_time":
                thistime = pirepvalue;
                if (settings.uselocaltime) {
                    thistime = getLocalTime(pirepvalue);
                }
                html += `${pireplabel}${fieldname}: <b>${thistime}</b></label><br />`;
                break;
            case "latitude":
            case "longitude":
            case "altitude_ft_msl":
            case "temp_c":
            case "dewpoint_c":
            case "time_becoming":
            case "probability":
            case "wind_speed_kt":
            case "wind_gust_kt":
            case "wind_dir_degrees":
            case "wind_shear_dir_degrees":
            case "wind_shear_hgt_ft_agl":
            case "wind_shear_speed_kt":
            case "vert_vis_ft":
            case "visibility_statute_mi":
                html += `${pireplabel}${fieldname}: <b>${pirepvalue}°</b></label><br />`;
                break;
            case "sky_condition":
                html += `<label class="pirepskyheader">${fieldname}</label><br />`;
                html += decodeSkyCondition(pirepvalue, "pirepitem");
                html += "<hr>";
                break;
            case "turbulence_condition":
            case "icing_condition":
                html += `<label class="pirepskyheader">${fieldname}</label><br />`;
                html += decodeIcingOrTurbulenceCondition(pirepvalue, "pirepitem");
                html += "<hr>";
                break;
            case "temperature":
                html += `<label class="pirepskyheader">Weather</label><br />`;
                break;
            case "altim_in_hg":
                let altimvalue = getInchesOfMercury(pirepvalue);
                html += `<label class="pirepitem">${fieldname}: <b>${altimvalue}</b></label><br />`;
                break;
            case "wx_string":
                let lineval = decodeWxDescriptions(pirepvalue);
                html += `<label class="pirepitem">${fieldname}: <b>${lineval}</b></label><br />`;
                break;
            case "change_indicator":
                let change = getSkyConditionDescription(pirepvalue);
                html += `<label class="pirepitem">${fieldname}: <b>${change}</b></label><br />`;
                break;
            case "pirep_type":
            case "aircraft_ref":
            case "raw_text":
                break;
            default:
                console.log(`${pirepkey} NOT FOUND!`);
                break;
        }
    }
    html += `</p></div><textarea class="rawdata">${escapeHtml(rawaircraftreport)}</textarea>`;
    html += `<p><button class="ol-popup-closer" onclick="closePopup()">close</button></p></div>`;
    let innerhtml = outerhtml.replace("###", html);
    popupcontent.innerHTML = innerhtml;
}

/**
 * Decode sky conditions
 * @param {object} json object skyconditions 
 * @param {string} css class to use 
 * @returns html string 
 */
 function decodeSkyCondition(skycondition, labelclassCss) {
    let html = "";
    if (skycondition !== undefined) {
        try {
            let values = Object.values(skycondition);
            for (const x in skycondition) {
                let condition = skycondition[x];
                let fieldname = "";
                let fieldvalue = "";
                if (typeof(condition) !== "string") {
                    for (const index in condition) {
                        fieldname = getFieldDescription(index);
                        fieldvalue = condition[index];
                        html += `<label class="${labelclassCss}">${fieldname}: <b>${fieldvalue}</b></label><br />`;
                    }
                }
                else {
                    fieldname = getFieldDescription(x);
                    fieldvalue = getSkyConditionDescription(condition);
                    html += `<label class="${labelclassCss}">${fieldname}: <b>${fieldvalue}</b></label><br />`;
                }
            }
        }
        catch (error) {
            console.log(error.message);
        }
    }
    return html;
}

/**
 * Get inches of mercury fixed at 2 decimal places
 * @param {float} altimeter 
 * @returns 
 */
function getInchesOfMercury(altimeter) {
    let inhg = parseFloat(altimeter);
    return inhg.toFixed(2);
}

/**
 * Decode icing or turbulence condition
 * @param {object} condition json object 
 * @returns html string
 */
function decodeIcingOrTurbulenceCondition(condition) {
    let html = "";
    for (const item in condition) {
        let value = condition[item];
        if (typeof(value) === 'object') {
            html += "<p>";
            for (const subitem in value) {
                let subvalue = value[subitem];
                html += parseConditionField(subitem, subvalue);
            }
            html += "</p><hr>";
        } 
        else {
            html += parseConditionField(item, value);
        }
    }        
    return html;        
}

/**
 * Parse an icing or turbulence condition field value, 
 * which could be an object or a string and return html
 * @param {string} rawfieldname 
 * @param {object} fieldvalue 
 * @returns html string
 */
function parseConditionField(rawfieldname, fieldvalue) {
    let fieldname = getFieldDescription(rawfieldname);
    let image = "";
    let html = "";
    switch (rawfieldname) {
        case "turbulence_type":
        case "icing_type":
            html += `<label class="pirepitem">${fieldname}: <b>${fieldvalue}</b></label><br />`;
            break; 
        case "turbulence_intensity":
        case "icing_intensity":
            image = getConditionImage(rawfieldname, fieldvalue);
            html += `<label class="pirepitem">${fieldname}</label>`;
            html += `<div class="conditionimage"><image src="${URL_SERVER}/img/${image}"></div><br />`;
            break;
        case "turbulence_base_ft_msl":
        case "icing_base_ft_msl":
            html += `<label class="pirepitem">${fieldname}: <b>${fieldvalue}</b></label><br />`;
            break;
        case "turbulence_top_ft_msl":
        case "icing_top_ft_msl":
            html += `<label class="pirepitem">${fieldname}: <b>${fieldvalue}</b></label></br />`;
            break;
        default:
            break;
    }
    return html;
}

/**
 * Get the image that corresponds to icing or turbulence condition
 * @param {string} conditiontype 
 * @param {string} conditionvalue 
 * @returns html image string
 */
function getConditionImage(conditiontype, conditionvalue) {
    let image = "";
    if (conditiontype === "icing_intensity") {
        switch (conditionvalue) {
            case "NEGclr":
            case "NEG":
                image = "Nil.png";
                break;
            case "RIME":
            case "TRC":
                image = "IceTrace.png";
                break;
            case "TRC-LGT":
                image = "IceTraceLight.png"
                break;
            case "LGT":
                image = "IceLight.png";
                break;
            case "LGT-MOD":
                image = "IceLightMod.png";
                break;
            case "MOD":
                image = "IceMod.png";
                break;
            case "MOD-SEV":
                image = "IceLight.png";
                break;
            case "SEV":
                image = "IceSevere.png";
                break;
        }
    }   
    else if (conditiontype === "turbulence_intensity") { 
        switch (conditionvalue) {
            case "NEG":
            case "NEGclr": 
                image = "Nil.png";
                break;
            case "SMTH-LGT":
            case "LGT":
                image = "TurbSmoothLight.png";
                break;
            case "LGT-CHOP":
                image = "TurbLight.png";    
                break;
            case "CHOP":
            case "LGT-MOD":
                image = "TurbLightMod.png";
                break;
            case "MOD":
            case "MOD-CHOP":
                image = "TurbMod.png";
                break;
            case "MOD-SEV":
                image = "TurbModSevere.png";
                break;
            case "SEV":
                image = "TurbSevere.png";
                break;
        }
    }
    else {
        image = "";
    }
    
    return image;
}

/**
 * Build the html for an airport feature
 * @param {*} feature: the airport the user clicked on 
 */
function displayAirportPopup(feature) {
    let ident = feature.get("ident");
    let name = getFormattedAirportName(ident)
    let html = `<div id="#featurepopup"><pre><code><p>`;
        html += `<label class="airportpopuplabel">${name} - ${ident}</label><p></p>`;
        html += `</p></code></pre></div>`;
        html += `<p><button class="ol-airport-closer" onclick="closePopup()">close</button></p>`;
    popupcontent.innerHTML = html;
}

/**
 * Build the html for a TFR (Temporary Flight Restriction) feature
 * @param {*} feature: the TFR the user clicked on
 */
function displayTfrPopup(feature) {
    const type = feature.get("type") || "TFR";
    const description = feature.get("description") || "";
    const notamId = feature.get("notam_id") || "";

    let html = `<div><p>`;
    html += `<label class="pirepitem"><b>${escapeHtml(type)}</b></label><br />`;
    html += `<label class="pirepitem">${escapeHtml(description)}</label><br />`;
    if (notamId) {
        html += `<label class="pirepitem">NOTAM ${escapeHtml(notamId)}</label><br />`;
    }
    html += `</p></div>`;
    html += `<p><button class="ol-popup-closer" onclick="closePopup()">close</button></p>`;
    popupcontent.innerHTML = html;
}

/**
 * Build the html for a traffic feature
 * @param {*} feature: the traffic the user clicked on
 */
function displayTrafficPopup(feature) {
    const item = feature.get("traffic") || {};
    const info = aircraftInfoCache.get((item.Icao_addr || "").toLowerCase());

    let html = `<div><p>`;
    if (info) {
        html += `<label class="pirepitem"><b>${escapeHtml(info.registration || item.Icao_addr)}</b></label><br />`;
        if (info.manufacturer || info.model) {
            html += `<label class="pirepitem">${escapeHtml([info.manufacturer, info.model].filter(Boolean).join(" "))}</label><br />`;
        }
        if (info.operator) {
            html += `<label class="pirepitem">${escapeHtml(info.operator)}</label><br />`;
        }
    }
    else {
        html += `<label class="pirepitem"><b>${escapeHtml(item.Icao_addr || "Unknown aircraft")}</b></label><br />`;
        html += `<label class="pirepitem">No aircraft database match</label><br />`;
    }
    if (Number.isFinite(item.Speed)) {
        html += `<label class="pirepitem">Speed: <b>${Math.round(item.Speed)} kt</b></label><br />`;
    }
    if (Number.isFinite(item.Track)) {
        html += `<label class="pirepitem">Heading: <b>${Math.round(item.Track)}&deg;</b></label><br />`;
    }
    html += `</p><p><button class="ol-popup-closer" onclick="closePopup()">close</button></p></div>`;

    popupcontent.innerHTML = html;
}

const TRAFFIC_TTL_MS = 2 * 60 * 1000;

function processTraffic() {
    const now = Date.now();
    for (const [key, item] of trafficMap) {
        if (!item.lastUpdated || now - item.lastUpdated > TRAFFIC_TTL_MS) {
            trafficMap.delete(key);
        }
    }

    trafficFeatures.clear();

    for (const [key, item] of trafficMap) {
        try {
            if (!item || !Number.isFinite(item.Lat) || !Number.isFinite(item.Lng)) continue;

            const coord = ol.proj.fromLonLat([item.Lng, item.Lat]);
            const tradians = (item.Track || 0) * Math.PI / 180;

            const trafficFeature = new ol.Feature({
                geometry: new ol.geom.Point(coord),
                datatype: "traffic",
                traffic: item
            });
            const icon = getTrafficIcon(item.Icao_addr);
            const iconColor = isMilitaryAircraft(item.Icao_addr) ? '#ff2222' : '#1565c0';
            trafficFeature.setStyle([
                // A same-shape black copy, slightly larger, rendered behind
                // the colored icon - reads as an outline that follows the
                // actual silhouette instead of a plain circular halo, and
                // is what makes the icon read against light chart terrain.
                new ol.style.Style({
                    image: new ol.style.Icon({
                        src: icon.src,
                        crossOrigin: 'anonymous',
                        scale: icon.scale * 1.22,
                        rotation: tradians,
                        color: '#000000'
                    })
                }),
                new ol.style.Style({
                    image: new ol.style.Icon({
                        src: icon.src,
                        crossOrigin: 'anonymous',
                        scale: icon.scale,
                        rotation: tradians,
                        // Icon assets are plain white silhouettes so this
                        // color option (a clean multiplicative tint)
                        // reliably produces an exact hex regardless of
                        // shape - civilian traffic is a darker blue that
                        // stands out against the sectional's yellow/olive
                        // palette, military is the only thing called out
                        // in red.
                        color: iconColor
                    })
                })
            ]);
            trafficFeatures.push(trafficFeature);

            // ForeFlight-style trend vector: a line showing where this
            // aircraft will be in ~60 seconds at its current track/speed.
            if (Number.isFinite(item.Speed) && item.Speed > 0) {
                const speedMetersPerSec = item.Speed * 0.514444; // knots -> m/s
                const vectorLengthMeters = speedMetersPerSec * 60;
                const endCoord = [
                    coord[0] + vectorLengthMeters * Math.sin(tradians),
                    coord[1] + vectorLengthMeters * Math.cos(tradians)
                ];
                const vectorFeature = new ol.Feature({
                    geometry: new ol.geom.LineString([coord, endCoord]),
                    datatype: "traffic-vector"
                });
                vectorFeature.setStyle([
                    // Black outline first so the line reads against yellow
                    // chart symbols/airport markers, same treatment as the
                    // icon halo.
                    new ol.style.Style({
                        stroke: new ol.style.Stroke({ color: '#000000', width: 4 })
                    }),
                    new ol.style.Style({
                        stroke: new ol.style.Stroke({ color: '#ffcc00', width: 2 })
                    })
                ]);
                trafficFeatures.push(vectorFeature);
            }
        }
        catch (err) {
            // Isolate one malformed entry from the rest of the rebuild -
            // this previously let a single bad item silently zero out
            // every other valid traffic feature on every subsequent update.
            console.error(`Traffic render error for ${key}:`, err);
        }
    }
    // trafficVectorSource was constructed with `features: trafficFeatures`,
    // so it already mirrors this collection live - no separate sync step
    // needed. (Previously this called trafficVectorSource.clear(), which
    // clears the SAME shared collection - wiping out everything just
    // pushed above on every single call, which is why traffic never
    // rendered no matter how much data was in trafficMap.)
}

/**
 * Place metar features on the map. color-coded to the conditions
 * @param {object} metarsobject: JSON object with LOTS of metars
 */
 function processMetars(metarsobject) {
    let newmetars = metarsobject.response.data.METAR;
    if (newmetars !== undefined) {
        metarFeatures.clear();
        metarMarkers = [];
        let scaleSize = getScaleSize();
        try {
            newmetars.forEach((metar) => {
                let svg = "";
                let svg2 = "";
                try { 
                    svg = rawMetarToSVG(metar.raw_text, 150, 150, settings.usemetricunits);
                    svg2 = getWindBarbSvg(95, 95, metar); 
                }
                catch { }
                  
                let metarFeature = new ol.Feature({
                    metar: metar,
                    datatype: "metar",
                    geometry: new ol.geom.Point(ol.proj.fromLonLat([metar.longitude, metar.latitude])),
                    svgimage: svg 
                });
                let cat = metar.flight_category;
                let styleColor;
                switch (cat) {
                    case "VFR":
                        styleColor = "rgba(9, 236, 74, 0.9)"; 
                        break;
                    case "MVFR":
                        styleColor = "rgba(7, 99, 247, 0.9)";
                        break;
                    case "IFR":
                        styleColor = "rgba(255, 0, 0, 0.9)";
                        break;
                    case "LIFR":
                        styleColor = "rgba(255, 0, 255, 0.9)";
                        break;
                    default:
                        styleColor = "rgba(102, 204, 255, 0.9)";
                        break;
                }
                const markerStyle = new ol.style.Style({
                    image: new ol.style.Circle({
                        radius: 10,
                        fill: new ol.style.Fill({ color: styleColor }),
                        stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 })
                    })
                });
                metarFeature.setStyle(markerStyle);
                metarFeature.setId(metar.station_id);
                metarFeatures.push(metarFeature);
                metarFeature.changed();
            });
        }
        catch(error) {
            console.log(error.message);
        }
                // After all METARs processed, show home METAR dialog (popup position not reset)
        setTimeout(() => {
            const savedHome = localStorage.getItem("homeAirport");
            if (savedHome && airportNameKeymap.has(savedHome)) {
                const metarFeature = metarFeatures.getArray().find(f => {
                    const metar = f.get("metar");
                    const featureId = f.getId();
                    return metar && (metar.station_id?.toUpperCase() === savedHome || featureId?.toUpperCase() === savedHome);
                });

                if (metarFeature && popupoverlay) {
                    const metar = metarFeature.get("metar");
                    const rawmetar = metar?.raw_text;
                    if (rawmetar) {
                        displayMetarPopup(metarFeature);
                        const popupEl = popupoverlay.getElement();
                        popupEl.style.position = 'fixed';
                        popupEl.style.bottom = '10px';
                        popupEl.style.right = '10px';
                        popupEl.style.top = 'unset';
                        popupEl.style.left = 'unset';
                        popupEl.style.display = 'block';
                        popupEl.style.zIndex = '2000';
                    } else {
                        console.log("Home METAR missing raw_text:", savedHome);
                    }
                } else {
                    console.log("No matching METAR found for home airport:", savedHome);
                    console.log("Available METAR features:", metarFeatures.getArray().map(f => f.getId()));
                }
            }
        }, 1000);

        updateFavoritesStrip();
    }
}

/**
 * Place taf feature objects on the map
 * @param {object} tafsobject: JSON object with LOTS of tafs 
 */
function processTafs(tafsobject) {
    let newtafs = tafsobject.response.data.TAF;
    if (newtafs !== undefined) {
        tafFeatures.clear();
        try {
            newtafs.forEach((taf) => {
                let taffeature = new ol.Feature({
                    ident: taf.station_id,
                    taf: taf,
                    datatype: "taf",
                    geometry: new ol.geom.Point(ol.proj.fromLonLat([taf.longitude, taf.latitude]))
                });
                taffeature.setId(taf.station_id);
                taffeature.setStyle(tafStyle);
                tafFeatures.push(taffeature);
                taffeature.changed();
            });
        }
        catch (error){
            console.log(error.message);
        }
    }
}

/**
 * Place pirep features on the map
 * @param {object} pirepsobject: JSON object with LOTS of pireps 
 */
 function processPireps(pirepsobject) {
    let newpireps = pirepsobject.response.data.AircraftReport;
    if (newpireps !== undefined) {
        pirepFeatures.clear();
        try {
            newpireps.forEach((pirep) => {
                // generate a "pseudo-heading" to use if wind dir is absent
                let heading = Math.random()*Math.PI*2;
                if (pirep.wind_dir_degrees) {
                    heading = (pirep.wind_dir_degrees * 0.0174533);
                }
                let pirepfeature = new ol.Feature({
                    ident: pirep.aircraft_ref,
                    pirep: pirep,
                    datatype: "pirep",
                    geometry: new ol.geom.Point(ol.proj.fromLonLat([pirep.longitude, pirep.latitude])),
                });
                
                pirepfeature.setId(pirep.aircraft_ref);
                pirepfeature.setStyle(new ol.style.Style({
                                        image: new ol.style.Icon({
                                            crossOrigin: 'anonymous',
                                            src: `${URL_SERVER}/img/airplane.svg`,
                                            //size:[85, 85],
                                            offset: [0,0],
                                            opacity: 1,
                                            scale: .05,
                                            rotation: heading
                                        })
                                    })
                );
                pirepFeatures.push(pirepfeature);
            });
        }
        catch (error){
            console.log(error.message);
        }
    }
}

/**
 * This routine adjusts feature "dot" image 
 * sizes, depending on current zoom level
 */
let resizing = false;
function resizeDots(newzoom) {
    if (!resizing) {
        resizing = true;
        currentZoom = parseInt(newzoom.toFixed(0));
        let newscale = getScaleSize();
        for (let i = 0; i < metarMarkers.length; i++) {
            metarMarkers[i].setScale(newscale);
        }
        //pirepMarker.setScale(newscale * .08);
        airportMarker.setScale(newscale);
        heliportMarker.setScale(newscale);
        tafMarker.setScale(newscale * .2);
        resizing = false;
    }
}

function getScaleSize() {
    let scale = 1;
    switch(true) {
        case currentZoom >= 0 && currentZoom < 1:
            scale = .10;
            break;
        case currentZoom >= 1 && currentZoom < 2:
            scale = .15;
            break;
        case currentZoom >= 2 && currentZoom < 3:
            scale = .20;
            break;
        case currentZoom >= 3 && currentZoom < 4:
            scale = .25;
            break;
        case currentZoom >= 4 && currentZoom < 5:
            scale = .35;
            break;
        case currentZoom >= 5 && currentZoom < 6:
            scale = .45;
            break;
        case currentZoom >= 6 && currentZoom < 7:
            scale = .55;
            break;
        case currentZoom >= 7 && currentZoom < 8:
            scale = .65;
            break;
        case currentZoom >= 8 && currentZoom < 9:
            scale = .75;
            break;
        case currentZoom >= 9 && currentZoom < 10:
            scale = .90;
            break;
        case currentZoom >= 10 && currentZoom < 11:
            scale = 1.1;
            break;
        case currentZoom >= 11:
            scale = 1.3;
            break;
    }
    return scale;
}

/**
 * Add tile data for all layers
 */
let extent = ol.proj.transformExtent(viewextent, 'EPSG:4326', 'EPSG:3857')
debugTileLayer = new ol.layer.Tile({
    title: "Debug",
    type: "overlay",
    source: new ol.source.TileDebug(),
    visible: false,
    extent: extent,
    zIndex: 12
});

metarVectorSource = new ol.source.Vector({
    features: metarFeatures
});
metarVectorLayer = new ol.layer.Vector({
    title: "Metars",
    source: metarVectorSource,
    visible: true,
    extent: extent,
    zIndex: 12
});

airportVectorSource = new ol.source.Vector({
    features: airportFeatures
});
airportVectorLayer = new ol.layer.Vector({
    title: "All Airports",
    source: airportVectorSource,
    visible: false,
    extent: extent,
    zIndex: 11
}); 

tafVectorSource = new ol.source.Vector({
    features: tafFeatures
});
tafVectorLayer = new ol.layer.Vector({
    title: "TAFs",
    source: tafVectorSource,
    visible: false,
    extent: extent,
    zIndex: 13
});

pirepVectorSource = new ol.source.Vector({
    features: pirepFeatures
});
pirepVectorLayer = new ol.layer.Vector({
    title: "Pireps",
    source: pirepVectorSource,
    visible: false,
    extent: extent, 
    zIndex: 14
});

trafficVectorSource = new ol.source.Vector({
    features: trafficFeatures,
    // Required backlink per the icon set's license terms (free for
    // commercial use with attribution) - see getTrafficIcon.
    attributions: ['Aircraft icons: <a href="https://adsb-radar.com" target="_blank">ADS-B Radar</a>']
});
trafficVectorLayer = new ol.layer.Vector({
    title: "Traffic",
    source: trafficVectorSource,
    visible: false,
    extent: extent,
    zIndex: 14
});
map.addLayer(trafficVectorLayer);
trafficVectorLayer.setVisible(true);

homeAirspaceVectorSource = new ol.source.Vector({
    features: homeAirspaceFeatures
});
homeAirspaceVectorLayer = new ol.layer.Vector({
    title: "Home Airspace",
    source: homeAirspaceVectorSource,
    style: homeAirspaceStyle,
    visible: true,
    extent: extent,
    zIndex: 10.6
});
map.addLayer(homeAirspaceVectorLayer);

tfrVectorSource = new ol.source.Vector({
    features: tfrFeatures
});
tfrVectorLayer = new ol.layer.Vector({
    title: "TFRs",
    source: tfrVectorSource,
    style: tfrStyle,
    visible: true,
    extent: extent,
    zIndex: 12.5
});
map.addLayer(tfrVectorLayer);

airmetVectorSource = new ol.source.Vector({
    features: airmetFeatures
});
airmetVectorLayer = new ol.layer.Vector({
    title: "AIRMETs",
    source: airmetVectorSource,
    style: airmetStyle,
    visible: true,
    extent: extent,
    zIndex: 11.5
});
map.addLayer(airmetVectorLayer);

sigmetVectorSource = new ol.source.Vector({
    features: sigmetFeatures
});
sigmetVectorLayer = new ol.layer.Vector({
    title: "SIGMETs",
    source: sigmetVectorSource,
    style: sigmetStyle,
    visible: true,
    extent: extent,
    zIndex: 12.7
});
map.addLayer(sigmetVectorLayer);

lightningVectorSource = new ol.source.Vector({
    features: lightningFeatures
});
lightningVectorLayer = new ol.layer.Vector({
    title: "Lightning",
    source: lightningVectorSource,
    style: lightningStyle,
    visible: true,
    extent: extent,
    zIndex: 13
});
map.addLayer(lightningVectorLayer);

// Strikes have no visibility change of their own to trigger a repaint, so
// this tick forces the fade (see lightningStyle) to actually animate, and
// drops strikes older than the display window instead of leaving them
// invisible-but-present forever.
setInterval(() => {
    const cutoff = Date.now() - LIGHTNING_DISPLAY_MAX_AGE_MS;
    const stale = lightningFeatures.getArray().filter((feature) => feature.get("time") < cutoff);
    stale.forEach((feature) => lightningFeatures.remove(feature));
    lightningVectorSource.changed();
}, 10 * 1000);

if (settings.useOSMonlinemap) {
    const osmOnlineTileLayer = new ol.layer.Tile({
        title: "Open Street Maps",
        type: "overlay",
        source: new ol.source.OSM(),
        visible: false,
        extent: extent //,
        //zIndex: 8
    });
    map.addLayer(osmOnlineTileLayer);
}

if (settings.debug) {
    map.addLayer(debugTileLayer);
}

map.addLayer(airportVectorLayer);
map.addLayer(metarVectorLayer); 
map.addLayer(tafVectorLayer);
map.addLayer(pirepVectorLayer);
//if (settings.usestratux) {
//    map.addLayer(trafficVectorLayer);
//}

function addChartLayers() {
    dblist.reverse();
    Object.entries(dblist).forEach((db) => {
        let dbname = db[1];
        let metadata = {};
        for (var i = 0; i < metadatasets.length; i++) {
            if (metadatasets[i]["key"] === dbname) {
                metadata = metadatasets[i]["value"];
                break;
            }
        }

        let zOrder = 10;
        if (dbname === "terminal") {
            zOrder = 12;
        }

        if (JSON.stringify(metadata) != "{}") {
            let dburl = URL_GET_TILE.replace("{dbname}", dbname);
            let layerExtent = extent;
            if (metadata.bounds) {
                const bounds4326 = metadata.bounds.split(",").map(Number);
                layerExtent = ol.proj.transformExtent(bounds4326, 'EPSG:4326', 'EPSG:3857');
            }
            var layer = new ol.layer.Tile({
                title: metadata.description,
                type: metadata.type,
                source: new ol.source.XYZ({
                    url: dburl,
                    maxZoom: Number(metadata.maxzoom),
                    minZoom: Number(metadata.minzoom),
                    attributions: settings.showattribution == true ? metadata.attribution : "",
                    attributionsCollapsible: false
                }),
                visible: false,
                extent: layerExtent,
                zIndex: zOrder
            });
            map.addLayer(layer);
        }
    });
}



airportVectorLayer.on('change:visible', () => {
    let visible = airportVectorLayer.get('visible');
    regioncontrol.style.visibility = visible ? 'visible' : 'hidden';
    if (visible) {
        regionselect.options[0].selected = true;
        regionselect.value = lastcriteria; 
        selectFeaturesByCriteria()
        closePopup();
    }
});

/**
 * This allows a clicked feature to raise an event
 */
let select = null;
function selectStyle(feature) {
    console.log(`FEATURE: ${feature}`);
    return selected;
}

/**
 * If saving position history is enabled,  
 * save it at a specified time interval
 */
if (settings.savepositionhistory) {
    setInterval(savePositionHistory, settings.histintervalmsec);
}

/**
 * Build one persistent WMS layer per historical radar timestamp (last 3
 * hours, 15-minute steps, matching the NEXRAD update cadence). All frames
 * are added to the map up front; playback just toggles visibility between
 * them, so tiles for a given frame only ever need to load once, not on
 * every animation tick. The newest frame is always "now" - never rounded
 * into the future - so the default (non-animated) view always shows real,
 * already-available data.
 */
// Iowa State's higher-resolution "digital reflectivity" mosaic (n0q) -
// noticeably smoother/less pixelated than the legacy 8-bit n0r product
// this used before - doesn't support a single time-parameterized layer
// the way n0r-wmst did. Instead each of these fixed "minutes ago" offsets
// is its own named layer, computed relative to request time server-side;
// oldest first so the existing "last index = latest frame" convention
// (see showLatestRadarFrame/advanceRadarFrame) keeps working unchanged.
const N0Q_OFFSET_SUFFIXES = ['-m55m', '-m50m', '-m45m', '-m40m', '-m35m', '-m30m', '-m25m', '-m20m', '-m15m', '-m10m', '-m05m', ''];

function setupRadarAnimation() {
    const STEP_MS = 5 * 60 * 1000;
    const now = Date.now();

    N0Q_OFFSET_SUFFIXES.forEach((suffix, i) => {
        const minutesAgo = N0Q_OFFSET_SUFFIXES.length - 1 - i;
        const timestamp = new Date(now - STEP_MS * minutesAgo);
        const source = new ol.source.TileWMS({
            attributions: ['Iowa State University'],
            url: settings.animatedwxurl,
            params: { 'LAYERS': `nexrad-n0q${suffix}` }
        });
        const layer = new ol.layer.Tile({
            title: 'Radar',
            extent: extent,
            source: source,
            visible: false,
            opacity: 0.65,
            zIndex: 10.5
        });
        map.addLayer(layer);
        radarFrameLayers.push(layer);
        radarFrameTimestamps.push(timestamp);
    });

    currentRadarFrameIndex = radarFrameLayers.length - 1;
}

/**
 * Discards the current radar frames and rebuilds them with fresh
 * timestamps, so the "latest" frame stays current as real time passes.
 * Only jumps the visible frame to the new latest if the animation loop
 * isn't actively playing (so manual playback isn't interrupted).
 */
function refreshRadarFrames() {
    const wasPlaying = animationId !== null;
    radarFrameLayers.forEach(layer => map.removeLayer(layer));
    radarFrameLayers = [];
    radarFrameTimestamps = [];
    setupRadarAnimation();
    if (wasPlaying) {
        playWeatherRadar();
    }
    else {
        showLatestRadarFrame();
    }
}

/**
 * Show the newest radar frame without starting the animation loop - the
 * default, ambient-display state.
 */
function showLatestRadarFrame() {
    stopWeatherRadar();
    radarFrameLayers.forEach(layer => layer.setVisible(false));
    currentRadarFrameIndex = radarFrameLayers.length - 1;
    radarFrameLayers[currentRadarFrameIndex].setVisible(true);
    updateInfo();
}

/**
 * For displaying the animation time clock
 */
function updateInfo() {
    const timestamp = radarFrameTimestamps[currentRadarFrameIndex];
    if (!timestamp) return;
    const el = document.getElementById('info');
    el.innerHTML = getLocalTime(timestamp.toString());
}

/**
 * Advance to the next radar frame, wrapping back to the oldest after the
 * newest. All frames are pre-loaded layers, so this is just a visibility
 * swap - no network request on a normal tick.
 */
function advanceRadarFrame() {
    if (radarFrameLayers.length === 0) return;
    radarFrameLayers[currentRadarFrameIndex].setVisible(false);
    currentRadarFrameIndex = (currentRadarFrameIndex + 1) % radarFrameLayers.length;
    radarFrameLayers[currentRadarFrameIndex].setVisible(true);
    updateInfo();
}

/**
 * Stop the weather radar animation
 */
const stopWeatherRadar = function () {
    if (animationId !== null) {
      window.clearInterval(animationId);
      animationId = null;
    }
};

// Update METARs and airport indicators every 5 minutes
setInterval(() => {
    if (wsServerOpen && wsServer) {
        console.log("Requesting latest METARs...");
        wsServer.send(JSON.stringify({
            type: MessageTypes.metars.type,
            payload: "{}"
        }));
    }
}, 5 * 60 * 1000); // every 5 minutes

setInterval(() => {
    if (settings && settings.showTraffic === false) {
        trafficMap.clear();
        processTraffic();
        return;
    }

    const bounds = map.getView().calculateExtent(map.getSize());
    const [minX, minY, maxX, maxY] = ol.proj.transformExtent(bounds, 'EPSG:3857', 'EPSG:4326');

    const url = `${URL_SERVER}/opensky/states?lamin=${minY}&lomin=${minX}&lamax=${maxY}&lomax=${maxX}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (!data || !data.states) return;
            const unknownIcao24s = new Set();
            data.states.forEach(state => {
                const [
                    icao24, callsign, originCountry, timePosition, lastContact,
                    longitude, latitude, baroAltitude, onGround, velocity,
                    heading, verticalRate, sensors, geoAltitude, squawk,
                    spi, positionSource
                ] = state;

                if (latitude != null && longitude != null) {
                    const trafficData = {
                        Icao_addr: icao24,
                        Lat: latitude,
                        Lng: longitude,
                        Speed: velocity,
                        Track: heading,
                        AgeLastAlt: 0
                    };
                    addTrafficItem(trafficData);
                    if (icao24 && !aircraftInfoCache.has(icao24.toLowerCase())) {
                        unknownIcao24s.add(icao24.toLowerCase());
                    }
                }
            });

            if (unknownIcao24s.size > 0) {
                fetchAircraftInfo([...unknownIcao24s]);
            }
        })
        .catch(err => console.error("OpenSky fetch error:", err));
}, 15000);

/**
 * Batch-look-up aircraft registration/manufacturer/model/operator/category
 * for whichever icao24s haven't been looked up yet, then re-render traffic
 * so icons/popups pick up the newly-cached info.
 */
function fetchAircraftInfo(icao24List) {
    fetch(`${URL_SERVER}/aircraft/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icao24s: icao24List })
    })
        .then(res => res.json())
        .then(data => {
            const found = data || {};
            icao24List.forEach(icao24 => {
                aircraftInfoCache.set(icao24, found[icao24] || null);
            });
            processTraffic();
        })
        .catch(err => console.error("Aircraft info fetch error:", err));
}

/**
 * Pick a traffic icon shape by ICAO aircraft class code (e.g. "H1T" =
 * single-turbine helicopter, "L2J" = multi-engine land jet, "L1T" =
 * single-engine turboprop) when a database match exists, falling back to
 * a generic icon otherwise. Shape alone carries aircraft type - color is
 * reserved for calling out military traffic (see isMilitaryAircraft),
 * not for civilian categorization. The 3rd character (P/T/J/E) is engine
 * type per OpenSky's icaoAircraftClass format.
 *
 * Icons are ADS-B Radar's free ICAO-emitter-category SVG set
 * (https://adsb-radar.com/help/icons.html, free for commercial use with
 * attribution - see the map's attribution control) rather than hand-drawn
 * shapes, so real aircraft silhouettes are recognizable at a glance.
 * Each source file has a different native size (200px for the ADS-B
 * Radar exports, ~512-683px for the standalone Cessna/regional-jet/
 * turboprop ones), hence the paired scale value - a single fixed OL Icon
 * scale would otherwise render some categories 2-3x larger than others.
 */
const TRAFFIC_ICON_TARGET_PX = 42;
const TRAFFIC_ICON_BY_CATEGORY = {
    unknown: { file: "traffic-unknown.svg", nativePx: 200 },
    helicopter: { file: "traffic-helicopter.svg", nativePx: 200 },
    jet: { file: "traffic-jet.svg", nativePx: 512 },
    turbopropMulti: { file: "traffic-turboprop-multi.svg", nativePx: 512 },
    turbopropSingle: { file: "traffic-turboprop-single.svg", nativePx: 200 },
    pistonMulti: { file: "traffic-multi-prop.svg", nativePx: 200 },
    pistonSingle: { file: "traffic-ga-single.svg", nativePx: 682.667 }
};

function trafficIconInfo(icon) {
    return { src: `${URL_SERVER}/img/${icon.file}`, scale: TRAFFIC_ICON_TARGET_PX / icon.nativePx };
}

/**
 * @returns {{src: string, scale: number}}
 */
function getTrafficIcon(icao24) {
    const category = aircraftInfoCache.get((icao24 || "").toLowerCase())?.category;
    if (!category) return trafficIconInfo(TRAFFIC_ICON_BY_CATEGORY.unknown);

    const code = category.toUpperCase();
    if (code.startsWith("H")) return trafficIconInfo(TRAFFIC_ICON_BY_CATEGORY.helicopter);
    if (code.endsWith("J")) return trafficIconInfo(TRAFFIC_ICON_BY_CATEGORY.jet);

    const isMultiEngine = /^[A-Z][2-9C]/.test(code);
    const isTurboprop = code.endsWith("T");

    if (isMultiEngine) {
        return trafficIconInfo(isTurboprop ? TRAFFIC_ICON_BY_CATEGORY.turbopropMulti : TRAFFIC_ICON_BY_CATEGORY.pistonMulti);
    }
    return trafficIconInfo(isTurboprop ? TRAFFIC_ICON_BY_CATEGORY.turbopropSingle : TRAFFIC_ICON_BY_CATEGORY.pistonSingle);
}

// OpenSky's aircraft metadata has no dedicated "is military" flag - this
// is a best-effort heuristic against the free-text operator field, which
// for US military aircraft is usually a recognizable agency/branch name
// (e.g. "UNITED STATES AIR FORCE", "US ARMY"). Civilian operators won't
// match any of these, so false negatives (missed military traffic) are
// far more likely than false positives.
const MILITARY_OPERATOR_KEYWORDS = [
    "AIR FORCE", "ARMY", "NAVY", "MARINE CORPS", "COAST GUARD",
    "NATIONAL GUARD", "DEPARTMENT OF DEFENSE", "USAF", "USN", "USMC", "USCG"
];

function isMilitaryAircraft(icao24) {
    const operator = aircraftInfoCache.get((icao24 || "").toLowerCase())?.operator;
    if (!operator) return false;
    const upper = operator.toUpperCase();
    return MILITARY_OPERATOR_KEYWORDS.some((keyword) => upper.includes(keyword));
}

/**
 * Start the weather radar animation
 */
const playWeatherRadar = function () {
    stopWeatherRadar();
    animationId = window.setInterval(advanceRadarFrame, 1000 / frameRate);
};

/**
 * Animation start button element and event listener
 */
const playButton = document.getElementById('play');
playButton.onclick = () => {
    playWeatherRadar();
};

/**
 * Animation stop button element and event listener
 */
const stopButton = document.getElementById('pause');
stopButton.addEventListener('click', stopWeatherRadar, false);
            
updateInfo();

/**
 * Convert statute miles to desired unit 
 * @param {*} miles: statute miles
 * @returns statute miles, kilometers or nautical miles   
 */
 function getDistanceUnits(miles) {
    let num = parseFloat(miles);
    let label = "mi";
    switch (distanceunit) {
        case DistanceUnits.kilometers: 
            num = miles * 1.609344;
            label = "km"
            break;
        case DistanceUnits.nauticalmiles:
            num = miles * 0.8689762419;
            label = "nm";
            break;
    }
    return `${num.toFixed(1)} ${label}`;
}

/**
 * 
 * @param {*} temp: Temperature in Centigrade 
 * @returns Farenheit temperature fixed to 2 decimal places
 */
const convertCtoF = ((temp) => {
    if (temp == undefined) return "";
    let num = (temp * 9/5 + 32);
    if (num === NaN || num === undefined) return "";
    else return `${num.toFixed(1)} F°`;
});

/**
 * Set ownship orientation from Stratux situation, updates airplane image current position
 */
 function setOwnshipOrientation(jsondata) {
    /*---------------------------------------------------------------
     * Situation json data field example
     *---------------------------------------------------------------
      { "GPSLastFixSinceMidnightUTC": 61233.1,GPSLatitude": 30.714376,"GPSLongitude": -98.254944,"GPSFixQuality": 1,"GPSHeightAboveEllipsoid": 1187.6641,
        "GPSGeoidSep": -78.41207,"GPSSatellites": 9,"GPSSatellitesTracked": 22,"GPSSatellitesSeen": 14,"GPSHorizontalAccuracy": 4.8500004,
        "GPSNACp": 10,"GPSAltitudeMSL": 1266.0762,"GPSVerticalAccuracy": 6.85,"GPSVerticalSpeed": 0,"GPSLastFixLocalTime": "0001-01-03T18:43:51.48Z",
        "GPSTrueCourse": 45.51,"GPSTurnRate": 0,"GPSGroundSpeed": 1.1610000133514404,"GPSLastGroundTrackTime": "0001-01-03T18:43:51.48Z",
        "GPSTime": "2022-07-14T17:00:33.18Z","GPSLastGPSTimeStratuxTime": "0001-01-03T18:43:51.48Z","GPSLastValidNMEAMessageTime": "0001-01-03T18:43:51.48Z",
        "GPSLastValidNMEAMessage": "$GNGGA,170033.10,3042.86261,N,09815.29674,W,1,09,0.97,385.9,M,-23.9,M,,*77","GPSPositionSampleRate": 9.998427260812582,
        "BaroTemperature": 41.89,"BaroPressureAltitude": 1085.1527,"BaroVerticalSpeed": -3.136783,"BaroLastMeasurementTime": "0001-01-03T18:43:51.53Z",
        "BaroSourceType": 1,"AHRSPitch": -0.0025035837716802546,"AHRSRoll": 0.049514056369771665,"AHRSGyroHeading": 3276.7,"AHRSMagHeading": 3276.7,
        "AHRSSlipSkid": -0.03840070310305229,"AHRSTurnRate": 3276.7,"AHRSGLoad": 0.9996413993502861,"AHRSGLoadMin": 0.9930797723335983,
        "AHRSGLoadMax": 1.0025976589458154,"AHRSLastAttitudeTime": "0001-01-03T18:43:51.53Z","AHRSStatus": 7
      }
    */
    viewposition = ol.proj.fromLonLat([jsondata.GPSLongitude, jsondata.GPSLatitude]);
    if (jsondata.GPSLongitude !== 0 && jsondata.GPSLatitude !== 0) {
        myairplane.setOffset(offset);
        myairplane.setPosition(viewposition);
        lng = jsondata.GPSLongitude;
        lat = jsondata.GPSLatitude;
        alt = jsondata.GPSAltitudeMSL;
        deg = parseInt(jsondata.AHRSMagHeading / 10);
        airplaneElement.style.transform = "rotate(" + deg + "deg)";
    }
}

/**
 * Save the position history in positionhistory.db
 */
function savePositionHistory() {
    if (last_longitude !== lng || last_latitude !== lat) {
        if (lng + lat + deg + alt > 0) {
            let postage = { longitude: lng, 
                latitude: lat, 
                heading: deg,
                altitude: Math.round(alt) };

            var xhr = new XMLHttpRequest();
            xhr.open("POST", URL_PUT_HISTORY);
            xhr.setRequestHeader("Content-Type", "application/json");
            try {    
                xhr.send(JSON.stringify(postage));
            }
            finally {}
        }
    }
}

/**
 * Utility function to replace all instances of a  
 * specified string with another specified string
 * @param {*} string: string to search 
 * @param {*} search: string to search FOR 
 * @param {*} replace: string to replace any found search 
 * @returns sring: the new string with replacements
 */
function replaceAll(string, search, replace) {
    return string.split(search).join(replace);
}

/**
 * This just makes a zulu date look nicer...
 * @param {*} zuludate 
 * @returns string: cleaned zulu date
 */
function formatZuluDate(zuludate) {
    let workstring = zuludate.split("T");
    let zstring = workstring[1].slice(0, -1);
    return  `${workstring[0]} ${zstring} Z`;
}

/**
 * Get the local machine dae/time from the supplied ZULU date
 * @param {*} zuludate: the ZULU date to be translated 
 * @returns string: the translated date in standard or daylight time
 */
 function getLocalTime(zuludate) {
    const date = new Date(zuludate);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: getConfiguredTimeZone(),
        month: 'numeric', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZoneName: 'short'
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${get('month')}-${get('day')}-${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} (${get('timeZoneName')})`;
}

/**
 * Utility function to trim and round Metar or TAF  
 * altimeter value to a standard fixed(2) number
 * @param {*} altimeter 
 * @returns 
 */
function getAltimeterSetting(altimeter) {
    let dbl = parseFloat(altimeter);
    return dbl.toFixed(2).toString();
}

/**
 * Get the formatted name of an airport
 * @param {string} ident, the airport identifier 
 * @returns string, formatted name of the airport
 */
 function getFormattedAirportName(ident) {
    let retvalue = airportNameKeymap.get(ident);
    if (retvalue === undefined || 
        retvalue === "undefined" ||
        retvalue === "") {
        retvalue = "";
    } 
    else {
        retvalue = retvalue.replace("/", "\n");
        retvalue = retvalue.replace(",", "\n");
    }
    return retvalue;
}

/**
 * Get the description for a TAF fieldname abbreviation
 * @param {string} fieldname 
 * @returns string, readable description of fieldname 
 */
 function getFieldDescription(fieldname) {
    let retvalue = fieldname;
    if (!Number.isInteger(fieldname)) {
        retvalue = tafFieldKeymap.get(fieldname);
        if (retvalue === undefined) {
            retvalue = fieldname;
        }
    }
    return retvalue;
}

/**
 * Load normalized TAF field names
 */
function loadTafFieldKeymap() {
    tafFieldKeymap.set("temp_c", "Temperature °C");
    tafFieldKeymap.set("icing_type", "Icing type");
    tafFieldKeymap.set("pirep_type", "Pirep type");
    tafFieldKeymap.set("altitude_ft_msl", "Altitude in feet MSL");
    tafFieldKeymap.set("receipt_time", "Receipt time")
    tafFieldKeymap.set("observation_time", "Observation time")
    tafFieldKeymap.set("latitude", "Latitude")
    tafFieldKeymap.set("longitude", "Longitude")
    tafFieldKeymap.set("cloud_type", "Cloud type");
    tafFieldKeymap.set("fcst_time_from", "Time from");
    tafFieldKeymap.set("fcst_time_to", "Time to");
    tafFieldKeymap.set("change_indicator", "Change indicator");
    tafFieldKeymap.set("time_becoming", "Time becoming");
    tafFieldKeymap.set("probability", "Probability");
    tafFieldKeymap.set("wind_dir_degrees", "Wind Direction");
    tafFieldKeymap.set("wind_speed_kt", "Wind Speed knots");
    tafFieldKeymap.set("wind_gust_kt", "Wind Gust knots");
    tafFieldKeymap.set("wind_shear_hgt_ft_agl", "Shear height feet AGL");
    tafFieldKeymap.set("wind_shear_dir_degrees", "Shear direction");
    tafFieldKeymap.set("wind_shear_speed_kt", "Shear speed knots");
    tafFieldKeymap.set("altim_in_hg", "Altimeter (Hg)");
    tafFieldKeymap.set("vert_vis_ft", "Vertical visibility in feet");
    tafFieldKeymap.set("visibility_statute_mi", "Horizontal visibility in statute miles");
    tafFieldKeymap.set("wx_string", "Weather");
    tafFieldKeymap.set("sky_condition", "Sky condition");
    tafFieldKeymap.set("icing_condition", "Icing condition");
    tafFieldKeymap.set("turbulence_condition", "Turbulence condition");
    tafFieldKeymap.set("sky_cover", "Sky cover");
    tafFieldKeymap.set("cloud_base_ft_agl", "Cloud base feet AGL");
    tafFieldKeymap.set("cloud_base_ft_msl", "Cloud base feet MSL");
    tafFieldKeymap.set("cloud_base", "Cloud base");
    // icing fieldnames
    tafFieldKeymap.set("icing_intensity", "Intensity");
    tafFieldKeymap.set("icing_min_alt_ft_agl", "Min altitude feet AGL");
    tafFieldKeymap.set("icing_max_alt_ft_agl", "Max altitude feet AGL");
    tafFieldKeymap.set("icing_min_alt_ft_msl", "Min altitude feet MSL");
    tafFieldKeymap.set("icing_max_alt_ft_agl", "Max altitude feet MSL");
    tafFieldKeymap.set("icing_type", "Type");
    tafFieldKeymap.set("icing_top_ft_msl", "Top in feet MSL");
    tafFieldKeymap.set("icing_base_ft_msl", "Base in feet MSL");
    // turbulence fieldnames
    tafFieldKeymap.set("turbulence_intensity", "Intensity");
    tafFieldKeymap.set("turbulence_min_alt_ft_agl", "Min altitude feet AGL");
    tafFieldKeymap.set("turbulence_max_alt_ft_agl", "Max altitude feet AGL");
    tafFieldKeymap.set("turbulence_freq", "Frequency");
    tafFieldKeymap.set("turbulence_type", "Type");
    tafFieldKeymap.set("turbulence_top_ft_msl", "Top in feet MSL");
    tafFieldKeymap.set("turbulence_base_ft_msl", "Base in feet MSL");
}

/**
 * Get the description for a TAF/Metar fieldname abbreviation
 * @param {string} fieldname 
 * @returns string, readable description of fieldname 
 */
 function getMetarFieldDescription(fieldname) {
    let retvalue = metarFieldKeymap.get(fieldname);
    if (retvalue === undefined || retvalue === "") {
        retvalue = replaceAll(fieldname, "_", " ");
    }
    return retvalue;
}
/**
 * Load normalized metar field names
 */
 function loadMetarFieldKeymap() {
    metarFieldKeymap.set("change_indicator", "Change indicator");
    metarFieldKeymap.set("raw_text", "raw text");
    metarFieldKeymap.set("station_id", "station id"); 
    metarFieldKeymap.set("observation_time", "Observation Time");
    metarFieldKeymap.set("latitude", "latitude");
    metarFieldKeymap.set("longitude", "longitude");
    metarFieldKeymap.set("temp_c", "Temp °C");
    metarFieldKeymap.set("dewpoint_c", "Dewpoint °C");
    metarFieldKeymap.set("wind_dir_degrees", "Wind direction"); 
    metarFieldKeymap.set("wind_speed_kt", "Wind speed knots");
    metarFieldKeymap.set("wind_gust_kt", "Wind gust knots");
    metarFieldKeymap.set("visibility_statute_mi", "Horizontal visibility in statute miles");
    metarFieldKeymap.set("altim_in_hg", "Altimeter in Hg");
    metarFieldKeymap.set("sea_level_pressure_mb", "Sea-level pressure in MB");
    metarFieldKeymap.set("quality_control_flags", "Quality control flags");
    metarFieldKeymap.set("wx_string", "Weather");
    metarFieldKeymap.set("sky_condition", "Sky cover");
    metarFieldKeymap.set("sky_cover", "Sky cover");
    metarFieldKeymap.set("cloud_base_ft_agl", "Cloud base feet AGL");
    metarFieldKeymap.set("cloud_base", "Cloud base");
    metarFieldKeymap.set("flight_category", "Flight category");
    metarFieldKeymap.set("three_hr_pressure_tendency_mb", "Pressure change past 3 hours in MB");
    metarFieldKeymap.set("maxT_c", "Max air temp °C, past 6 hours");
    metarFieldKeymap.set("minT_c", "Min air temp °C, past 6 hours");
    metarFieldKeymap.set("maxT24hr_c", "Max air temp °C, past 24 hours");
    metarFieldKeymap.set("minT24hr_c", "Min air temp °C, past 24 hours");
    metarFieldKeymap.set("precip_in", "Liquid precipitation since last METAR");
    metarFieldKeymap.set("pcp3hr_in", "Liquid precipitation past 3 hours");
    metarFieldKeymap.set("pcp6hr_in", "Liquid precipitation past 6 hours");
    metarFieldKeymap.set("pcp24hr_in", "Liquid precipitation past 24 hours");
    metarFieldKeymap.set("snow_in", "Snow depth in inches");
    metarFieldKeymap.set("vert_vis_ft", "Vertical visibility in feet");
    metarFieldKeymap.set("metar_type", "Metar type");
    metarFieldKeymap.set("elevation_m", "Station elevation in meters");
}

/**
 * Get the description for a TAF/Metar weather acronym
 * @param {string} acronym 
 * @returns string, readable description of acronym 
 */
function getWeatherAcronymDescription(acronym) {
    let retvalue = weatherAcronymKeymap.get(acronym);
    if (retvalue === undefined) retvalue = acronym;
    return retvalue;
}
/**
 * Load the wxkeymap Map object with weather code descriptions
 */
function loadWeatherAcronymKeymap() {
    weatherAcronymKeymap.set("FM", "From");
    weatherAcronymKeymap.set("TEMPO", "Temporary");
    weatherAcronymKeymap.set("BECMG", "Becoming");
    weatherAcronymKeymap.set("PROB", "Probability");
    weatherAcronymKeymap.set("FU", "Smoke");
    weatherAcronymKeymap.set("VA", "Volcanic Ash");
    weatherAcronymKeymap.set("HZ", "Haze");
    weatherAcronymKeymap.set("DU", "Dust");
    weatherAcronymKeymap.set("SA", "Sand");
    weatherAcronymKeymap.set("BLDU", "Blowing dust");
    weatherAcronymKeymap.set("BLSA", "Blowing sand");
    weatherAcronymKeymap.set("PO", "Dust devil");
    weatherAcronymKeymap.set("VCSS", "Vicinity sand storm");
    weatherAcronymKeymap.set("BR", "Mist or light fog");
    weatherAcronymKeymap.set("MIFG", "More or less continuous shallow fog");
    weatherAcronymKeymap.set("VCTS", "Vicinity thunderstorm");
    weatherAcronymKeymap.set("VIRGA", "Virga or precipitation not hitting ground");
    weatherAcronymKeymap.set("VCSH", "Vicinity showers");
    weatherAcronymKeymap.set("TS", "Thunderstorm with or without precipitation");
    weatherAcronymKeymap.set("SQ", "Squalls");
    weatherAcronymKeymap.set("FC", "Funnel cloud or tornado");
    weatherAcronymKeymap.set("SS", "Sand or dust storm");
    weatherAcronymKeymap.set("+SS", "Strong sand or dust storm");
    weatherAcronymKeymap.set("BLSN", "Blowing snow");
    weatherAcronymKeymap.set("DRSN", "Drifting snow");
    weatherAcronymKeymap.set("VCFG", "Vicinity fog");
    weatherAcronymKeymap.set("BCFG", "Patchy fog");
    weatherAcronymKeymap.set("PRFG", "Fog, sky discernable");
    weatherAcronymKeymap.set("FG", "Fog, sky undiscernable");
    weatherAcronymKeymap.set("FZFG", "Freezing fog");
    weatherAcronymKeymap.set("-DZ", "Light drizzle");
    weatherAcronymKeymap.set("DZ", "Moderate drizzle");
    weatherAcronymKeymap.set("+DZ", "Heavy drizzle");
    weatherAcronymKeymap.set("-FZDZ", "Light freezing drizzle");
    weatherAcronymKeymap.set("FZDZ", "Moderate freezing drizzle");
    weatherAcronymKeymap.set("+FZDZ", "Heavy freezing drizzle");
    weatherAcronymKeymap.set("-DZRA", "Light drizzle and rain");
    weatherAcronymKeymap.set("DZRA", "Moderate to heavy drizzle and rain");
    weatherAcronymKeymap.set("-RA", "Light rain");
    weatherAcronymKeymap.set("RA", "Moderate rain");
    weatherAcronymKeymap.set("+RA", "Heavy rain");
    weatherAcronymKeymap.set("-FZRA", "Light freezing rain");
    weatherAcronymKeymap.set("FZRA", "Moderate freezing rain");
    weatherAcronymKeymap.set("+FZRA", "Heavy freezing rain");
    weatherAcronymKeymap.set("-RASN", "Light rain and snow");
    weatherAcronymKeymap.set("RASN", "Moderate rain and snow");
    weatherAcronymKeymap.set("+RASN", "Heavy rain and snow");
    weatherAcronymKeymap.set("-SN", "Light snow");
    weatherAcronymKeymap.set("SN", "Moderate snow");
    weatherAcronymKeymap.set("+SN", "Heavy snow");
    weatherAcronymKeymap.set("SG", "Snow grains");
    weatherAcronymKeymap.set("IC", "Ice crystals");
    weatherAcronymKeymap.set("PE PL", "Ice pellets");
    weatherAcronymKeymap.set("PE", "Ice pellets");
    weatherAcronymKeymap.set("PL", "Ice pellets");
    weatherAcronymKeymap.set("-SHRA", "Light rain showers");
    weatherAcronymKeymap.set("SHRA", "Moderate rain showers");
    weatherAcronymKeymap.set("+SHRA", "Heavy rain showers");
    weatherAcronymKeymap.set("-SHRASN", "Light rain and snow showers");
    weatherAcronymKeymap.set("SHRASN", "Moderate rain and snow showers");
    weatherAcronymKeymap.set("+SHRASN", "Heavy rain and snow showers");
    weatherAcronymKeymap.set("-SHSN", "Light snow showers");
    weatherAcronymKeymap.set("SHSN", "Moderate snow showers");
    weatherAcronymKeymap.set("+SHSN", "Heavy snow showers");
    weatherAcronymKeymap.set("-GR", "Light showers with hail, not with thunder");
    weatherAcronymKeymap.set("GR", "Moderate to heavy showers with hail, not with thunder");
    weatherAcronymKeymap.set("TSRA", "Light to moderate thunderstorm with rain");
    weatherAcronymKeymap.set("TSGR", "Light to moderate thunderstorm with hail");
    weatherAcronymKeymap.set("+TSRA", "Thunderstorm with heavy rain");
    weatherAcronymKeymap.set("UP", "Unknown precipitation");
    weatherAcronymKeymap.set("NSW", "No significant weather");
}

/**
 * Get the description for a sky condition acronym
 * @param {string} acronym 
 * @returns acronym if found, otherwise just returns key
 */
function getSkyConditionDescription(acronym) {
    let retvalue = skyConditionKeymap.get(acronym);
    if (retvalue === undefined) {
        retvalue = acronym;
    }
    return retvalue;
}
/**
 * Map containing standard TAF/Metar acronyms
 */
 function loadSkyConditionmKeymap() {
    skyConditionKeymap.set("BKN", "Broken");
    skyConditionKeymap.set("FM", "From");
    skyConditionKeymap.set("TEMPO", "Temporary");
    skyConditionKeymap.set("BECMG", "Becoming");
    skyConditionKeymap.set("PROB", "Probability");
    skyConditionKeymap.set("CB", "Cumulo-Nimbus");
    skyConditionKeymap.set("IMC", "Instrument meteorological conditions"),
    skyConditionKeymap.set("IMPR", "Improving");
    skyConditionKeymap.set("INC", "In Clouds");
    skyConditionKeymap.set("INS", "Inches");
    skyConditionKeymap.set("INTER", "Intermittent");
    skyConditionKeymap.set("INTSF", "Intensify(ing)");
    skyConditionKeymap.set("INTST", "Intensity");
    skyConditionKeymap.set("JTST", "Jet stream");
    skyConditionKeymap.set("KM", "Kilometers");
    skyConditionKeymap.set("KMH", "Kilometers per hour");
    skyConditionKeymap.set("KT", "Knots");
    skyConditionKeymap.set("L", "Low pressure area");
    skyConditionKeymap.set("LAN", "Land");
    skyConditionKeymap.set("LDA", "Landing distance available");
    skyConditionKeymap.set("LDG", "Landing");
    skyConditionKeymap.set("LGT", "Light");
    skyConditionKeymap.set("LOC", "Locally");
    skyConditionKeymap.set("LSQ", "Line squall");
    skyConditionKeymap.set("LSR", "Loose snow on runway");
    skyConditionKeymap.set("LTG", "Lightning");
    skyConditionKeymap.set("LYR", "Layer");
    skyConditionKeymap.set("M", "Meters");
    skyConditionKeymap.set("M", "Minus or below zero");
    skyConditionKeymap.set("M", "Less than lowest reportable sensor value");
    skyConditionKeymap.set("MAX", "Maximum");
    skyConditionKeymap.set("MB", "Millibars");
    skyConditionKeymap.set("MET", "Meteorological");
    skyConditionKeymap.set("MI", "Shallow");
    skyConditionKeymap.set("MIN", "Minutes");
    skyConditionKeymap.set("MNM", "Minimum");
    skyConditionKeymap.set("MOD", "Moderate");
    skyConditionKeymap.set("MOV", "Move, moving");
    skyConditionKeymap.set("MPS", "Meters per second");
    skyConditionKeymap.set("MS", "Minus");
    skyConditionKeymap.set("MSL", "Mean sea level");
    skyConditionKeymap.set("MTW", "Mountain waves");
    skyConditionKeymap.set("MU", "Runway friction coefficent");
    skyConditionKeymap.set("NC", "No change");
    skyConditionKeymap.set("NIL", "None, nothing");
    skyConditionKeymap.set("NM", "Nautical mile(s)");
    skyConditionKeymap.set("NMRS", "Numerous");
    skyConditionKeymap.set("NO", "Not available");
    skyConditionKeymap.set("NOSIG", "No significant change");
    skyConditionKeymap.set("NS", "Nimbostratus");
    skyConditionKeymap.set("NSC", "No significant clouds");
    skyConditionKeymap.set("NSW", "No Significant Weather");
    skyConditionKeymap.set("OBS", "Observation");
    skyConditionKeymap.set("OBSC", "Obscuring");
    skyConditionKeymap.set("OCNL", "Occasional");
    skyConditionKeymap.set("OKTA", "Eight of sky cover");
    skyConditionKeymap.set("OTP", "On top");
    skyConditionKeymap.set("OTS", "Out of service");
    skyConditionKeymap.set("OVC", "Overcast");
    skyConditionKeymap.set("P", "Greater than highest reportable sensor value");
    skyConditionKeymap.set("P6SM", "Visibility greater than 6 SM");
    skyConditionKeymap.set("PAEW", "Personnel and equipment working");
    skyConditionKeymap.set("PE", "Ice Pellets");
    skyConditionKeymap.set("PJE", "Parachute Jumping Exercise");
    skyConditionKeymap.set("PK WND", "Peak wind");
    skyConditionKeymap.set("PLW", "Plow/plowed");
    skyConditionKeymap.set("PNO", "Precipitation amount not available");
    skyConditionKeymap.set("PO", "Dust/Sand Whirls");
    skyConditionKeymap.set("PPR", "Prior permission required");
    skyConditionKeymap.set("PR", "Partial");
    skyConditionKeymap.set("PRESFR", "Pressure falling rapidly");
    skyConditionKeymap.set("PRESRR", "Pressure rising rapidly");
    skyConditionKeymap.set("PROB", "Probability");
    skyConditionKeymap.set("PROB30", "Probability 30 percent");
    skyConditionKeymap.set("PS", "Plus");
    skyConditionKeymap.set("PSR", "Packed snow on runway");
    skyConditionKeymap.set("PWINO", "Precipitation id sensor not available");
    skyConditionKeymap.set("PY", "Spray");
    skyConditionKeymap.set("R", "Runway (in RVR measurement)");
    skyConditionKeymap.set("RA", "Rain");
    skyConditionKeymap.set("RAB", "Rain Began");
    skyConditionKeymap.set("RADAT", "Radiosonde observation addl data");
    skyConditionKeymap.set("RAE", "Rain Ended");
    skyConditionKeymap.set("RAPID", "Rapid(ly)");
    skyConditionKeymap.set("RASN", "Rain and snow");
    skyConditionKeymap.set("RCAG", "Remote Center Air/Ground Comm Facility");
    skyConditionKeymap.set("RMK", "Remark");
    skyConditionKeymap.set("RVR", "Runway visual range");
    skyConditionKeymap.set("RVRNO", "RVR not available");
    skyConditionKeymap.set("RY/RWY", "Runway");
    skyConditionKeymap.set("SA", "Sand");
    skyConditionKeymap.set("SAND", "Sandstorm");
    skyConditionKeymap.set("SC", "Stratocumulus");
    skyConditionKeymap.set("SCSL", "Stratocumulus standing lenticular cloud");
    skyConditionKeymap.set("SCT", "Scattered cloud coverage");
    skyConditionKeymap.set("SEC", "Seconds");
    skyConditionKeymap.set("SEV", "Severe");
    skyConditionKeymap.set("SFC", "Surface");
    skyConditionKeymap.set("SG", "Snow Grains");
    skyConditionKeymap.set("SH", "Shower");
    skyConditionKeymap.set("SHWR", "Shower");
    skyConditionKeymap.set("SIGMET", "Information from MWO");
    skyConditionKeymap.set("SIR", "Snow and ice on runway");
    skyConditionKeymap.set("SKC", "Sky Clear");
    skyConditionKeymap.set("SLP", "Sea Level Pressure in MB");
    skyConditionKeymap.set("SLPNO", "Sea-level pressure not available");
    skyConditionKeymap.set("SLR", "Slush on runway");
    skyConditionKeymap.set("SLW", "Slow");
    skyConditionKeymap.set("SM", "Statute Miles");
    skyConditionKeymap.set("SMK", "Smoke");
    skyConditionKeymap.set("SMO", "Supplementary meteorological office");
    skyConditionKeymap.set("SN", "Snow");
    skyConditionKeymap.set("SPECI", "Special Report");
    skyConditionKeymap.set("SQ", "Squall");
    skyConditionKeymap.set("SS", "Sandstorm");
    skyConditionKeymap.set("SSR", "Secondary Surveillance Radar");
    skyConditionKeymap.set("T", "Temperature");
    skyConditionKeymap.set("TAF", "Terminal aerodrome forecast in code");
    skyConditionKeymap.set("TAPLEY", "Tapley runway friction coefficient");
    skyConditionKeymap.set("TAR", "Terminal Area Surveillance Radar");
    skyConditionKeymap.set("TAIL", "Tail wind");
    skyConditionKeymap.set("TCH", "Threshold Crossing Height");
    skyConditionKeymap.set("TCU", "Towering Cumulus");
    skyConditionKeymap.set("TDO", "Tornado");
    skyConditionKeymap.set("TDWR", "Terminal Doppler Weather Radar");
    skyConditionKeymap.set("TEMPO", "TEMPO");
    skyConditionKeymap.set("TEND", "Trend or tending to");
    skyConditionKeymap.set("TKOF", "Takeoff");
    skyConditionKeymap.set("TMPA", "Traffic Management Program Alert");
    skyConditionKeymap.set("TODA", "Takeoff distance available");
    skyConditionKeymap.set("TOP", "Cloud top");
    skyConditionKeymap.set("TORA", "Takeoff run available");
    skyConditionKeymap.set("TS", "Thunderstorm");
    skyConditionKeymap.set("TSNO", "Thunderstorm/lightning detector not available");
    skyConditionKeymap.set("TURB", "Turbulence");
    skyConditionKeymap.set("TWY", "Taxiway");
    skyConditionKeymap.set("UFN", "Until further notice");
    skyConditionKeymap.set("UNL", "Unlimited");
    skyConditionKeymap.set("UP", "Unknown Precipitation");
    skyConditionKeymap.set("UTC", "Coordinated Universal Time (=GMT)");
    skyConditionKeymap.set("V", "Variable (wind direction and RVR)");
    skyConditionKeymap.set("VA", "Volcanic Ash");
    skyConditionKeymap.set("VC", "Vicinity");
    skyConditionKeymap.set("VER", "Vertical");
    skyConditionKeymap.set("VFR", "Visual flight rules");
    skyConditionKeymap.set("VGSI", "Visual Glide Slope Indicator");
    skyConditionKeymap.set("VIS", "Visibility");
    skyConditionKeymap.set("VISNO [LOC]", "Visibility Indicator at second location not available");
    skyConditionKeymap.set("VMS", "Visual meteorological conditions");
    skyConditionKeymap.set("VOLMET", "Meteorological information for aircraft in flight");
    skyConditionKeymap.set("VRB", "Variable wind direction");
    skyConditionKeymap.set("VRBL", "Variable");
    skyConditionKeymap.set("VSP", "Vertical speed");
    skyConditionKeymap.set("VV", "Vertical Visibility (indefinite ceiling)");
    skyConditionKeymap.set("WAAS", "Wide Area Augmentation System");
    skyConditionKeymap.set("WDSPR", "Widespread");
    skyConditionKeymap.set("WEF", "With effect from");
    skyConditionKeymap.set("WIE", "With immediate effect");
    skyConditionKeymap.set("WIP", "Work in progress");
    skyConditionKeymap.set("WKN", "Weaken(ing)");
    skyConditionKeymap.set("WR", "Wet runway");
    skyConditionKeymap.set("WS", "Wind shear");
    skyConditionKeymap.set("WSHFT", "Wind shift (in minutes after the hour)");
    skyConditionKeymap.set("WSP", "Weather Systems Processor");
    skyConditionKeymap.set("WSR", "Wet snow on runway");
    skyConditionKeymap.set("WST", "Convective Significant Meteorological Information");
    skyConditionKeymap.set("WTSPT", "Waterspout");
    skyConditionKeymap.set("WW", "Severe Weather Watch Bulletin");
    skyConditionKeymap.set("WX", "Weather");
}

/**
 * Decode weather codes from TAFs or METARS
 * @param {*} codevalue: this could contain multiple space-delimited codes
 * @returns string with any weather description(s)
 */
 function decodeWxDescriptions(codevalue) {
    let outstr = "";
    let vals = codevalue.split(" ");
    
    for (let i = 0; i < vals.length; i++) {
        if (i === 0) {
            outstr = weatherAcronymKeymap.get(vals[i]);
        }
        else {
            outstr += ` / ${weatherAcronymKeymap.get(vals[i])}`;
        }
    }
    return outstr;
}

/**
 * Get the description for an icing code
 * @param {string} code 
 * @returns string, readable description of code 
 */
 function getIcingCodeDescription(code) {
    let retvalue = icingCodeKeymap.get(code);
    if (retvalue === undefined) retvalue = code;
    return retvalue;
}
/**
 * Load readable descriptions for Icing codes
 */
function loadIcingCodeKeymap() {
    icingCodeKeymap.set("0", "None");
    icingCodeKeymap.set("1", "Light");
    icingCodeKeymap.set("2", "Light in clouds")
    icingCodeKeymap.set("3", "Light in precipitation")
    icingCodeKeymap.set("4", "Moderate");   
    icingCodeKeymap.set("5", "Moderate in clouds");
    icingCodeKeymap.set("6", "Moderate in precipitation");
    icingCodeKeymap.set("7", "Severe");
    icingCodeKeymap.set("8", "Severe in clouds");
    icingCodeKeymap.set("9", "Severe in precipitation");     
}

/**
 * Get the description for a turbulence code
 * @param {string} code 
 * @returns string, readable description of code 
 */
function getTurbulenceCodeDescription(code) {
let retvalue = turbulenceCodeKeymap.get(code);
if (retvalue === undefined) retvalue = code;
return retvalue;
}
/**
 * Load readable descriptions for Turbulence codes
 */
function loadTurbulenceCodeKeymap() {
turbulenceCodeKeymap.set("0", "Light");
turbulenceCodeKeymap.set("1", "Light");
turbulenceCodeKeymap.set("2", "Moderate in clean air occasionally")
turbulenceCodeKeymap.set("3", "Moderate in clean air frequent");
turbulenceCodeKeymap.set("4", "Moderate in clouds occasionally");   
turbulenceCodeKeymap.set("5", "Moderate in clouds frequently");
turbulenceCodeKeymap.set("6", "Severe in clean air occasionally");
turbulenceCodeKeymap.set("7", "Severe in clean air frequent");
turbulenceCodeKeymap.set("8", "Severe in clouds occasionally");
turbulenceCodeKeymap.set("9", "Severe in clouds frequently");
turbulenceCodeKeymap.set("X", "Extreme");
turbulenceCodeKeymap.set("x", "Extreme");
}

const CONDITIONS = {
    //Visual Flight Rules
    VFR: "green",
    //Marginal Visual Flight Rules
    MVFR: "blue",
    //Instrument Flight Rules
    IFR: "red",
    //Low Instrument flight Rules
    LIFR: "purple"
};
var size = 25;
var piD = (size / 2) * 3.14 * 2;
//clear square
var CLR_SQUARE = "<g id=\"clr\">\n        <rect width=\"" + size + "\" height=\"" + size + "\" x=\"calc(250 - " + size / 2 + ")\" y=\"calc(250 - " + size / 2 + ")\" class=\"coverage\"/>\n    </g>";
//clear circle
var CLR_CIRCLE = "<g id=\"clr\">\n        <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    </g>";
// Few clouds 25% coverage
var FEW = "<g id=\"few\">\n        <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n        <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n        stroke-dasharray=\"0 calc(75 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n        class=\"partial\"/>\n    </g>";
// Scattered clouds 50% coverage
var SCT = "<g id=\"few\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n    stroke-dasharray=\"calc(25 * " + piD + " / 100) calc(50 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n    class=\"partial\"/>\n</g>";
// Broken clouds 75% coverage
var BRK = "<g id=\"few\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" fill=\"#00000000\" class=\"coverage\"/>\n    <circle cx=\"250\" cy=\"250\" r=\"" + size / 2 + "\" fill=\"#00000000\" \n    stroke-dasharray=\"calc(49 * " + piD + " / 100) calc(26 * " + piD + " / 100) calc(25 * " + piD + " / 100)\"\n    class=\"partial\"/>\n</g>";
// Overcast
var OVC = "<g id=\"ovc\">\n    <circle cx=\"250\" cy=\"250\" r=\"" + size + "\" class=\"ovc\"/>\n</g>";
//Cloud abbreviation map
let CLOUDS = {
    NCD: { svg: CLR_CIRCLE, text: "no clouds", rank: 0 },
    SKC: { svg: CLR_CIRCLE, text: "sky clear", rank: 0 },
    CLR: { svg: CLR_CIRCLE, text: "no clouds under 12,000 ft", rank: 0 },
    NSC: { svg: CLR_CIRCLE, text: "no significant", rank: 0 },
    FEW: { svg: FEW, text: "few", rank: 1 },
    SCT: { svg: SCT, text: "scattered", rank: 2 },
    BKN: { svg: BRK, text: "broken", rank: 3 },
    OVC: { svg: OVC, text: "overcast", rank: 4 },
    VV: { svg: OVC, text: "vertical visibility", rank: 5 },
};
/**
 * Generates SVG for cloud coverage
 * @param coverage
 * @param condition
 * @returns
 */
function genCoverage(coverage, condition) {
    if (coverage != null && coverage !== "") {
        return "\n            <style>\n                .coverage{ \n                    stroke-width: 5; \n                    stroke: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n                .partial{\n                    stroke-width: 25; \n                    stroke: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n                .ovc{\n                    fill: " + (condition != null ? exports.CONDITIONS[condition] : "black") + ";\n                }\n            </style>\n            " + CLOUDS[coverage].svg;
    }
    else {
        return "";
    }
}

var RVR = /** @class */ (function () {
    function RVR(rvrString) {
        this.re = /(R\d{2})([L|R|C])?(\/)([P|M])?(\d+)(?:([V])([P|M])?(\d+))?([N|U|D])?(FT)?/g;
        var matches;
        while ((matches = this.re.exec(rvrString)) != null) {
            if (matches.index === this.re.lastIndex) {
                this.re.lastIndex++;
            }
            this.runway = matches[1];
            this.direction = matches[2];
            this.seperator = matches[3];
            this.minIndicator = matches[4];
            this.minValue = matches[5];
            this.variableIndicator = matches[6];
            this.maxIndicator = matches[7];
            this.maxValue = matches[8];
            this.trend = matches[9];
            this.unitsOfMeasure = matches[10];
        }
    }
    return RVR;
}());

/**
 * Weather Descriptor
 */
var Weather = /** @class */ (function () {
    function Weather() {
    }
    return Weather;
}());

/**
 * Deprecated - for internal use only please use getWeatherLegend(key: string)
 * @param key weather abbriviation
 * @returns
 */
function getWeatherSVG(key) {
    var weather = WEATHER[key] != null ? WEATHER[key].svg : "";
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"65\" height=\"65\" viewBox=\"0 0 500 500\" x=\"140\" y=\"220\">\n                <style>\n                    .wx_text{ \n                        color: black;\n                        font-size: 400px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .snow{ \n                        color: black;\n                        font-size: 300px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .wx_graphic {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 30\n                    }\n                    .wx_graphic_thin {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 15\n                    }\n                </style>\n                " + weather + "\n            </svg>";
}
/**
 * Returns SVG icon
 * @param key weather abbriviation
 */
function getWeatherLegend(key) {
    var weather = WEATHER[key] != null ? WEATHER[key].svg : "";
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"65\" height=\"65\" viewBox=\"0 0 500 500\">\n                <style>\n                    .wx_text{ \n                        color: black;\n                        font-size: 400px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .snow{ \n                        color: black;\n                        font-size: 300px;\n                        font-family: \"Noto Sans\";\n                        white-space: pre;\n                    }\n                    .wx_graphic {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 30\n                    }\n                    .wx_graphic_thin {\n                        stroke: black;\n                        fill: none;\n                        stroke-width: 15\n                    }\n                </style>\n                " + weather + "\n            </svg>";
}
var BRK_DWN_ARW = "<line class=\"wx_graphic\" x1=\"350\" y1=\"50\" x2=\"175\" y2=\"250\"></line>\n    <line class=\"wx_graphic\" x1=\"170\" y1=\"245\" x2=\"350\" y2=\"415\"></line>\n    <line class=\"wx_graphic\" x1=\"350\" y1=\"415\" x2=\"250\" y2=\"415\"></line>\n    <line class=\"wx_graphic\" x1=\"350\" y1=\"425\" x2=\"350\" y2=\"315\"></line>";
var RIGHT_ARROW = "<line class=\"wx_graphic\" x1=\"120\" y1=\"250\" x2=\"430\" y2=\"250\"></line>\n    <line class=\"wx_graphic\" x1=\"380\" y1=\"250\" x2=\"465\" y2=\"250\" transform=\"rotate(-45, 450, 250)\"></line>\n    <line class=\"wx_graphic\" x1=\"380\" y1=\"250\" x2=\"450\" y2=\"250\" transform=\"rotate(45, 450, 250)\"></line>";
var TRANSFORM = "transform=\"matrix(1.4,0,0,1.2,-102.2,-30.3)\"";
var DWN_TRI = "<polygon style=\"stroke: black\" points=\"150 160 350 160 250 475\"></polygon>";
/*
SVG Icons
*/
//DUST OR SAND
var sine = "<path transform=\"matrix(1.4,0,0,1.6,-84,-118)\" style=\"fill: none; stroke: black; stroke-width: 10\" d=\"M 232.3 217.2 C 231.4 184.3 201 163.6 176.6 180.1 C 165.3 187.8 158.3 201.9 158.3 217.2\"></path>\n    <path transform=\"matrix(1.4,0,0,1.6,-121,-147)\" style=\"fill: none; stroke: black; stroke-width: 10\" d=\"M 337.1 223.5 C 337.1 255.3 304.1 275.2 277.8 259.3 C 265.6 251.9 258 238.2 258 223.5\"></path>    \n";
//Smoke or volcanic ash
var FU_VA = "<g id=\"FU_VA\">\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"150\" x2=\"100\" y2=\"400\"></line>\n        <path class=\"wx_graphic\" d=\"M 100 150 C 115 75 185 75 200 150\"></path>\n        <path class=\"wx_graphic\" d=\"M 200 150 C 215 215 285 215 300 150\"></path>\n        <path class=\"wx_graphic\" d=\"M 300 150 C 315 75 380 75 400 150\"></path>\n    </g>";
//Haze
var HZ = "<g id=\"HZ\">\n        <text class=\"snow\" x=\"100\" y=\"365\">\u267E\uFE0F</text>\n    </g>";
//Dust or Sand
var DU_SA = "<g id=\"DU_SA\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n    </g>";
//Blowing dust or sand
var BLDU_BLSA = "<g id=\"BLDU_BLSA\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">$</text>\n    </g>";
//Dust Devil
var PO = "<g id=\"PO\">\n      <text class=\"wx_text\" style=\"font-size: 375px;\" x=\"50\" y=\"360\">(\u25CF)</text>\n    </g>";
//Vicinity sand storm
var VCSS = "<g id=\"VCSS\">\n        <text class=\"wx_text\" x=\"50\" y=\"360\">($)</text>\n        " + RIGHT_ARROW + "\n    </g>";
//FOG OR SPEACIAL WEATHER
//Mist or light fog
var BR = "<g id=\"BR\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"200\" x2=\"450\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"300\" x2=\"450\" y2=\"300\"></line>\n    </g>";
//More or less continuous shallow fog
var MIFG = "<g id=\"MIFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"200\" x2=\"200\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"200\" x2=\"450\" y2=\"200\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"300\" x2=\"450\" y2=\"300\"></line>\n    </g>\n    ";
//Vicinity thunderstorm
var VCTS = "<g id=\"VCTS\">" + BRK_DWN_ARW + "</g>";
//Virga or precipitation not hitting ground
var VIRGA = "<g id=\"VIGRA\">\n        <text transform=\"matrix(0, -1, 1, 0, 366, 389)\" class=\"wx_text\" style=\"font-size:300px;\" dx=\"-5 -9\" dy=\"-40 0.5\">(\u25CF</text>\n    </g>";
//Vicinity showers
var VCSH = "<g id=\"VCSS\">\n        <text class=\"wx_text\" x=\"50\" y=\"360\">( )</text>\n        <circle style=\"fill: black\" cx=\"230\" cy=\"260\" r=\"50\"></circle>\n    </g>";
//Thunderstorm with or without precipitation
var TS = "<g id=\"TS\">\n        " + BRK_DWN_ARW + "\n        <line class=\"wx_graphic\" x1=\"355\" y1=\"50\" x2=\"50\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"60\" y1=\"50\" x2=\"60\" y2=\"440\"></line>\n    </g>\n    ";
//Squalls
var SQ = "<g id=\"SQ\">\n        <line class=\"wx_graphic\" x1=\"250\" y1=\"450\" x2=\"150\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"150\" y1=\"50\" x2=\"250\" y2=\"125\"></line>\n        <line class=\"wx_graphic\" x1=\"250\" y1=\"125\" x2=\"350\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"50\" x2=\"250\" y2=\"450\"></line>\n    </g>";
//Funnel cloud or tornado
var FC = "<g id=\"FC\">\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"100\" x2=\"200\" y2=\"400\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"100\" x2=\"300\" y2=\"400\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"100\" x2=\"375\" y2=\"50\"></line>\n        <line class=\"wx_graphic\" x1=\"300\" y1=\"400\" x2=\"375\" y2=\"450\"></line>\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"400\" x2=\"125\" y2=\"450\"></line>\n        <line class=\"wx_graphic\" x1=\"200\" y1=\"100\" x2=\"125\" y2=\"50\"></line>\n    </g>\n    ";
//BLOWING WEATHER
//Sand or dust storm
var SS = "<g id=\"SS\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n        " + RIGHT_ARROW + "\n    </g>";
//Strong sand or dust storm
var PLUS_SS = "<g =\"+SS\">\n        <text class=\"wx_text\" x=\"160\" y=\"360\">S</text>\n    </g>";
//Blowing snow
var BLSN = "<g id=\"BLSN\">\n        <text x=\"0\" y=\"350\" class=\"wx_text\" transform=\"rotate(270, 250, 250)\">\u2192</text>\n        <text x=\"50\" y=\"450\" class=\"wx_text\">\u2192</text>\n    </g>";
//Drifting snow
var DRSN = "<g id=\"DRSN\">\n        <text x=\"110\" y=\"350\" class=\"wx_text\" transform=\"rotate(90, 250, 250)\">\u2192</text>\n        <text x=\"110\" y=\"400\" class=\"wx_text\">\u2192</text>\n    </g>\n    ";
//FOG//////////////////////////////////////////////
//Vicinity fog
var VCFG = "<g id=\"VCFG\">\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"150\" x2=\"400\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"250\" x2=\"400\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"100\" y1=\"350\" x2=\"400\" y2=\"350\"></line>\n        <path class=\"wx_graphic\" d=\"M 60 135 C 15 165 15 335 65 365\"></path>\n        <path class=\"wx_graphic\" d=\"M 435 135 C 485 150 500 345 435 365\"></path>\n    </g>";
//Patchy fog
var BCFG = "<g id=\"BCFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"150\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"150\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
//Fog, sky discernable
var PRFG = "<g id=\"BCFG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"150\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"350\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
//Fog, sky undiscernable
var FG = "<g id=\"FG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n    </g>";
//Freezing fog
var FZFG = "<g id=\"FG\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"450\" y2=\"150\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"350\" x2=\"450\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"150\" x2=\"250\" y2=\"350\"></line>\n        <line class=\"wx_graphic\" x1=\"450\" y1=\"150\" x2=\"250\" y2=\"350\"></line>\n    </g>";
//Drizzle
//Light drizzle
var MIN_DZ = "<g id=\"-DZ\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n    </g>";
//Moderate drizzle
var DZ = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"285\">,,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"175\">,</text>\n    </g>";
//Heavy drizzle
var PLUS_DZ = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"145\">,</text>\n        <text class=\"wx_text\" x=\"170\" y=\"320\">,</text>\n    </g>";
//Light freezing drizzle
var MIN_FZDZ = "<g id=\"-DZ\" " + TRANSFORM + ">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,</text>\n        " + sine + "\n    </g>";
//Moderate to heavy freezing drizzle
var FZDZ = "<g id=\"-DZ\" " + TRANSFORM + ">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">,,</text>\n        " + sine + "    \n    </g>";
//Light drizzle and rain
var MIN_DZRA = "<g id=\"MIN_DZRA>\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 300px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"0.743\" dy=\"-39.081\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 100px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-105.782\" dy=\"92.343\">\u25CF</text>\n    </g>";
//Moderate to heavy drizzle and rain
var DZRA = "<g id=\"MIN_DZRA>\n        <text x=\"198.442\" y=\"348.054\" style=\"white-space: pre; fill: rgb(51, 51, 51); font-family: &quot;Georgia&quot;; font-size: 300px;\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 300px; white-space: pre;\" x=\"200.662\" y=\"301.835\" dx=\"-0.441\" dy=\"-136.772\">,</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 100px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-106.683\" dy=\"133.71\">\u25CF</text>\n    </g>";
//RAIN
//Light rain
var MIN_RA = "<g id=\"-RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n    </g>";
//Moderate rain
var RA = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"285\">..</text>\n        <text class=\"wx_text\" x=\"170\" y=\"175\">.</text>\n    </g>";
//Heavy rain
var PLUS_RA = "<g id=\"RA\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n        <text class=\"wx_text\" x=\"170\" y=\"145\">.</text>\n        <text class=\"wx_text\" x=\"170\" y=\"320\">.</text>\n    </g>";
//Light freezing rain
var MIN_FZRA = "<g id=\"-RA\" transform=\"matrix(1.4,0,0,1.2,-102.2,-30.3)\">\n        <text class=\"wx_text\" x=\"130\" y=\"240\">.</text>\n        " + sine + "\n    </g>";
//Moderate to heavy freezing rain
var FZRA = "<g id=\"-RA\" " + TRANSFORM + ">\n    <text class=\"wx_text\" x=\"130\" y=\"240\">..</text>\n    " + sine + "\n    </g>";
//Light rain and snow
var MIN_RASN = "<g id=\"MIN_RASN\">\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"-0.648\" dy=\"82.18\">*</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 200px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-129.822\" dy=\"98.015\">\u25CF</text>\n    </g>";
//Moderate to heavy rain and snow
var RASN = "<g id=\"RASN\">\n        <text style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"6.111\" dy=\"137.208\">*</text>\n        <text style=\"fill: rgb(51, 51, 51); font-family: &quot;Roboto Slab&quot;; font-size: 200px; white-space: pre;\" x=\"313.598\" y=\"154.93\" dx=\"-124.964\" dy=\"158.382\">\u25CF</text>\n        <text transform=\"matrix(1, 0, 0, 1, 11.82478, 80.656288)\" style=\"fill: rgb(51, 51, 51); font-family: Georgia; font-size: 200px; white-space: pre;\" x=\"198.442\" y=\"348.054\" dx=\"-10.654\" dy=\"-182.434\">*</text>\n    </g>";
//SNOW and MISC FROZEN PERCIP
//Light snow
var MIN_SN = "<g id=\"-SN\">\n        <text class=\"snow\" x=\"50\" y=\"370\">**</text>\n    </g>\n    ";
//Moderate snow
var SN = "<g id=\"SN\">\n        <text class=\"snow\" x=\"50\" y=\"460\">**</text>\n        <text class=\"snow\" x=\"120\" y=\"325\">*</text>\n    </g>";
//Heavy snow
var PLUS_SN = "<g id=\"+SN\">\n        <text class=\"snow\" x=\"50\" y=\"420\">**</text>\n        <text class=\"snow\" x=\"120\" y=\"285\">*</text>\n        <text class=\"snow\" x=\"120\" y=\"540\">*</text>\n    </g>";
//Snow grains
var SG = "<g id=\"SG\">\n        <polygon class=\"wx_graphic\" points=\"250 150 150 300 350 300\"></polygon>\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"230\" x2=\"197\" y2=\"230\"></line>\n        <line class=\"wx_graphic\" x1=\"303\" y1=\"230\" x2=\"450\" y2=\"230\"></line>\n    </g>";
//Ice crystals
var IC = "<g id=\"IC\">\n        <line class=\"wx_graphic\" x1=\"50\" y1=\"250\" x2=\"450\" y2=\"250\"></line>\n        <line class=\"wx_graphic\" x1=\"175\" y1=\"175\" x2=\"325\" y2=\"325\"></line>\n        <line class=\"wx_graphic\" x1=\"325\" y1=\"175\" x2=\"174\" y2=\"325\"></line>  \n    </g>";
//Ice pellets
var PE_PL = "<g id=\"PE_PL\">\n      <polygon class=\"wx_graphic\" points=\"250 150 150 300 350 300\"></polygon>\n      <text style=\"fill: black; font-size: 100px;\" x=\"237.271\" y=\"242.526\" dx=\"-18.412\" dy=\"32.137\">\u25CF</text>\n    </g>";
//SHOWERY PERCIPITATION
//Light rain showers
var MIN_SHRA = "<g id=\"MIN_SHRA\">\n        <polygon class=\"wx_graphic\"  points=\"150 160 350 160 250 475\"></polygon>\n        <text x=\"190\" y=\"140\" style=\"font-size: 200px;\">\u25CF</text>\n    </g>";
//Moderate to heavy rain showers
var SHRA = "";
//Light rain and snow showers
var MIN_SHRASN = "";
//Moderate to heavy rain and snow showers
var SHRASN = "";
//Light snow showers
var MIN_SHSN = "";
//Moderate to heavy snow showers
var SHSN = "";
//Light showers with hail, not with thunder
var MIN_GR = "";
//Moderate to heavy showers with hail, not with thunder
var GR = "";
// THUNDERSTORMS
//Light to moderate thunderstorm with rain
var TSRA = "";
//Light to moderate thunderstorm with hail
var TSGR = "";
//Thunderstorm with heavy rain
var PLUS_TSRA = "";
/**
 * Map of weather abbriviation to SVG data and Full text
 */
let WEATHER = {
    "FU": { svg: FU_VA, text: "Smoke" },
    "VA": { svg: FU_VA, text: "Volcanic Ash" },
    "HZ": { svg: HZ, text: "Haze" },
    "DU": { svg: DU_SA, text: "Dust" },
    "SA": { svg: DU_SA, text: "Sand" },
    "BLDU": { svg: BLDU_BLSA, text: "Blowing Dust" },
    "BLDA": { svg: BLDU_BLSA, text: "Blowing Sand" },
    "PO": { svg: PO, text: "Dust Devil" },
    "VCSS": { svg: VCSS, text: "Vicinity Sand Storm" },
    "BR": { svg: BR, text: "Mist or light fog" },
    "MIFG": { svg: MIFG, text: "Continuous Shallow Fog" },
    "VCTS": { svg: VCTS, text: "Vicinity Thunderstorm" },
    "VIRGA": { svg: VIRGA, text: "Virga" },
    "VCSH": { svg: VCSH, text: "Vicinity showers" },
    "TS": { svg: TS, text: "Thunderstorm" },
    "SQ": { svg: SQ, text: "Squall" },
    "FC": { svg: FC, text: "Funnel Cloud/Tornado" },
    "SS": { svg: SS, text: "Sand/Dust Storm" },
    "+SS": { svg: PLUS_SS, text: "Strong Sand/Dust Storm" },
    "BLSN": { svg: BLSN, text: "Blowing Snow" },
    "DRSN": { svg: DRSN, text: "Drifting Snow" },
    "VCFG": { svg: VCFG, text: "Vicinity Fog" },
    "BCFG": { svg: BCFG, text: "Patchy Fog" },
    "PRFG": { svg: PRFG, text: "Fog, Sky Discernable" },
    "FG": { svg: FG, text: "Fog, Sky Undiscernable" },
    "FZFG": { svg: FZFG, text: "Freezing Fog" },
    "-DZ": { svg: MIN_DZ, text: "Light Drizzle" },
    "DZ": { svg: DZ, text: "Moderate Drizzle" },
    "+DZ": { svg: PLUS_DZ, text: "Heavy Drizzle" },
    "-FZDZ": { svg: MIN_FZDZ, text: "Light Freezing Drizzle" },
    "FZDZ": { svg: FZDZ, text: "Moderate Freezing Drizzle" },
    "+FZDZ": { svg: FZDZ, text: "Heavy Freezing Drizzle" },
    "-DZRA": { svg: MIN_DZRA, text: "Light Drizzle & Rain" },
    "DZRA": { svg: DZRA, text: "Moderate to Heavy Drizzle & Rain" },
    "-RA": { svg: MIN_RA, text: "Light Rain" },
    "RA": { svg: RA, text: "Moderate Rain" },
    "+RA": { svg: PLUS_RA, text: "Heavy Rain" },
    "-FZRA": { svg: MIN_FZRA, text: "Light Freezing Rain" },
    "FZRA": { svg: FZRA, text: "Moderate Freezing Rain" },
    "+FZRA": { svg: FZRA, text: "Heavy Freezing Rain" },
    "-RASN": { svg: MIN_RASN, text: "Light Rain & Snow" },
    "RASN": { svg: RASN, text: "Moderate Rain & Snow" },
    "+RASN": { svg: RASN, text: "Heavy Rain & Snow" },
    "-SN": { svg: MIN_SN, text: "Light Snow" },
    "SN": { svg: SN, text: "Moderate Snow" },
    "+SN": { svg: PLUS_SN, text: "Heavy Snow" },
    "SG": { svg: SG, text: "Snow Grains" },
    "IC": { svg: IC, text: "Ice Crystals" },
    "PE": { svg: PE_PL, text: "Ice Pellets" },
    "PL": { svg: PE_PL, text: "Ice Pellets" }
};
let RECENT_WEATHER = {
    REBLSN: "Moderate/heavy blowing snow (visibility significantly reduced)reduced",
    REDS: "Dust Storm",
    REFC: "Funnel Cloud",
    REFZDZ: "Freezing Drizzle",
    REFZRA: "Freezing Rain",
    REGP: "Moderate/heavy snow pellets",
    REGR: "Moderate/heavy hail",
    REGS: "Moderate/heavy small hail",
    REIC: "Moderate/heavy ice crystals",
    REPL: "Moderate/heavy ice pellets",
    RERA: "Moderate/heavy rain",
    RESG: "Moderate/heavy snow grains",
    RESHGR: "Moderate/heavy hail showers",
    RESHGS: "Moderate/heavy small hail showers",
    // RESHGS: "Moderate/heavy snow pellet showers", // dual meaning?
    RESHPL: "Moderate/heavy ice pellet showers",
    RESHRA: "Moderate/heavy rain showers",
    RESHSN: "Moderate/heavy snow showers",
    RESN: "Moderate/heavy snow",
    RESS: "Sandstorm",
    RETS: "Thunderstorm",
    REUP: "Unidentified precipitation (AUTO obs. only)",
    REVA: "Volcanic Ash",
};

var GUST_WIDTH = 5;
var WS_WIDTH = 5;
/**
 * Creates a windbarb for the metar
 * @param metar
 * @returns
 */
function genWind(metar) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    var WDD = metar.wind_direction ? metar.wind_direction : 0;
    var WSP = metar.wind_speed ? metar.wind_speed : 0;
    var WGSP = metar.gust_speed ? metar.gust_speed : 0;
    var wind = "";
    var gust = "";
    if (WSP === 0) {
        wind =
            `<g id="calm"><ellipse id="calm-marker" stroke="#000" fill="#00000000" cx="250" cy="250" rx="35" ry="35"/></g>`;
    }
    else {
        gust = (metar.gust_speed === null || metar.gust_speed === undefined) ? "" :
            `<g id="gustBarb" transform="rotate(${WDD}, 250, 250)"> ` +
                `${genBarb1((_a = WGSP) !== null && _a !== void 0 ? _a : 0, true)} ` + 
                `${genBarb2((_b = WGSP) !== null && _b !== void 0 ? _b : 0, true)} ` + 
                `${genBarb3((_c = WGSP) !== null && _c !== void 0 ? _c : 0, true)} ` + 
                `${genBarb4((_d = WGSP) !== null && _d !== void 0 ? _d : 0, true)} ` + 
                `${genBarb5((_e = WGSP) !== null && _e !== void 0 ? _e : 0, true)} ` + 
            `</g>`;
        wind =
            `<g id="windBarb" transform="rotate(${WDD}, 250, 250)">` + 
            `<line stroke-width="5" y1="225" x1="250" y2="90" x2="250" stroke="#000" fill="none"/>` +
                `${genBarb1((_f = WSP) !== null && _f !== void 0 ? _f : 0, false)} ` + 
                `${genBarb2((_g = WSP) !== null && _g !== void 0 ? _g : 0, false)} ` + 
                `${genBarb3((_h = WSP) !== null && _h !== void 0 ? _h : 0, false)} ` + 
                `${genBarb4((_j = WSP) !== null && _j !== void 0 ? _j : 0, false)} ` + 
                `${genBarb5((_k = WSP) !== null && _k !== void 0 ? _k : 0, false)} ` + 
            `</g>`;
    }
    return gust + wind;
}

/**
 * Generate first barb
 * @param speed wind or gust speed
 * @param gust set to true for gust
 * @returns
 */
function genBarb1(speed, gust) {
    var fill = gust ? 'red' : '#000';
    var tag = gust ? 'gs' : 'ws';
    var width = gust ? GUST_WIDTH : WS_WIDTH;
    var barb = "";
    if (speed >= 10 && speed < 50) {
        //barb = `<line id="${tag}-barb-1-long" stroke-width="${width}" y1="50" x1="250" y2="50" x2="300" stroke="${fill}" transform="rotate(-35, 250, 50)"/>`;
        barb = `<line id="${tag}-barb-1-long" stroke-width="${width}" y1="90" x1="250" y2="90" x2="305" stroke="${fill}" transform="rotate(-35, 250, 90)"/>`;
    }
    else if (speed >= 50) {
        barb = `<polygon id="${tag}-barb-1-flag" points="248,98 290,68 248,68" fill="${fill}" />`;
    }
    return barb;
}
/**
 * Generate second barb
 * @param speed wind or gust speed
 * @param gust set to true for gust
 * @returns
 */
function genBarb2(speed, gust) {
    var fill = gust ? 'red' : '#000';
    var tag = gust ? 'gs' : 'ws';
    var width = gust ? GUST_WIDTH : WS_WIDTH;
    var barb = "";
    if ((speed < 10) || (15 <= speed && speed < 20) || (55 <= speed && speed < 60)) {
        barb = `<line id="${tag}-barb-2-short" stroke-width="${width}" y1="110" x1="250" y2="110" x2="285" stroke="${fill}" transform="rotate(-35, 250, 110)"/>`;
    }
    else if ((15 < speed && speed < 50) || (speed >= 60)) {
        barb = `<line id="${tag}-barb-2-long" stroke-width="${width}" y1="110" x1="250" y2="110" x2="305" stroke="${fill}" transform="rotate(-35, 250, 110)"/>`;
    }
    return barb;
}
/**
 * Generate third barb
 * @param speed wind or gust speed
 * @param gust set to true for gust
 * @returns
 */
function genBarb3(speed, gust) {
    var fill = gust ? 'red' : '#000';
    var tag = gust ? 'gs' : 'ws';
    var width = gust ? GUST_WIDTH : WS_WIDTH;
    var barb = "";
    if ((25 <= speed && speed < 30) || (65 <= speed && speed < 70)) {
        barb = `<line id="${tag}-barb-3-short" stroke-width="${width}" y1="150"  x1="250" y2="150" x2="285" stroke="${fill}" transform="rotate(-35, 250, 150)"/>`;
    }
    else if ((25 < speed && speed < 50) || speed >= 70) {
        barb = `<line id="${tag}-bard-3-long" stroke-width="${width}" y1="150"  x1="250" y2="150" x2="305" stroke="${fill}" transform="rotate(-35, 250, 150)"/>`;
    }
    return barb;
}
/**
 * Generate forth barb
 * @param speed wind or gust speed
 * @param gust set to true for gust
 * @returns
 */
function genBarb4(speed, gust) {
    var fill = gust ? 'red' : '#000';
    var tag = gust ? 'gs' : 'ws';
    var width = gust ? GUST_WIDTH : WS_WIDTH;
    var barb = "";
    if ((35 <= speed && speed < 40) || (75 <= speed && speed < 80)) {
        barb = `<line id="${tag}-barb-4-short" stroke-width="${width}" y1="190" x1="250" y2="190" x2="285" stroke="${fill}" transform="rotate(-35, 250, 190)"/>`;
    }
    else if ((35 < speed && speed < 50) || speed >= 80) {
        barb = `<line id="${tag}-barb-4-long" stroke-width="${width}" y1="190" x1="250" y2="190" x2="305"  stroke="${fill}" transform="rotate(-35, 250, 190)"/>`;
    }
    return barb;
}
/**
 * Generate fifth barb
 * @param speed wind or gust speed
 * @param gust set to true for gust
 * @returns
 */
function genBarb5(speed, gust) {
    var fill = gust ? 'red' : '#000';
    var tag = gust ? 'gs' : 'ws';
    var width = gust ? GUST_WIDTH : WS_WIDTH;
    var barb = "";
    if ((45 <= speed && speed < 50) || (85 <= speed && speed < 90)) {
        barb = `<line id="${tag}-barb-5-short" stroke-width="${width}" y1="230" x1="250" y2="230" x2="285" stroke="${fill}" transform="rotate(-35, 250, 230)"/>`;
    }
    return barb;
}

//Meassage types
var TYPES = ["METAR", "SPECI"];

/**
 * Parses a raw metar and binds or creates a METAR object
 * @param metarString Raw METAR string
 * @param ref Reference to a METAR object. This objects contents will be shallow replaced with the Raw metars values.
 *  Meaning values will be updated or added but not removed.
 * @returns
 */
function parseMetar(metarString, ref) {
    var station = parseStation(metarString);
    var time = parseDate(metarString);
    if (ref != null) {
        ref.station = station;
        ref.time = time;
    }
    else {
        ref = new METAR(undefined, station, time);
    }
    //Parse Auto
    ref.auto = parseAuto(metarString);
    //Parse Wind
    ref.wind = parseWind(metarString);
    //Parse CAVOK
    ref.cavok = parseCavok(metarString);
    //Parse Visablility
    ref.visibility = parseVisibility(metarString);
    //Parse Runway VIS
    //TODO
    //Parse Weather
    ref.weather = parseWeather(metarString);
    //Parse Clouds
    ref.clouds = parseClouds(metarString);
    //Parse Temp Point Internations 
    var temps_int = parseTempInternation(metarString);
    if (temps_int != null) {
        ref.temperature = temps_int[0];
        ref.dewpoint = temps_int[1];
    }
    //Parse Temp North american Will overwirte international since it is more precise
    var temps_ne = parseTempNA(metarString);
    if (temps_ne != null) {
        ref.temperature = temps_ne[0];
        ref.dewpoint = temps_ne[1];
    }
    //Parse Altimeter
    ref.altimeter = parseAltimeter(metarString);
    return ref;
}

/**
 * Parses the station name form the metar
 * @param metar raw metar
 * @returns
 */
function parseStation(metar) {
    var re = /^(METAR\s)?([A-Z]{1,4})\s/g;
    var matches = re.exec(metar);
    if (matches != null) {
        return matches[2];
    }
    else {
        throw new Error("Station could not be found invalid metar");
    }
}

/**
 * Parse Date object from metar.
 * NOTE: Raw metar data does not contain month or year data. So this function assumes this metar was created in the current month and current year
 * @param metar raw metar
 * @returns
 */
function parseDate(metar) {
    var re = /([\d]{2})([\d]{2})([\d]{2})Z/g;
    var matches = re.exec(metar);
    if (matches != null) {
        var d = new Date();
        d.setUTCDate(parseInt(matches[1]));
        d.setUTCHours(parseInt(matches[2]));
        d.setUTCMinutes(parseInt(matches[3]));
        d.setUTCSeconds(0);
        d.setUTCMilliseconds(0);
        return d;
    }
    else {
        throw new Error("Failed to parse Date");
    }
}

/**
 * Parses for CAVOK (Ceiling and visabiliy OK)
 * @param metar raw metar
 * @returns
 */
function parseCavok(metar) {
    var re = /\sCAVOK\s/g;
    return metar.match(re) != null ? true : false;
}

/**
 * Parses for Automation
 * @param metar raw metar
 * @returns
 */
function parseAuto(metar) {
    var re = /\s(AUTO)?(AO1)?(AO2)?\s/g;
    return metar.match(re) != null ? true : false;
}

/**
 * Parse international temp dewp point format.
 * @param metar raw metar
 * @returns
 */
function parseTempInternation(metar) {
    var re = /\s(M)?(\d{2})\/(M)?(\d{2})\s/g;
    var matches = re.exec(metar);
    if (matches != null) {
        var temp = parseInt(matches[2]) * (matches[1] == null ? 1 : -1);
        var dew_point = parseInt(matches[4]) * (matches[3] == null ? 1 : -1);
        return [temp, dew_point];
    }
}

/**
 * Parse North American temp dew point format
 * @param metar raw metar
 * @returns
 */
function parseTempNA(metar) {
    var re = /(T)(\d{1})(\d{2})(\d{1})(\d{1})(\d{2})(\d{1})/g;
    var matches = re.exec(metar);
    if (matches != null) {
        var temp = parseFloat(matches[3] + "." + matches[4]) * (matches[2] === "0" ? 1 : -1);
        var dew_point = parseFloat(matches[6] + "." + matches[7]) * (matches[5] === "0" ? 1 : -1);
        return [temp, dew_point];
    }
}

/**
 * Parse Weather items
 * @param metar raw metar
 * @returns
 */
function parseWeather(metar) {
    var obs_keys = Object.keys(WEATHER).join('|').replace(/\+/g, "\\+");
    var re = new RegExp("\\s?(" + obs_keys + ")\\s", 'g');
    var matches = metar.match(re);
    if (matches != null) {
        return matches.map(function (match) {
            var key = match.trim();
            return {
                abbreviation: key,
                meaning: WEATHER[key].text
            };
        });
    }
    else {
        return new Array();
    }
}

/**
 * Parse visibility
 * @param metar raw metar
 * @returns
 */
function parseVisibility(metar) {
    var re = /\s([0-9]{1,2})?\s?([0-9]{1}\/[0-9]{1})?(SM)\s|\s([0-9]{1,4})\s/g;
    if (metar.match(re)) {
        var vis_parts = re.exec(metar);
        if (vis_parts != null) {
            var meters = vis_parts[4];
            var miles = vis_parts[1];
            var frac_miles = vis_parts[2];
            //Metric case ex: 1000, 9999 
            if (meters != null) {
                return parseInt(meters);
            }
            //whole miles case ex: 1SM 10SM
            else if (frac_miles != null) {
                var total = 0.0;
                if (miles != null) {
                    total += parseFloat(miles);
                }
                total += parseFloat(eval(frac_miles));
                return total * 1609.34;
            }
            //factional miles case "1 1/2SM" "1/4SM"
            else {
                return parseInt(miles) * 1609.34;
            }
        }
    }
    return undefined;
}

/**
 * Parse cloud coverages
 * @param metarString raw metar
 * @returns
 */
function parseClouds(metarString) {
    var _a;
    var re = /(NCD|SKC|CLR|NSC|FEW|SCT|BKN|OVC|VV)(\d{3})/g;
    var clouds = new Array();
    var matches;
    while ((matches = re.exec(metarString)) != null) {
        var cloud = {
            abbreviation: matches[1],
            meaning: (_a = CLOUDS[matches[1]]) === null || _a === void 0 ? void 0 : _a.text,
            altitude: parseInt(matches[2]) * 100
        };
        clouds.push(cloud);
    }
    return clouds;
}

/**
 * Parse wind data
 * @param metar raw metar
 * @returns
 */
function parseWind(metar) {
    var wind = new Wind();
    var re = /\s(\d{3})(\d{2})(G)?(\d{2})?(KT|MPS)\s/g;
    var matches = re.exec(metar);
    if (matches != null) {
        wind.direction = parseInt(matches[1]);
        wind.speed = parseInt(matches[2]);
        wind.unit = matches[5];
    }
    return wind;
}

function parseAltimeter(metar) {
    var re = /(A|Q)(\d{2})(\d{2})/g;
    var matches = re.exec(metar);
    if (matches != null) {
        if (matches[1] === "Q") {
            var pressure = parseFloat(matches[2] + matches[3]);
            return parseFloat((pressure * 0.029529).toFixed(2));
        }
        else {
            return parseFloat(matches[2] + "." + matches[3]);
        }
    }
}

//var Metar_1 = require("./Metar");
//var Cloud_1 = require("./parts/Cloud");
//var Weather_1 = require("./parts/Weather");
//var Wind_1 = require("./parts/Wind");
/**
 * Extracted Metar message
 */
var MetarPlot = /** @class */ (function () {
    function MetarPlot() {
    }
    return MetarPlot;
}());

/**
 * Turns a raw METAR to an SVG image
 * @param rawMetar RAW metar
 * @param width css width of svg
 * @param height css height of svg
 * @param metric true for metric units(m, hPa, mps), false for north american units (miles, inHg, Kts)
 * @returns
 */
function rawMetarToSVG(rawMetar, width, height, metric) {
    var plot = rawMetarToMetarPlot(rawMetar, metric);
    return metarToSVG(plot, width, height);
}

/**
 *
 * @param rawMetar raw metar string
 * @param metric true for metric units(m, hPa, mps), false for north american units (miles, inHg, Kts)
 * @returns
 */
function rawMetarToMetarPlot(rawMetar, metric) {
    var _a;
    var metar = new METAR(rawMetar);
    var wx = metar.weather.map(function (weather) { return weather.abbreviation; }).join("");
    //Metric converion
    var pressure;
    var vis = undefined;
    var temp = metar.temperature;
    var dp = metar.dewpoint;
    if (metric) {
        pressure = (metar.altimeter != null) ? Math.round(metar.altimeter * 33.86) : undefined;
        if (metar.visibility != null) {
            vis = metar.visibility > 9999 ? 9999 : Math.round(metar.visibility);
        }
    }
    else {
        temp = cToF(temp);
        dp = cToF(dp);
        pressure = metar.altimeter;
        vis = milePrettyPrint((_a = metar.visibility) !== null && _a !== void 0 ? _a : -1);
    }
    return {
        metric: metric !== null && metric !== void 0 ? metric : false,
        visiblity: vis,
        temp: temp,
        dew_point: dp,
        station: metar.station,
        wind_direction: (typeof metar.wind.direction === "number") ? metar.wind.direction : undefined,
        wind_speed: metar.wind.speed,
        gust_speed: metar.wind.gust,
        wx: wx,
        pressure: pressure,
        coverage: determineCoverage(metar)
    };
}

/**
 * Pretty print Miles in fractions if under 1 mile
 */
function milePrettyPrint(meters) {
    var print = "";
    if (meters === -1) {
        return print;
    }
    var miles = meters * 0.0006213712;
    //round to nearest quarter
    var text = (Math.round(miles * 4) / 4).toFixed(2).toString();
    return text.replace(".00", "");
}
/**
 * Determines the coverage symbol
 * @param metar
 * @returns
 */
function determineCoverage(metar) {
    var _a;
    var prevailingCoverage;
    metar.clouds.forEach(function (cloud) {
        if (prevailingCoverage != null) {
            var curr = prevailingCoverage.abbreviation != null ? CLOUDS[prevailingCoverage.abbreviation].rank : undefined;
            var rank = cloud.abbreviation != null ? CLOUDS[cloud.abbreviation].rank : undefined;
            //console.log("cur: " + curr + ", rank: " + rank);
            if (rank != null) {
                if (rank > curr) {
                    prevailingCoverage = cloud;
                }
            }
        }
        else {
            prevailingCoverage = cloud;
        }
    });
    return (_a = prevailingCoverage === null || prevailingCoverage === void 0 ? void 0 : prevailingCoverage.abbreviation) !== null && _a !== void 0 ? _a : "";
}
/**
 * Turns a Metar plot object to a SVG image
 * @param metar MetarPlot Object
 * @param width css width for svg
 * @param height css height for svg
 * @returns
 */
 function metarToSVG(metar, width, height) {
    var _a, _b, _c, _d, _e, _f;
    var VIS = (_a = metar.visablity) !== null && _a !== void 0 ? _a : "";
    var TMP = (_b = metar.temp) !== null && _b !== void 0 ? _b : "";
    var DEW = (_c = metar.dew_point) !== null && _c !== void 0 ? _c : "";
    var STA = (_d = metar.station) !== null && _d !== void 0 ? _d : "";
    var ALT = (_e = metar.pressure) !== null && _e !== void 0 ? _e : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 500 500"> ` +
           `<style> ` + 
                `.txt{ font-size: 47.5px; font-family: sans-serif; } ` +
                `.tmp{ fill: red } ` + 
                `.sta{ fill: grey } ` + 
                `.dew{ fill: blue } ` +
                `.vis{ fill: violet } ` +
           `</style> ${(0, genWind)(metar)} ${(0, getWeatherSVG)((_f = metar.wx) !== null && _f !== void 0 ? _f : "")} ` +
           `         ${(0, genCoverage)(metar.coverage, metar.condition)} ` + 
           `<g id="text"><text class="vis txt" fill="#000000" stroke="#000" stroke-width="0" x="80" y="260" text-anchor="middle" ` +
           `xml:space="preserve">${VIS}</text><text class="tmp txt" fill="#000000" stroke="#000" stroke-width="0" x="160" y="220" text-anchor="middle" ` +
           `xml:space="preserve">${TMP}</text><text class="dew txt" fill="#000000" stroke="#000" stroke-width="0" x="160"  y="315" text-anchor="middle" ` +
           `xml:space="preserve">${DEW}</text><text class="sta txt" fill="#000000" stroke="#000" stroke-width="0" x="275"  y="315" text-anchor="start" ` +
           `xml:space="preserve">${STA}</text><text class="sta txt" fill="#000000" stroke="#000" stroke-width="0" x="275"  y="220" text-anchor="start" ` +
           `xml:space="preserve">${ALT}</text></g></svg>`;
}

/**
 * Generate a wind barb SVG image
 * @param {int} width 
 * @param {int} height 
 * @param {object} metar 
 * @returns 
 */
function getWindBarbSvg(width, height, metar) {
    let catcolor = "";
    let svg = "";
    let thismetar = {
        wind_direction: metar.wind_dir_degrees,
        wind_speed: metar.wind_speed_kt,
        gust_speed: metar.gust_speed_kt,
        station: metar.station_id
    };
    try {
        switch (metar.flight_category) {
            case "IFR":
                catcolor ="ff0000";
                break;
            case "LIFR":
                catcolor = "ff00ff";
                break;
            case "MVFR": 
                catcolor = "0000cd";
                break;
            case "VFR":
            default:
                catcolor = "12f23c";
                break;
        }
        svg = `<svg xmlns="http://www.w3.org/2000/svg" ` +
                  `width="${width}" height="${height}" ` + 
                  `viewBox="0 0 500 500">` + 
                  (0, genWind)(thismetar) + 
                  `<g id="clr">` + 
                       `<circle cx="250" cy="250" r="30" stroke="#000000" stroke-width="3" fill="#${catcolor}"/>` +
                  `</g>` + 
               `</svg>`;
    }
    catch {}
    return svg; 
}
/**
 * Convert ºF to ºF
 * @param celsius
 */
function cToF(celsius) {
    if (celsius != null) {
        return Math.round(celsius * 9 / 5 + 32);
    }
}

