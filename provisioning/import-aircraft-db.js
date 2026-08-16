#!/usr/bin/env node
// One-time import of OpenSky's aircraft metadata CSV into a local SQLite
// database for fast icao24 -> registration/model/operator/category
// lookups. Not run automatically - see provisioning/README.md.
//
// Usage:
//   node provisioning/import-aircraft-db.js /path/to/aircraft-database-complete-2025-08.csv
//
// Download the CSV from (not checked into git - same reasoning as
// charts/*.mbtiles, it's ~100MB and effectively static):
//   https://s3.opensky-network.org/data-samples/metadata/aircraft-database-complete-2025-08.csv

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const Database = require('better-sqlite3');

const csvPath = process.argv[2];
if (!csvPath) {
    console.error('Usage: node import-aircraft-db.js <path-to-csv>');
    process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'aircraft.db');
if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE aircraft (
        icao24 TEXT PRIMARY KEY,
        registration TEXT,
        manufacturer TEXT,
        model TEXT,
        typecode TEXT,
        operator TEXT,
        category TEXT
    )
`);

const insert = db.prepare(`
    INSERT OR REPLACE INTO aircraft (icao24, registration, manufacturer, model, typecode, operator, category)
    VALUES (@icao24, @registration, @manufacturer, @model, @typecode, @operator, @category)
`);
const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
});

let count = 0;
let batch = [];
const BATCH_SIZE = 5000;

const parser = fs.createReadStream(csvPath).pipe(parse({
    columns: true,
    skip_empty_lines: true,
    quote: "'",
    relax_quotes: true,
    relax_column_count: true
}));

parser.on('readable', () => {
    let record;
    while ((record = parser.read()) !== null) {
        const icao24 = (record.icao24 || '').trim().toLowerCase();
        if (!icao24) continue;

        batch.push({
            icao24,
            registration: record.registration || null,
            manufacturer: record.manufacturerName || null,
            model: record.model || null,
            typecode: record.typecode || null,
            operator: record.operator || null,
            category: record.icaoAircraftClass || null
        });
        count++;

        if (batch.length >= BATCH_SIZE) {
            insertMany(batch);
            batch = [];
            process.stdout.write(`\rImported ${count} rows...`);
        }
    }
});

parser.on('end', () => {
    if (batch.length > 0) {
        insertMany(batch);
    }
    console.log(`\nDone. Imported ${count} rows into ${dbPath}`);
    db.close();
});

parser.on('error', (err) => {
    console.error('CSV parse error:', err);
    process.exit(1);
});
