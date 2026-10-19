#!/bin/sh
# Run ON THE ROUTER after deployment to sanity-check everything came up.
# Usage: sh healthcheck.sh

echo "== procd service =="
/etc/init.d/captive-portal status 2>/dev/null || echo "  (service not registered / not running)"

echo
echo "== node process =="
pgrep -fl "node.*app.js" || echo "  no matching process found"

echo
echo "== portal HTTP =="
curl -s -o /dev/null -w "  local portal -> HTTP %{http_code}\n" http://127.0.0.1:${PORT:-3000}/ || echo "  curl failed"

echo
echo "== nftables portal chains =="
nft list ruleset | grep -c 'chain portal_' | xargs -I{} echo "  {} portal_* chains present (expect 5)"

echo
echo "== whitelist set sizes =="
for s in whitelist_guest whitelist_throttled whitelist_iot whitelist_native_iot permanent_whitelist; do
    count=$(nft list set inet fw4 "$s" 2>/dev/null | grep -c ':')
    echo "  $s: $count entries"
done

echo
echo "== networks.json =="
if [ -f /etc/captive-portal/networks.json ]; then
    count=$(grep -c '"mac"' /etc/captive-portal/networks.json)
    echo "  present, $count device records"
else
    echo "  MISSING — run migration.js or let app.js create it on first write"
fi

echo
echo "== disk space (overlay) =="
df -h /overlay 2>/dev/null || df -h /
