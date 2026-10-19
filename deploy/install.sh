#!/bin/sh
# Run ON THE ROUTER after copying the project to /etc/captive-portal
# and creating /etc/captive-portal/portal.env. Safe to re-run.
set -e

APP_DIR="/etc/captive-portal"
ENV_FILE="$APP_DIR/portal.env"

[ -f "$ENV_FILE" ] || { echo "Create $ENV_FILE first (cp $APP_DIR/config/portal.env.example $ENV_FILE)"; exit 1; }
chmod 600 "$ENV_FILE"

echo "==> Installing Node.js runtime"
opkg update
opkg install node node-npm

echo "==> Installing app dependencies"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Rendering and installing firewall include"
mkdir -p /etc/nftables.d
sh "$APP_DIR/deploy/render-nft.sh" "$ENV_FILE" /etc/nftables.d/portal.nft
service firewall restart
nft list ruleset | grep -c 'chain portal_' | xargs -I{} echo "    {} portal_* chains present (expect 5)"

echo "==> Installing procd service"
cp "$APP_DIR/deploy/captive-portal.init" /etc/init.d/captive-portal
chmod +x /etc/init.d/captive-portal
/etc/init.d/captive-portal enable
/etc/init.d/captive-portal start

echo "==> Done. Check: /etc/init.d/captive-portal status  |  logread -e captive-portal"
