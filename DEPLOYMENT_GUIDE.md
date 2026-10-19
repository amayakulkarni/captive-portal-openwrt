# Deployment Guide

End-to-end setup on an OpenWrt 23.05 router (fw4/nftables). Everything specific to your
network is read from `portal.env`; nothing needs editing in the source files.

## 1. Prerequisites

- SSH access: `root@<router-ip>`
- OpenWrt 23.05+ with fw4 (`nft --version` works)
- Bridge VLAN interfaces for the four portal subnets already exist in `/etc/config/network`
  (defaults: `br-lan.25`, `.100`, `.75`, `.125`) with DHCP enabled
- Free space on the overlay for Node (`df -h /overlay`)
- DHCP hands out the router as DNS on all portal VLANs (the firewall only permits DNS to the router)

## 2. Configure

```sh
cp config/portal.env.example portal.env
openssl rand -hex 32          # use as ADMIN_API_KEY
```

Edit `portal.env`: `NETWORK_NAME`, the three secrets, your VLAN ids / subnets / interface
names, and `PERMANENT_WHITELIST_MACS`. Preview the generated firewall on your PC:

```sh
sh deploy/render-nft.sh portal.env /dev/stdout
```

## 3. Copy to the router

```sh
ssh root@<router-ip> mkdir -p /etc/captive-portal
scp -r app.js db.js migration.js package.json views config deploy seed portal.env \
    root@<router-ip>:/etc/captive-portal/
```

Resulting layout:

```
/etc/captive-portal/
├── app.js  db.js  migration.js  package.json  portal.env (chmod 600)
├── views/ config/ deploy/ seed/
└── networks.json        (created on first write)
```

## 4. Install

```sh
ssh root@<router-ip>
sh /etc/captive-portal/deploy/install.sh
```

This installs Node and dependencies, renders `/etc/nftables.d/portal.nft` from the template,
restarts the firewall, and registers a `procd` service that survives reboots.

> **fw4 include rule:** fw4 splices every `/etc/nftables.d/*.nft` *inside* its own
> `table inet fw4 { }`. The template is intentionally bare (sets/chains only). Wrapping it in a
> `table` block breaks the whole ruleset. Because it lives in `nftables.d`, the rules survive
> `service firewall restart` and reboots.

If your `wan` zone already has `option masq '1'`, the `portal_postrouting` chain is redundant
(harmless).

## 5. Verify

```sh
sh /etc/captive-portal/deploy/healthcheck.sh
```

Manual checks:

- [ ] New device on Guest -> captive prompt -> today's passcode -> internet
- [ ] New device on Family -> admin user/password -> internet
- [ ] A MAC verified only on Guest has no internet on the other subnets
- [ ] Permanent-whitelist MACs can reach SSH/LuCI from any portal subnet
- [ ] `http://<router-ip>:<PORT>/admin` loads and accepts the API key

## 6. Operations

- **Guest passcode** rotates daily at midnight (guests are flushed). Fetch it:
  `curl -H "x-api-key: $ADMIN_API_KEY" http://<router-ip>:3000/api/admin/passcode`
- **IoT devices**: add from `/admin` (also writes a DHCP static lease through `uci`), or seed
  with `node migration.js`.
- **Remove a device**: dashboard, or `POST /api/devices/delete`.
- **Restore sets after a firewall wipe**: `GET /sync` with the `x-api-key` header.
- **Backups**: `networks.json` is the entire state; copy it off periodically (keep it out of git).
- **Changing config**: edit `portal.env`, then `sh deploy/render-nft.sh /etc/captive-portal/portal.env`,
  `service firewall restart`, `/etc/init.d/captive-portal restart`.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| App exits immediately | `logread -e captive-portal` - missing `ADMIN_API_KEY` / `ADMIN_USER` / `ADMIN_PASS` |
| `service firewall restart` errors on `portal.nft` plus errors in fw4's own chains | File was wrapped in a `table` block; re-render with `render-nft.sh` |
| Captive prompt never appears | `nft list ruleset \| grep portal_` (expect 5 chains) |
| Whitelisted device has no internet | Verified on the wrong subnet: `nft list set inet fw4 whitelist_guest` etc. |
| Everyone lands on the guest page | `FAMILY_SUBNET` does not match your family subnet |
| `npm install` fails | `node -v` should be 18.x; check overlay space |
| `render-nft.sh` rejects input | It validates CIDRs and MACs; fix the value it names |
