#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu/Debian box (e.g. Hetzner Cloud) that hosts Street Quest on your tailnet.
#   curl -fsSL https://raw.githubusercontent.com/cchesk/claudedraw/main/deploy/setup-server.sh -o setup.sh
#   sudo bash setup.sh
# Safe to re-run. After it: the site is at https://<host>.<tailnet>.ts.net and the map proxy at :8443.
# GitHub Actions (.github/workflows/deploy.yml) then rsyncs each push to main into /srv/street-quest as `deploy`.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo bash $0)"; exit 1; }

APP=/srv/street-quest
SERVICE=street-quest-api

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl rsync ufw ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

echo "== deploy user and app dir"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
mkdir -p "$APP/dist" "$APP/server" "$APP/shared"
[ -f "$APP/dist/index.html" ] || echo '<!doctype html><title>Street Quest</title><p>Waiting for the first deploy.</p>' > "$APP/dist/index.html"
chown -R deploy:deploy "$APP"
# CI may restart the proxy and nothing else.
echo "deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE" > /etc/sudoers.d/street-quest
chmod 440 /etc/sudoers.d/street-quest

echo "== map proxy service"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Street Quest caching Overpass proxy
After=network-online.target
Wants=network-online.target

[Service]
User=deploy
WorkingDirectory=$APP
Environment=PORT=3000
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null
[ -f "$APP/server/index.mjs" ] && systemctl restart $SERVICE || echo "   (proxy starts after the first deploy)"

echo "== tailscale"
if ! tailscale status >/dev/null 2>&1; then
  echo "   Log in with the URL below. tag:server must exist in your tailnet policy (see deploy/README.md)."
  tailscale up --ssh --advertise-tags=tag:server
else
  tailscale set --ssh
fi
# HTTPS on the tailnet: the static site on 443, the proxy on 8443. Requires MagicDNS + HTTPS certificates enabled.
tailscale serve --bg "$APP/dist"
tailscale serve --bg --https=8443 http://127.0.0.1:3000

echo "== firewall: public SSH stays open as a fallback; everything else only via tailscale"
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null

DNS=$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)
echo
echo "Done. Site:  https://$DNS"
echo "      Proxy: https://$DNS:8443/health"
echo "Set the GitHub repo variable SITE_URL=https://$DNS (see deploy/README.md)."
