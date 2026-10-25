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

`address → Photon geocoder → OpenFreeMap vector tiles (z14, OpenStreetMap data) → World → canvas render + collision`

| Area | Files |
|---|---|
| Geocoder (pluggable, default Photon) | `src/geo/geocoder.ts` |
| Vector tiles: TileJSON, fetch, memo | `src/geo/tiles.ts` |
| Projection | `src/geo/project.ts` |
| Tile decoding + walkable set | `src/map/mvt.ts`, tunables in `src/config.ts` |
| World: chunks, street graph, labels, POIs | `src/map/world.ts` |
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

`tests/fixtures/tiles/*.pbf` are real OpenFreeMap z14 tiles (Boston downtown + neighbours, Arlington MA, a sparse rural
tile); `tests/fixtures/*.json` are small real OSM extracts in Overpass `out geom` shape. Tests never touch the network.

### Configuration

Optional `VITE_*` variables are listed in `.env.example`. No key is needed by default.

### Usage policies

Photon (photon.komoot.io) is a shared community service: requests are debounced (250 ms autocomplete, 600 ms
preview) and cancelled with `AbortController`. OpenFreeMap tiles are static CDN files with long cache lifetimes and are
memoised in memory. For real traffic use a commercial geocoder (`VITE_GEOCODER=geoapify`).

## Map data: OpenFreeMap vector tiles

The public Overpass servers turned out to be too slow and unreliable (some refuse cloud IPs), so the map comes from
[OpenFreeMap](https://openfreemap.org) instead: free, keyless, CDN-served OpenStreetMap vector tiles in the
OpenMapTiles schema (spec §12 q2 allows this). A z14 tile is ~1.8 km wide, 70–500 KB, answers in ~0.3 s and carries
real street names (`transportation_name`), road classes, buildings, parks, water and named POIs.
`src/geo/tiles.ts` finds the current tile URL via TileJSON and fetches tiles; `src/map/mvt.ts` decodes them and applies
the spec §6.4 walkable set to the OpenMapTiles attributes; `World.ingestTile()` welds roads across tile edges.
Tiles stream in as you walk toward an edge. Attribution (© OpenStreetMap contributors · OpenFreeMap · OpenMapTiles) is
shown on the map.

`server/` + `shared/` are a legacy Overpass caching proxy from an earlier iteration. Nothing uses them any more
(the `street-quest-api` Render service can be deleted); the Overpass-shaped `World.ingest()` path is kept for the
committed OSM fixtures and `?demo=1`.

## Deploy (Render Static Site)

`render.yaml` defines the site. Build `npm ci && npm run build`, publish `dist`, auto-deploy on push to `main`.

## Deploy (own server)

`.github/workflows/deploy.yml` also deploys every push to `main` to the apps server: the site at `streetquest.<domain>`,
the proxy at `streetquest-api.<domain>`. The server setup and the reusable deploy workflow live in [`cchesk/infra`](https://github.com/cchesk/infra).
