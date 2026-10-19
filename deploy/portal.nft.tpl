# Captive portal - fw4 custom-rules include (TEMPLATE)
# Rendered by deploy/render-nft.sh into /etc/nftables.d/portal.nft using values
# from portal.env. Tokens wrapped in double at-signs are filled in at render time - do not edit the rendered file by hand.
#
# IMPORTANT: fw4 splices every *.nft file in /etc/nftables.d/ directly INSIDE its
# own single `table inet fw4 { ... }`. Do NOT wrap this content in a
# `table inet fw4 { }` block - that creates an illegal nested table and breaks
# the whole generated ruleset. fw4 keeps filter AND nat chains in this one
# table, so the masquerade rule below is just another chain.

# 1. Sets
set portal_subnets {
    type ifname
    elements = { "@@IF_FAMILY@@", "@@IF_GUEST@@", "@@IF_IOT@@", "@@IF_NATIVE_IOT@@" }
}

set whitelist_throttled { type ether_addr; flags interval; }
set whitelist_guest { type ether_addr; flags interval; }
set whitelist_iot { type ether_addr; flags interval; }
set whitelist_native_iot { type ether_addr; flags interval; }

set permanent_whitelist {
    type ether_addr
    elements = { @@PERMANENT_MACS@@ }
}

# 2. DHCP fix (strip marks to ensure delivery)
chain portal_raw {
    type filter hook prerouting priority -450; policy accept;
    iifname @portal_subnets udp dport { 67, 68 } meta mark set 0 accept
}

# 3. Input chain (router access protection)
chain portal_input {
    type filter hook input priority -150; policy accept;

    iifname @portal_subnets ct state { established, related } accept
    iifname @portal_subnets udp dport { 67, 68, 53, 123 } accept
    iifname @portal_subnets tcp dport 53 accept
    iifname @portal_subnets icmp type { echo-request, echo-reply } accept

    # mDNS for casting discovery
    iifname @portal_subnets udp dport 5353 accept

    # Local portal (Node server)
    iifname @portal_subnets tcp dport @@PORT@@ accept

    # Block all other router access (SSH / LuCI) unless permanently whitelisted
    iifname @portal_subnets ether saddr != @permanent_whitelist drop
}

# 4. Redirection (NAT prerouting)
chain portal_redirect {
    type nat hook prerouting priority -150; policy accept;

    iifname != @portal_subnets return
    ether saddr @permanent_whitelist accept

    # Unauthenticated HTTP on the portal subnets goes to the local portal
    iifname "@@IF_FAMILY@@" ether saddr != @whitelist_throttled tcp dport 80 redirect to :@@PORT@@
    iifname "@@IF_GUEST@@" ether saddr != @whitelist_guest tcp dport 80 redirect to :@@PORT@@
}

# 5. Filtering (forwarding / internet access)
chain portal_filter {
    type filter hook forward priority -150; policy accept;

    iifname != @portal_subnets return
    ct state { established, related } accept
    ether saddr @permanent_whitelist accept

    # Cross-subnet casting: trusted LAN and authorized family devices may reach IoT subnets
    iifname "@@IF_LAN@@" oifname { "@@IF_IOT@@", "@@IF_NATIVE_IOT@@" } accept
    iifname "@@IF_FAMILY@@" ether saddr @whitelist_throttled oifname { "@@IF_IOT@@", "@@IF_NATIVE_IOT@@" } accept

    # Per-subnet authorized internet access
    iifname "@@IF_FAMILY@@" ether saddr @whitelist_throttled accept
    iifname "@@IF_GUEST@@" ether saddr @whitelist_guest accept
    iifname "@@IF_IOT@@" ether saddr @whitelist_iot accept
    iifname "@@IF_NATIVE_IOT@@" ether saddr @whitelist_native_iot accept

    # Drop everything else from portal subnets
    drop
}

# 6. Masquerade portal subnets out the WAN
# If your wan zone already has `option masq '1'` in /etc/config/firewall this
# chain is redundant (harmless, but you can delete it).
chain portal_postrouting {
    type nat hook postrouting priority 100; policy accept;
    oifname "@@WAN_IFACE@@" ip saddr { @@NAT_SUBNETS@@ } masquerade
}
