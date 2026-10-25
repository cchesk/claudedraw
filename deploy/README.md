# Deploy to a private server on your tailnet

Every push to `main`, including one Claude makes from the iOS app, runs `.github/workflows/deploy.yml`. The workflow runs
the unit tests, builds the site, joins your tailnet as a short-lived `tag:ci` node, rsyncs `dist/ server/ shared/` to
`/srv/street-quest` over Tailscale SSH, restarts the map proxy and checks `/health`.

The server is reachable only on your tailnet:

| | URL |
|---|---|
| Site (static, served by `tailscale serve`) | `https://<host>.<tailnet>.ts.net` |
| Map proxy (`server/`, systemd `street-quest-api`) | `https://<host>.<tailnet>.ts.net:8443` |

## One-time setup

**1. Tailscale admin console**
- DNS: turn on **MagicDNS** and **HTTPS certificates**.
- Access controls: add the following to the policy file. Keep your existing rules.
  ```jsonc
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
    "tag:ci":     ["autogroup:admin"]
  },
  // Only needed if you replaced the default allow-all "acls"/"grants" rule:
  "grants": [
    { "src": ["tag:ci"], "dst": ["tag:server"], "ip": ["22", "443", "8443"] }
  ],
  "ssh": [
    // keep your existing entries, add:
    { "action": "accept", "src": ["tag:ci"], "dst": ["tag:server"], "users": ["deploy"] }
  ]
  ```
- Settings → OAuth clients → **Generate**: give it the scope *Auth Keys: write* and the tag `tag:ci`. Copy the client
  ID and secret.

**2. Server** (SSH in as root)
```bash
curl -fsSL https://raw.githubusercontent.com/cchesk/claudedraw/main/deploy/setup-server.sh -o setup.sh
sudo bash setup.sh
```
The script installs Node 22, Tailscale and rsync. It creates the `deploy` user and the `street-quest-api` service, runs
`tailscale up --ssh --advertise-tags=tag:server` (open the login URL it prints), configures `tailscale serve`, and
enables ufw with public SSH plus everything on `tailscale0`. At the end it prints the `SITE_URL` to use.

**3. GitHub** → repo Settings → Secrets and variables → Actions
- Secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`
- Variable: `SITE_URL` = `https://<host>.<tailnet>.ts.net` (no trailing slash)

The workflow is skipped while `SITE_URL` is unset. Once everything is set, push to `main` or run it from the Actions tab.

## Notes
- Public access: `sudo tailscale funnel --bg <dir>` and `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:3000`
  expose the same two endpoints to the internet.
- Once Tailscale SSH works, you can close public SSH with `sudo ufw delete allow OpenSSH`. Keep the Hetzner web console
  as a way back in.
- Logs: `journalctl -u street-quest-api -f`. Serve config: `tailscale serve status`.
- The Render deploy in `render.yaml` still runs alongside this one.
