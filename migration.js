/**
 * Optional one-time seed: loads device records from seed/devices.json
 * (gitignored - copy seed/devices.example.json and edit) into the store.
 * Safe to re-run: MACs that already exist are skipped.
 *
 *   node migration.js [path/to/devices.json]
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const file = process.argv[2] || path.join(__dirname, 'seed', 'devices.json');
if (!fs.existsSync(file)) {
    console.error(`No seed file at ${file}. Copy seed/devices.example.json to seed/devices.json and edit it.`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const d of data) {
    db.insert(
        { firstName: d.firstName, deviceName: d.deviceName, mac: String(d.mac).toLowerCase(), ip: d.ip, type: d.type },
        (err, record) => {
            if (err) console.log(`skip ${d.mac}: ${err.message}`);
            else console.log(`seeded ${record.mac} (${record.deviceName})`);
        }
    );
}
console.log(`Migration complete: ${data.length} record(s) processed.`);
