# Street Quest

A top-down browser game: pick an explorer, type any real address, and walk the **real streets** around it
(OpenStreetMap data) to find nearby landmarks. Desktop (WASD) and phones (floating joystick + hold-to-RUN).

- Spec: [`docs/SPEC.md`](docs/SPEC.md) · Reference prototype: [`docs/prototype.html`](docs/prototype.html)
- Vite + TypeScript static site, no backend. Map © OpenStreetMap contributors.

```
npm ci
npm run dev        # http://localhost:5173  (add ?demo=1 for the offline demo grid)
npm test           # Vitest: projection, isWalkable, slide, corner assist, stamina, spawn, streets-only fuzz
npm run test:e2e   # Playwright: desktop + phone portrait/landscape (touch emulation), network mocked
npm run build      # type-check + production build into dist/
```

## How it works

`address → Photon geocoder → Overpass (bbox ±400 m, retry ±700 m) → MapModel → canvas render + collision`

| Area | Files |
|---|---|
| Geocoder (pluggable, default Photon) | `src/geo/geocoder.ts` |
| Overpass query, IndexedDB cache (7 days), abort, endpoint fallback | `src/geo/overpass.ts` |
| Projection | `src/geo/project.ts` |
| OSM → MapModel (walkable set, street graph, areas, labels, POIs) | `src/map/build.ts`, tunables in `src/config.ts` |
| Streets-only collision (`isWalkable`, slide, corner assist) | `src/map/collision.ts` |
| Spawn snapping and landmarks | `src/map/spawn.ts` |
| Per-frame simulation shared by game and fuzz test | `src/game/frame.ts`, `src/game/rules.ts` |
| Screens and HUD | `src/screens/*`, `src/input/*` |

**Streets only.** The walkable set lives in one constant (`WALKABLE_HIGHWAYS` in `src/config.ts`). Footpaths, parks,
buildings, water and off-map areas are drawn but never walkable; the player position is only ever assigned a point
that passes `isWalkable`.

### Demo / test mode

`?demo=1` swaps the geocoder and Overpass for a built-in synthetic street grid that still goes through the normal
`buildMap` pipeline. It is never a silent fallback: without the flag, failures show an error with Retry.

### Fixtures

`tests/fixtures/*.json` are small real OSM extracts (Boston downtown, Arlington MA suburb, Boston Common/Public Garden),
stored in Overpass `out geom` shape so tests never touch the network. Regenerate with
`node scripts/make-fixture.mjs <name> <lat> <lng> <halfMetres>` (uses the OSM API).

### Configuration

Optional `VITE_*` variables are listed in `.env.example`. No key is needed by default.

### Usage policies

Photon (photon.komoot.io) and the public Overpass servers are shared community services: requests are debounced
(250 ms autocomplete, 600 ms preview), cancelled with `AbortController`, de-duplicated, cached in IndexedDB, and
Overpass calls are spaced ≥1 s apart. For real traffic, point `VITE_OVERPASS_URL` at your own instance and use a
commercial geocoder (`VITE_GEOCODER=geoapify`).

## Map proxy (`server/`)

Public Overpass servers are slow and some refuse cloud IPs, so the site asks a small Node proxy first
(`street-quest-api` on Render, zero dependencies): `GET /overpass?phase=roads|detail&south=&west=&north=&east=`.
It runs the same two fixed queries as the browser (`shared/overpassQuery.js`), caches them in memory for every player
(gzip, LRU, 7 days, serves stale on upstream errors), de-duplicates concurrent requests, hedges across mirrors and
sends a proper User-Agent. `/probe` times each upstream from the server's network (`?urls=a,b` to try others).
If the proxy is slow or down, the browser also asks public Overpass directly after a few seconds.
Configure with `VITE_API_URL` (client) and `OVERPASS_URLS` / `ALLOWED_ORIGINS` (server).

## Deploy (Render Static Site)

`render.yaml` defines the site. Build `npm ci && npm run build`, publish `dist`, auto-deploy on push to `main`.

## Deploy (own server)

`.github/workflows/deploy.yml` also deploys every push to `main` to the apps server: the site at `streetquest.<domain>`,
the proxy at `streetquest-api.<domain>`. The setup is reusable by any repo: [`deploy/README.md`](deploy/README.md).
