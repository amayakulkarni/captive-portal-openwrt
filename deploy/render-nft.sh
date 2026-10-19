#!/bin/sh
# Render deploy/portal.nft.tpl -> /etc/nftables.d/portal.nft from portal.env.
# Runs on the router (POSIX sh / busybox compatible) or on a PC for a dry run:
#
#   sh render-nft.sh [env-file] [output-file]
#   sh render-nft.sh ../config/portal.env.example /dev/stdout     # preview
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-/etc/captive-portal/portal.env}"
OUT="${2:-/etc/nftables.d/portal.nft}"
TPL="$DIR/portal.nft.tpl"

[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

BRIDGE="${BRIDGE:-br-lan}"; WAN_IFACE="${WAN_IFACE:-wan}"; PORT="${PORT:-3000}"
LAN_VLAN="${LAN_VLAN:-1}"; FAMILY_VLAN="${FAMILY_VLAN:-25}"; GUEST_VLAN="${GUEST_VLAN:-100}"
IOT_VLAN="${IOT_VLAN:-75}"; NATIVE_IOT_VLAN="${NATIVE_IOT_VLAN:-125}"
IF_LAN="${IF_LAN:-$BRIDGE.$LAN_VLAN}";       IF_FAMILY="${IF_FAMILY:-$BRIDGE.$FAMILY_VLAN}"
IF_GUEST="${IF_GUEST:-$BRIDGE.$GUEST_VLAN}"; IF_IOT="${IF_IOT:-$BRIDGE.$IOT_VLAN}"
IF_NATIVE_IOT="${IF_NATIVE_IOT:-$BRIDGE.$NATIVE_IOT_VLAN}"

for v in FAMILY_SUBNET GUEST_SUBNET IOT_SUBNET NATIVE_IOT_SUBNET PERMANENT_WHITELIST_MACS; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || { echo "$v is required in $ENV_FILE" >&2; exit 1; }
done

# Validate before anything reaches the firewall
for c in "$FAMILY_SUBNET" "$GUEST_SUBNET" "$IOT_SUBNET" "$NATIVE_IOT_SUBNET"; do
    echo "$c" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' || { echo "bad CIDR: $c" >&2; exit 1; }
done
MACS="$(echo "$PERMANENT_WHITELIST_MACS" | tr -d ' ' | tr 'A-F' 'a-f')"
OLDIFS="$IFS"; IFS=','
for m in $MACS; do
    echo "$m" | grep -Eq '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || { echo "bad MAC in PERMANENT_WHITELIST_MACS: $m" >&2; exit 1; }
done
IFS="$OLDIFS"
MACS_NFT="$(echo "$MACS" | sed 's/,/, /g')"
NAT_SUBNETS="$FAMILY_SUBNET, $GUEST_SUBNET, $IOT_SUBNET, $NATIVE_IOT_SUBNET"

sed -e "s|@@IF_LAN@@|$IF_LAN|g" -e "s|@@IF_FAMILY@@|$IF_FAMILY|g" \
    -e "s|@@IF_GUEST@@|$IF_GUEST|g" -e "s|@@IF_IOT@@|$IF_IOT|g" \
    -e "s|@@IF_NATIVE_IOT@@|$IF_NATIVE_IOT|g" -e "s|@@WAN_IFACE@@|$WAN_IFACE|g" \
    -e "s|@@PORT@@|$PORT|g" -e "s|@@PERMANENT_MACS@@|$MACS_NFT|g" \
    -e "s|@@NAT_SUBNETS@@|$NAT_SUBNETS|g" "$TPL" > "$OUT"

if grep -q '@@' "$OUT"; then echo "unreplaced tokens remain in $OUT" >&2; exit 1; fi
echo "rendered $OUT" >&2
