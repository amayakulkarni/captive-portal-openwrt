const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

/**
 * Minimal .env loader (no dependency). Real environment variables win over
 * the file. Looks at $PORTAL_ENV_FILE, then ./portal.env next to this script.
 */
(function loadEnvFile() {
    const file = process.env.PORTAL_ENV_FILE || path.join(__dirname, 'portal.env');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let val = m[2];
        if (/^".*"$|^'.*'$/.test(val)) val = val.slice(1, -1);
        else val = val.replace(/\s+#.*$/, ''); // strip trailing comment on unquoted values
        if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
})();

const db = require('./db');

// ---------------------------------------------------------------- CONFIG
const env = process.env;
const PORT = parseInt(env.PORT || '3000', 10);
const NETWORK_NAME = env.NETWORK_NAME || 'Captive Portal';
const ADMIN_API_KEY = env.ADMIN_API_KEY;
const ADMIN_USER = env.ADMIN_USER;
const ADMIN_PASS = env.ADMIN_PASS;

const missing = ['ADMIN_API_KEY', 'ADMIN_USER', 'ADMIN_PASS'].filter((k) => !env[k]);
if (missing.length) {
    console.error(`Refusing to start: missing required env var(s): ${missing.join(', ')}. See config/portal.env.example.`);
    process.exit(1);
}

const FAMILY_SUBNET = env.FAMILY_SUBNET || '192.168.25.0/24';
const IOT_SUBNET = env.IOT_SUBNET || '192.168.75.0/24';
const NATIVE_IOT_SUBNET = env.NATIVE_IOT_SUBNET || '192.168.125.0/24';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SET_BY_TYPE = {
    guest: 'whitelist_guest',
    throttled: 'whitelist_throttled',
    iot: 'whitelist_iot',
    native_iot: 'whitelist_native_iot',
};

// ---------------------------------------------------------------- HELPERS
const app = express();
app.use(bodyParser.json());

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function ipToInt(ip) {
    const m = IPV4_RE.exec(ip || '');
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function ipInCidr(ip, cidr) {
    const [base, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    const a = ipToInt(ip), b = ipToInt(base);
    if (a === null || b === null || isNaN(bits)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Serve a views/*.html file with {{PLACEHOLDERS}} filled from config. */
const VIEW_VARS = {
    NETWORK_NAME: escapeHtml(NETWORK_NAME),
    NETWORK_NAME_UPPER: escapeHtml(NETWORK_NAME.toUpperCase()),
    IOT_SUBNET: escapeHtml(IOT_SUBNET),
    NATIVE_IOT_SUBNET: escapeHtml(NATIVE_IOT_SUBNET),
};
function sendView(res, name) {
    fs.readFile(path.join(__dirname, 'views', name), 'utf8', (err, html) => {
        if (err) return res.status(500).send('View not found');
        res.type('html').send(html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in VIEW_VARS ? VIEW_VARS[k] : m)));
    });
}

function clientIpOf(req) {
    // The portal is hit directly (nft redirect), so the socket address is the client.
    // X-Forwarded-For is deliberately NOT trusted: it is client-controlled.
    return (req.socket.remoteAddress || '').replace(/^.*:/, '');
}

/** Execute shell commands locally on the router. Callers must only interpolate validated values. */
function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Command failed: ${cmd}`, stderr);
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

const authenticateAdmin = (req, res, next) => {
    if (safeEqual(req.headers['x-api-key'], ADMIN_API_KEY)) return next();
    res.status(403).json({ error: 'Unauthorized access to Management API' });
};

/** Get MAC address from IP using the kernel neighbor table. */
async function getMacFromIp(ip) {
    if (ipToInt(ip) === null) return null;
    try {
        const output = await runCommand(`ip neighbor show ${ip}`);
        const match = output.match(/([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}/);
        return match ? match[0].toLowerCase() : null;
    } catch (e) {
        console.error('Local ARP table lookup failed:', e);
        return null;
    }
}

/** Restore database state into the nftables sets. */
async function syncRouter() {
    console.log('Starting local sync with nftables...');
    db.all(async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            console.log('No entries in database to restore.');
            return;
        }
        const groups = { guest: [], throttled: [], iot: [], native_iot: [] };
        rows.forEach((r) => groups[r.type]?.push(r.mac));

        for (const [type, macs] of Object.entries(groups)) {
            if (macs.length === 0) continue;
            try {
                await runCommand(`nft add element inet fw4 ${SET_BY_TYPE[type]} { ${macs.join(', ')} }`);
            } catch (e) {
                console.error(`Error populating set ${SET_BY_TYPE[type]}:`, e.message);
            }
        }
        console.log(`Restore sync complete. Restored ${rows.length} devices.`);
    });
}

syncRouter();

// Daily passcode & cleanup
const newPasscode = () => 'GUEST' + crypto.randomInt(1000, 10000);
let dailyPasscode = newPasscode();
cron.schedule('0 0 * * *', async () => {
    db.all({ type: 'guest' }, async (err, rows) => {
        if (rows) {
            for (const row of rows) {
                await runCommand(`nft delete element inet fw4 whitelist_guest { ${row.mac} }`).catch(() => {});
            }
        }
        db.deleteByType('guest');
        dailyPasscode = newPasscode();
    });
});

// ---------------------------------------------------------------- PUBLIC PORTAL
app.get('/', (req, res) => {
    if (req.query.type) return sendView(res, 'portal.html');
    const detectedType = ipInCidr(clientIpOf(req), FAMILY_SUBNET) ? 'throttled' : 'guest';
    res.redirect(302, `/?type=${detectedType}`);
});

// Captive-portal detection endpoints used by phones/laptops
app.get([
    '/generate_204', '/success.txt', '/hotspot-detect.html',
    '/connectivity-check', '/check_network_status', '/ncsi.txt', '/connecttest.txt',
], (req, res) => res.redirect(302, '/'));

app.post('/api/auth', async (req, res) => {
    const { type, firstName, deviceName, passcode, adminUser, adminPass } = req.body || {};
    if (type !== 'guest' && type !== 'throttled') return res.status(400).json({ error: 'Invalid type' });

    const mac = await getMacFromIp(clientIpOf(req));
    if (!mac) {
        return res.status(400).json({ error: 'Could not identify your hardware details. Please ensure you are connected to the network.' });
    }

    if (type === 'guest' && !safeEqual(passcode, dailyPasscode)) {
        return res.status(401).json({ error: 'Invalid Passcode' });
    }
    if (type === 'throttled' && !(safeEqual(adminUser, ADMIN_USER) && safeEqual(adminPass, ADMIN_PASS))) {
        return res.status(401).json({ error: 'Invalid Admin Credentials' });
    }

    try {
        await runCommand(`nft add element inet fw4 ${SET_BY_TYPE[type]} { ${mac} }`);
        db.insertOrReplace({ firstName, deviceName, mac, type });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Router Engine Comm Error' });
    }
});

// ---------------------------------------------------------------- ADMIN
app.get('/admin', (req, res) => sendView(res, 'admin.html'));

app.get('/api/admin/passcode', authenticateAdmin, (req, res) => res.json({ passcode: dailyPasscode }));

app.get('/api/devices', authenticateAdmin, (req, res) => {
    db.allSortedByDateDesc((err, rows) => res.json(rows));
});

app.post('/api/admin/flush', authenticateAdmin, async (req, res) => {
    try {
        for (const s of Object.values(SET_BY_TYPE)) {
            await runCommand(`nft flush set inet fw4 ${s}`).catch(() => {});
        }
        await syncRouter();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

app.get('/sync', authenticateAdmin, async (req, res) => {
    try {
        await syncRouter();
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.sendStatus(500);
    }
});

/** Register an IoT device, with optional DHCP static reservation. */
app.post('/api/iot/add', authenticateAdmin, async (req, res) => {
    const { firstName, deviceName, mac, ip, type } = req.body || {};
    if (type !== 'iot' && type !== 'native_iot') return res.status(400).json({ error: 'Invalid type.' });
    if (!mac || !firstName || !deviceName) return res.status(400).json({ error: 'Missing fields.' });

    const cleanMac = String(mac).toLowerCase().trim();
    const cleanIp = ip ? String(ip).trim() : null;
    if (!MAC_RE.test(cleanMac)) return res.status(400).json({ error: 'Invalid MAC address.' });
    if (cleanIp && ipToInt(cleanIp) === null) return res.status(400).json({ error: 'Invalid IP address.' });

    const setName = SET_BY_TYPE[type];
    const sectionName = `host_${cleanMac.replace(/:/g, '')}`;
    const safeName = String(deviceName).replace(/[^a-zA-Z0-9]/g, '-');

    try {
        // Clear ghost assignments matching MAC or IP
        const purgeCmd = [
            `uci show dhcp | grep -i '${cleanMac}' | cut -d'.' -f2 | xargs -I {} uci delete dhcp.{}`,
            cleanIp ? `uci show dhcp | grep '${cleanIp}' | cut -d'.' -f2 | xargs -I {} uci delete dhcp.{}` : 'true',
        ].join('; ');
        await runCommand(purgeCmd).catch(() => {});

        if (cleanIp) {
            await runCommand([
                `uci set dhcp.${sectionName}=host`,
                `uci set dhcp.${sectionName}.name='${safeName}'`,
                `uci set dhcp.${sectionName}.mac='${cleanMac}'`,
                `uci set dhcp.${sectionName}.ip='${cleanIp}'`,
                `uci set dhcp.${sectionName}.leasetime='infinite'`,
            ].join(' && '));
        }

        await runCommand('uci commit dhcp && /etc/init.d/dnsmasq restart');
        await runCommand(`nft add element inet fw4 ${setName} { ${cleanMac} }`);

        db.insert({ firstName, deviceName, mac: cleanMac, ip: cleanIp, type }, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    } catch (e) {
        console.error('IoT Provisioning Error:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

app.post('/api/devices/delete', authenticateAdmin, async (req, res) => {
    const { mac: rawMac, type } = req.body || {};
    const mac = String(rawMac || '').toLowerCase().trim();
    if (!MAC_RE.test(mac) || !SET_BY_TYPE[type]) return res.status(400).json({ error: 'Invalid mac or type.' });
    const setName = SET_BY_TYPE[type];

    db.get(mac, async (err, row) => {
        if (err) return res.status(500).json({ error: 'DB query failed' });

        if (row && row.ip) {
            const sectionName = `host_${mac.replace(/:/g, '')}`;
            await runCommand(`uci delete dhcp.${sectionName} && uci commit dhcp && /etc/init.d/dnsmasq restart`).catch(() => {});
        }

        await runCommand(`nft delete element inet fw4 ${setName} { ${mac} }`).catch(() => {});
        db.deleteByMac(mac, (err2) => {
            if (err2) return res.status(500).json({ error: 'Store removal error' });
            res.json({ success: true });
        });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`${NETWORK_NAME} portal listening on port ${PORT}`);
});
