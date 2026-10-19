/**
 * Lightweight JSON-backed store, replacing sqlite3.
 *
 * OpenWrt on the BPI-R3 ships Node 18 (no native toolchain, no built-in
 * node:sqlite), and the dataset here is a few dozen device records with
 * simple CRUD access — a flat JSON file with atomic writes covers that
 * completely without needing node-gyp or any native addon on the router.
 *
 * Writes are atomic (write to a temp file, then rename over the real file)
 * so a crash or power loss mid-write can't leave networks.json corrupted.
 *
 * The exported API intentionally mirrors the shape of the sqlite3 calls
 * app.js used to make (callback-style, (err, rows) / (err, row)) so the
 * rest of the app needed minimal changes.
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.DATA_DIR || __dirname, 'networks.json');

function loadRaw() {
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.users)) throw new Error('malformed store');
        return parsed;
    } catch (e) {
        return { nextId: 1, users: [] };
    }
}

let state = loadRaw();

function persist() {
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, DB_PATH); // atomic on the same filesystem
}

module.exports = {
    /**
     * Fetch all users, optionally filtered.
     * all(cb) -> all rows
     * all({ type: 'guest' }, cb) -> rows matching the given field/value pairs
     */
    all(filter, cb) {
        if (typeof filter === 'function') { cb = filter; filter = null; }
        try {
            let rows = state.users.slice();
            if (filter) {
                rows = rows.filter((row) =>
                    Object.entries(filter).every(([k, v]) => row[k] === v)
                );
            }
            cb(null, rows);
        } catch (e) {
            cb(e);
        }
    },

    /** Fetch a single user by mac. */
    get(mac, cb) {
        const row = state.users.find((u) => u.mac === mac) || null;
        cb(null, row);
    },

    /** Same rows as all(), sorted newest-first by addedDate. */
    allSortedByDateDesc(cb) {
        const rows = state.users
            .slice()
            .sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate));
        cb(null, rows);
    },

    /** Insert a new user, failing if the mac already exists (mirrors UNIQUE mac). */
    insert(user, cb) {
        if (state.users.some((u) => u.mac === user.mac)) {
            const err = new Error('UNIQUE constraint failed: users.mac');
            if (cb) cb(err);
            return;
        }
        const record = {
            id: state.nextId++,
            firstName: user.firstName,
            deviceName: user.deviceName,
            mac: user.mac,
            ip: user.ip || null,
            type: user.type,
            addedDate: new Date().toISOString(),
        };
        state.users.push(record);
        persist();
        if (cb) cb(null, record);
    },

    /** Insert, or overwrite the existing record for that mac (mirrors INSERT OR REPLACE). */
    insertOrReplace(user, cb) {
        const idx = state.users.findIndex((u) => u.mac === user.mac);
        const record = {
            id: idx >= 0 ? state.users[idx].id : state.nextId++,
            firstName: user.firstName,
            deviceName: user.deviceName,
            mac: user.mac,
            ip: user.ip !== undefined ? user.ip : idx >= 0 ? state.users[idx].ip : null,
            type: user.type,
            addedDate: idx >= 0 ? state.users[idx].addedDate : new Date().toISOString(),
        };
        if (idx >= 0) state.users[idx] = record;
        else state.users.push(record);
        persist();
        if (cb) cb(null, record);
    },

    /** Delete a single user by mac. */
    deleteByMac(mac, cb) {
        const before = state.users.length;
        state.users = state.users.filter((u) => u.mac !== mac);
        persist();
        if (cb) cb(null, { changes: before - state.users.length });
    },

    /** Delete every user of a given type (used by the daily guest cleanup). Returns the removed rows. */
    deleteByType(type, cb) {
        const removed = state.users.filter((u) => u.type === type);
        state.users = state.users.filter((u) => u.type !== type);
        persist();
        if (cb) cb(null, removed);
    },

    /** Reload from disk (mainly useful for tests / migration scripts run in-process). */
    reload() {
        state = loadRaw();
    },
};
