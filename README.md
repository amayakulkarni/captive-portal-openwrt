# OpenWrt Multi-Subnet Captive Portal

A captive portal for **OpenWrt 23.05+ (fw4/nftables)** with four isolated subnets,
each with its own authentication method, plus a Node.js portal/admin server that
runs **on the router itself** (tested on a Banana Pi BPI-R3).

| Subnet | Default VLAN | nft set | Auth | Expiry |
|---|---|---|---|---|
| Family ("throttled") | `br-lan.25` | `whitelist_throttled` | admin username + password | manual kick |
| Guest | `br-lan.100` | `whitelist_guest` | daily passcode | midnight flush |
| IoT | `br-lan.75` | `whitelist_iot` | added by admin in `/admin` | manual kick |
| Native IoT | `br-lan.125` | `whitelist_native_iot` | added by admin in `/admin` | manual kick |
| Trusted LAN | `br-lan.1` | - | none (never captive) | - |

Unverified devices get no internet. A device verified on one subnet is not trusted on
another. A short list of permanent-whitelist MACs bypasses everything.

## Everything site-specific lives in one file

Copy `config/portal.env.example` to `portal.env` (gitignored) and set:

| Variable | Purpose |
|---|---|
| `NETWORK_NAME` | Title/heading shown on the portal and admin pages |
| `ADMIN_API_KEY` | **Required.** Header key for the admin API/dashboard |
| `ADMIN_USER`, `ADMIN_PASS` | **Required.** Credentials for family-subnet sign-up |
| `PORT` | Portal port (default `3000`) |
| `BRIDGE`, `*_VLAN`, `WAN_IFACE` | Interface naming (`<BRIDGE>.<VLAN>`); override per-interface with `IF_*` |
| `*_SUBNET` | CIDRs for the four portal subnets (portal detection + NAT) |
| `PERMANENT_WHITELIST_MACS` | Comma-separated MACs with unrestricted access |

The app refuses to start if the three secrets are missing. The firewall is generated from
`deploy/portal.nft.tpl` by `deploy/render-nft.sh`, so subnets, VLANs and MACs are never
hard-coded in the ruleset.

## Quick start

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md). In short, on the router:

```sh
scp -r . root@<router-ip>:/etc/captive-portal/
ssh root@<router-ip>
cd /etc/captive-portal
cp config/portal.env.example portal.env && vi portal.env   # fill in secrets + layout
sh deploy/install.sh
```

Optional: pre-register IoT devices with `cp seed/devices.example.json seed/devices.json`,
edit, then `node migration.js`.

## Layout

```
app.js                 Express server: portal, auth, admin API, nft/uci calls
db.js                  JSON-file store (networks.json), atomic writes
migration.js           Optional seed loader (seed/devices.json)
views/                 portal.html, admin.html ({{PLACEHOLDERS}} filled from env)
config/portal.env.example
deploy/                portal.nft.tpl, render-nft.sh, install.sh, init script, healthcheck
seed/devices.example.json
```

## Security notes

- The portal runs as root on the router because it calls `nft` and `uci`. Inputs that reach
  the shell (MACs, IPs, types) are validated; keep it that way when contributing.
- `/admin` and the admin API sit on the same port as the portal and are reachable from every
  portal subnet. The `portal_input` chain only lets permanent-whitelist MACs reach other router
  ports, but the admin key is the only barrier on the portal port itself - use a long random one.
- Captive portals over plain HTTP are not a substitute for WPA/VLAN isolation.
- Never commit `portal.env` or `networks.json`.

## License

MIT - see [LICENSE](LICENSE).
