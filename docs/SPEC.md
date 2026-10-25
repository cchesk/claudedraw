# Street Quest — Build Spec (v1.1)

> **For Claude Code:** Build the game described below. `street-quest.html` is the reference prototype for **look, layout, controls and feel**. Its map is a hand-drawn stand-in. **The real game must render the actual streets around the address the player enters** (§6). Where this spec and the prototype disagree, follow the spec.

---

## 1. Overview

Street Quest is a top-down exploration game for desktop and mobile browsers. The player goes through three steps:

1. **Pick a character.** There are three explorers with different stats.
2. **Pick a location.** The player enters a real address, or uses their current location.
3. **Explore.** The game loads a **real map of that location**, built from OpenStreetMap data. The player walks it with WASD or touch controls to find landmarks.

### Non-negotiable rules

- **Real maps.** The Explore map is generated from real geographic data around the chosen location. That means real street layout, real street names, and real parks, water and buildings. It must never be a generic or fixed layout in production.
- **Streets only.** The character can move only along streets. Buildings, blocks, parks, water, footpaths and off-map areas are never walkable. Collision always enforces this, and no input path (keyboard, joystick, resize, spawn) can put the player off a street.
- **Playable on phones.** The full flow works with touch alone, in portrait and landscape.

**Working title:** "Street Quest" is a placeholder.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Build | Vite + TypeScript |
| UI (screens 1–2, HUD, menus) | Plain TS + DOM, or React. Keep it light. |
| Game view | HTML Canvas 2D, or PixiJS for large maps. Draw roads, blocks and parks from vector data (§6.4). |
| Geocoding / autocomplete | Pluggable provider interface (§6.1). Default to Photon or Nominatim for development. Use a commercial provider (Mapbox, Google, Geoapify) in production. |
| Map data | OpenStreetMap through the Overpass API (§6.2). Cache responses, and use a self-hosted or paid Overpass endpoint in production. |
| Geometry | `@turf/turf` (or hand-rolled) for projection, distance to segment and nearest point. Use a spatial hash for collision lookups. |
| State | One store object (§5). |
| Fonts | Google Fonts: Bricolage Grotesque (600, 800), Inter (400–600), JetBrains Mono (500, 700) |
| Tests | Vitest for logic, Playwright for the flow on desktop and mobile emulation (touch) |

Suggested structure:

```
src/
  main.ts              # boot, layout mode (fixed vs fluid), router
  state.ts
  data/characters.ts
  geo/geocoder.ts      # Geocoder interface + providers
  geo/overpass.ts      # fetch + cache OSM data for a bbox
  geo/project.ts       # lat/lng <-> local metres <-> world px
  map/build.ts         # OSM -> MapModel (roads, areas, POIs, street graph)
  map/collision.ts     # isWalkable, nearestRoadPoint, spatial hash
  map/render.ts        # canvas renderer using the palette
  screens/character.ts
  screens/location.ts
  screens/loading.ts
  screens/explore.ts   # game loop, camera, HUD
  input/keyboard.ts
  input/touch.ts       # floating joystick + RUN button
  ui/avatar.ts
  styles/tokens.css, app.css
```

---

## 3. Design system

### 3.1 Color tokens

| Token | Hex | Use |
|---|---|---|
| `--ink` | `#0F1521` | App background, text on accent fills |
| `--panel` | `#161E2F` | Cards, inputs, lists |
| `--panel-2` | `#1C2236` | Selected card |
| `--raised` | `#222C42` | Icon buttons, idle keycaps |
| `--line` | `#2A3550` | Borders |
| `--track` | `#26314A` | Empty bar track |
| `--text` | `#EEF2F8` | Primary text |
| `--muted` | `#9AA6BD` | Secondary text (passes 4.5:1 on `--ink`) |
| `--lime` | `#C8F04A` | Primary accent, CTAs, quest, Scout |
| `--coral` | `#FF8A65` | Player and pin, Courier, RUN active |
| `--sky` | `#6EC1FF` | Geolocate, focus ring, Tinker |

**Map palette.** Apply it to the real OSM features:

| Feature | Hex |
|---|---|
| Ground and building blocks (`building=*`) | `#172033` ground, `#1F2A42` buildings |
| Tall or commercial buildings (optional, by `building:levels` ≥ 5) | `#22304B` |
| Water (`natural=water`, `waterway=riverbank`) | `#1A2E4A` |
| Parks and green (`leisure=park`, `landuse=grass`, `leisure=garden`) | `#1C3A2E` |
| Trees | `#245040` |
| Footpaths (drawn but **not walkable**) | `#2D5C49` |
| Walkable streets | `#2E3A56` |
| Center dash | `#44527A` |
| Street labels | `#8592AE` |

- **Setup screen background:** `--ink` with a dot grid, `radial-gradient(#1E2740 1.2px, transparent 1.2px)` at a 22px size.
- **HUD panels:** `rgba(15,21,33,.92)`, 1px `--line` border, 18px radius (14px on phones).

### 3.2 Typography

| Role | Font | Desktop | Phone |
|---|---|---|---|
| h1 | Bricolage Grotesque 800, −0.02em | 64px | 40px (32px if height ≤ 520) |
| Logo | Bricolage Grotesque 800, +0.04em, uppercase | 22px | 17px |
| Card name | Bricolage Grotesque 800 | 28px | 24px |
| Lede | Inter 400, `--muted` | 18px | 16px |
| Buttons | Inter 600 | 17px | 17px |
| Labels, steps, keycaps, eyebrows | JetBrains Mono 500–700, uppercase | 11–13px | 10–12px |

Input font size is at least 16px on every screen size, so iOS doesn't zoom in on focus.

### 3.3 Shape, spacing and targets

- **Radii:** cards 22px, inputs and buttons 16px, HUD 18px, keycaps 10px, pills 999px.
- **Touch targets:** at least 44px. Primary buttons are 56px tall. The RUN button is 84px. The joystick base is 136px with a 60px knob.
- **Selected card:** a 2px border in the character color plus a 6px glow at 15% alpha.
- **Focus:** a 3px `--sky` outline at a 3px offset.
- **Safe areas:** every edge-anchored element offsets by `env(safe-area-inset-*)`. Use `viewport-fit=cover`.

### 3.4 Characters

The avatars are geometric SVGs (viewBox `0 0 120 140`): a head circle (r=20), a body shape, and two `--ink` dot eyes.

| Id | Name | Tag | Color | Tile | Body | Speed | Stamina | Luck |
|---|---|---|---|---|---|---|---|---|
| `scout` | Scout | FAST · LIGHT | `#C8F04A` | `#1D2840` | Downward triangle `M26 68 H94 L60 124 Z` | 90 | 45 | 60 |
| `courier` | Courier | STEADY · BALANCED | `#FF8A65` | `#2A2638` | Upward triangle `M60 64 L96 124 H24 Z` | 65 | 70 | 65 |
| `tinker` | Tinker | TOUGH · LUCKY | `#6EC1FF` | `#1B2A3E` | Circle `cx60 cy94 r30` (head cy40) | 40 | 90 | 85 |

Courier is selected by default.

---

## 4. Layout modes

| Mode | When | Behavior |
|---|---|---|
| **Fixed** | Viewport ≥ 900×600 | A 1280×800 stage, centered and scaled by `min(w/1280, h/800)`, letterboxed on `#080C14`. Matches the desktop mockups. |
| **Fluid** | Smaller viewports (phones, small windows) | The stage fills the screen (`position:fixed; inset:0`), and the responsive rules below apply. |

- The page loads in fluid mode first, then measures and switches. This prevents mobile browsers from widening the layout to fit a 1280px stage.
- **Touch UI** is enabled when `(pointer: coarse)` matches or on the first `touchstart`. It is independent of layout mode, so a tablet in fixed mode still gets touch controls.
- Re-run the layout on `resize` and on `orientationchange`.

---

## 5. Screens

### 5.1 Shared header (screens 1–2)

- **Left:** the logo mark (a lime rounded square with an ink triangle) and the wordmark.
- **Right:** three step pills with connectors.
  - **Current:** lime fill, `aria-current="step"`.
  - **Done:** "✓", lime text.
  - **Upcoming:** muted.
- **Fluid mode:** pills show only "01 / ✓ / 03" (the labels are hidden), and connectors are 12px.

### 5.2 Screen 1 — Pick your character

- h1 "Pick your character", with the lede "Each explorer moves through the city a little differently."
- **Cards** are `<button aria-pressed>`. Each contains:
  - A portrait tile (200px tall, 150px on phones).
  - A name and tag row.
  - Three stat meters in the character color.
  - A "SELECTED" badge.
- **Fixed layout:** a 3-column grid with a 28px gap. Cards lift 3px on hover (hover-capable devices only).
- **Fluid layout:** a horizontal scroll-snap carousel. Each card is `min(78%, 320px)` wide and snaps to center, so the next card peeks in at the edge. Tapping a card selects it and scrolls it to center.
- **Footer:**
  - The hint "← → to browse · ENTER to choose" is shown on desktop only.
  - The CTA reads "Continue as {Name} →". In fluid mode it is full width and sticky at the bottom.
- **Keyboard:** ← and → cycle the selection (wrapping), and Enter continues.

### 5.3 Screen 2 — Pick location

- **Fixed layout:** two columns. The left column (520px) holds the title, address field, suggestions and actions. The right column is the map preview.
- **Fluid layout:** a single scrolling column, in the order title → field → suggestions → preview (210px tall) → actions.
- **Address field:**
  - A mono "ADDRESS" label.
  - A 64px field with a search icon, a text input (`enterkeyhint="go"`) and a 44px clear button.
  - On focus, the border turns lime and a glow ring appears.
- **Suggestions** (`role="listbox"`):
  - Up to 5 results from the geocoder (§6.1). Line 1 is the street address, line 2 is the city and region.
  - The last row is always "Use my current location" in sky blue. It calls `navigator.geolocation`, then reverse-geocodes the result.
- **Preview:**
  - Shows the real map around the selected suggestion: a static map image from the provider, or a mini render of the §6 pipeline at low detail.
  - A coral pin with pulse rings marks the point.
  - An overlay card shows "STARTING POINT", the address, and the selected character's avatar and name.
- **Actions:**
  - Back (ghost) returns to screen 1 with the selection kept.
  - "Start exploring →" (primary) is disabled until a geocoded result is selected. Free text alone is not enough.
- Pressing Enter selects the first suggestion and starts.

### 5.4 Loading — "Building your map" (new)

Shown between screens 2 and 3 while §6 runs.

- **Content:** the logo, the address, a progress line, and a spinner or animated street sketch. A spinner is not shown under reduced motion.
- **Progress line:** steps through "Finding streets" → "Drawing the neighborhood" → "Placing landmarks".
- **Errors:** each has a clear message and a Retry or "Pick another location" button.
  - Network failure.
  - Overpass timeout.
  - Fewer than 3 walkable street segments found: "Not enough streets around here — try a more central address."
- **Target:** under 3s on a warm cache, under 8s cold. Cache the built map by rounded lat/lng in IndexedDB.

### 5.5 Screen 3 — Explore

- **Map:** the real neighborhood (§6), drawn in the map palette.
  - Street names come from OSM `name` and are drawn along the road direction.
  - The OSM attribution "© OpenStreetMap contributors" is always visible (mono, 11px, bottom-left above the safe area; it may sit inside the pause menu on phones as well).
- **Camera:**
  - Follows the player and clamps to the map bounds.
  - **Zoom:** in fixed mode, about 1 world px per screen px. In fluid mode, use the larger of 0.85 and the zoom needed to fill the screen, capped at 1.2.
  - If the map is smaller than the viewport on an axis, center it on that axis.
- **Player:**
  - A 96px element: a dashed ring in the character color, a facing triangle that rotates with movement, and a 48px avatar that bobs while walking.
  - The ring flashes red (`#FF5D5D`) while the player pushes into a block (blocked feedback).
- **Landmarks:** star markers on the street in front of real POIs (§6.6).

**HUD positions:**

| Element | Fixed mode | Fluid mode |
|---|---|---|
| Character chip (portrait, name, stamina meter) | Top-left | Top-left, compact (40px portrait, no "STAMINA" label) |
| Street pill (`aria-live="polite"`) | Top-center | Bottom-center above the joystick (184px + safe area). Top-center when height ≤ 520. |
| Pause button and minimap | Top-right, minimap 176px | Top-right, minimap 104px |
| Quest card | Bottom-left (top-left under the chip when touch is on) | Top-left under the chip, 210px wide |
| Keyboard panel (WASD, "Streets only · SHIFT runs") | Bottom-right | Hidden |
| Joystick and RUN button | Shown when touch is on | Shown when touch is on |

- **Minimap:**
  - Shows the real road network at small scale, landmark dots, and the player dot.
  - Draws a viewport rectangle whenever the camera is following.
  - North is always up.
- **Toast:** a lime pill reading "Found: {POI name}" (1.8s), or "Quest complete! All landmarks found" for the last one. On pickup, also call `navigator.vibrate(40)` where supported.
- **Pause:**
  - Opened by Esc, P or the pause button. It opens automatically when the tab is hidden.
  - It is a modal with focus trapped. Buttons: Resume, Change location, Change character.
  - On touch devices it also shows: "Drag on the left side to move. Hold RUN to sprint. You can only walk on streets."
  - Change location and Change character reset the run.

---

## 6. Real map pipeline (required)

The map on screen 3 must come from the location the player chose.

```
address --geocode--> {lat,lng} --Overpass--> OSM ways/nodes --build--> MapModel --render/collide--> game
```

### 6.1 Geocoding

- Use a `Geocoder` interface with three methods: `autocomplete(q)`, `reverse(lat,lng)` and `staticPreview(lat,lng)` (optional). Swap providers through config.
- Debounce autocomplete by 250ms, and cancel in-flight requests with `AbortController`.
- Bias results to the user's location if they have granted it.
- Store the chosen result's `{lat, lng, label}`. That point is the map origin.
- Keep API keys in `VITE_*` env vars, never committed. Follow each provider's rate limits and attribution rules.

### 6.2 Fetching OSM data

- Use a square bounding box centered on the origin. The default half-size is 400m, configurable. If fewer than 3 walkable segments come back, retry once at 700m.
- Use one Overpass query that returns, inside the bbox:
  - `way[highway]`
  - `way[building]`
  - `way[leisure~"park|garden|playground"]`
  - `way[landuse~"grass|forest"]`
  - `way[natural~"water|wood"]`, plus `waterway=riverbank`
  - POI nodes and ways with `amenity`, `tourism`, `historic` or `leisure` (named only)
  - The node geometry for all of the above (`out geom;`)
- Cache by `round(lat,4), round(lng,4), radius` in IndexedDB for 7 days.
- Fall back to the prototype's demo grid **only** when `?demo=1` is set or in tests. It is never a silent fallback in production.

### 6.3 Projection

- Use a local equirectangular projection around the origin:
  - `x = (lng − lng0) · cos(lat0) · 111320 · PX_PER_M`
  - `y = −(lat − lat0) · 110540 · PX_PER_M`
- `PX_PER_M = 2` by default, which makes an 800m box about 1600×1600 world px. Shift coordinates so the bbox's top-left is (0, 0).
- North is up. The map is never rotated.

### 6.4 Building the MapModel

- **Walkable streets.** These are `highway` ways in the **walkable set**, kept in one config constant.
  - **Included:** `residential`, `living_street`, `unclassified`, `tertiary`, `secondary`, `primary`, `pedestrian` (pedestrian streets), `service` (only if `service` is absent or `alley`).
  - **Excluded:** `footway`, `path`, `cycleway`, `steps`, `track`, `bridleway`, `corridor`, `sidewalk` tagging, `motorway`, `trunk` and their `_link`s, any `area=yes`, and `access=private|no`.
  - Excluded footpaths are still **drawn** (thin, `#2D5C49`) so the map looks real, but they are not walkable.
- **Road half-width** (world px, at 2 px/m):

  | Class | Half-width |
  |---|---|
  | primary | 22 |
  | secondary | 20 |
  | tertiary | 18 |
  | residential, unclassified, living_street | 16 |
  | pedestrian | 16 |
  | service | 12 |

  Render each road at half-width + 4px so the walkable band sits visibly inside the asphalt.
- **Street graph.** Split ways into segments. Nodes shared by two or more walkable ways are intersections. Keep the largest connected component and drop disconnected fragments, so the player can never spawn on an island.
- **Areas:** buildings, parks, water and wood become polygons for rendering only.
- **Labels:** street `name`, falling back to `ref`, then "Unnamed road". Place labels along the longest straight run of each named way and keep them upright.

### 6.5 Spawn

- Snap the origin to the nearest point on any walkable segment in the main component. That point is the start position.
- If the nearest walkable point is more than 150m from the origin, show a notice: "Starting at the nearest street, {name}".

### 6.6 Landmarks

- Choose 3 named POIs from the fetched set. Prefer `tourism`, `historic`, `amenity=place_of_worship|library|fountain|cafe|restaurant`.
- The 3 POIs must be at least 120m from the spawn and from each other. Luck slightly biases the choice toward rarer categories.
- Snap each POI to its nearest walkable point. The pickup marker goes there, because the player can only reach streets. Draw a faint dotted tether from the marker to the real POI location.
- If there are fewer than 3 POIs, fill the remaining slots with random street points at least 120m apart, named "Hidden spot".
- The quest title stays "Find 3 landmarks nearby". Toasts use the real POI names.

### 6.7 Rendering

- Pre-render static layers (ground, areas, roads, labels) to an offscreen canvas once, then blit with the camera transform each frame. Draw the player, markers and effects on top.
- For maps larger than about 4096px on a side, use tiles of 1024px.

---

## 7. Movement — streets only

```ts
isWalkable(p): boolean =
  p inside map bounds (inset 20px) AND
  exists walkable segment s: distance(p, s) <= s.halfWidth   // spatial hash, 64px cells
```

Each frame, with input direction **d** (unit vector) and step = speed × dt:

1. **Direct move.** If `isWalkable(p + d·step)`, move there.
2. **Slide along the road.** Otherwise, find the segment the player is on and project **d** onto that segment's direction. If the projected move is walkable, take it. This keeps movement smooth on diagonal and curved real streets. On axis-aligned demo grids, testing X and Y separately is an acceptable equivalent.
3. **Corner assist.** Otherwise, if an intersection node is within 40px and the input points broadly toward a street leaving that node (within 60°), steer toward the node by up to `step`. This makes turns forgiving with a thumb.
4. **Blocked.** Otherwise, don't move and show the red ring.

Invariants (each needs a unit test):

- The position is never set to a point where `isWalkable` is false. This holds on spawn, every frame, after resize, and after a camera or zoom change.
- Large `dt` is clamped to 0.05s, so a frame hitch can't tunnel the player through a block.
- Diagonal input is never faster than straight input.

**Speed and stamina:**

- Speed is `(120 + Speed × 1.2) px/s × (running ? 1.7 : 1) × magnitude`. Magnitude is 1 for keys and the analog joystick value for touch.
- Running requires stamina above 0, and drains `(45 − Stamina × 0.3)/s`.
- Stamina regenerates at 10/s while walking and 18/s while standing still.

**Street readout:**
- Shows the name of the segment the player is on.
- Within 20px of an intersection with a differently named street, it shows "A & B".
- It only updates the DOM when the text changes.

---

## 8. Controls

### 8.1 Keyboard (desktop)

- WASD or the arrow keys move. Shift runs. Esc or P pauses.
- Clear held keys on `blur`, on pause and on screen change.
- Keycaps in the HUD light up coral while held.

### 8.2 Touch (phones and tablets)

- **Floating joystick:**
  - The touch zone is the left 55% of the screen and the bottom 65% of the map view. It sits under the HUD panels, so HUD buttons stay tappable.
  - On `pointerdown`, the base (136px) jumps to the finger and the knob (60px, character color) follows it within a 52px radius.
  - The output is an analog vector with a 0.15 dead zone, rescaled to 0–1.
  - On release, it springs back to its home position (bottom-left, safe-area aware) at 55% opacity.
  - Use pointer events with `setPointerCapture`, and track only the first pointer, so multitouch with RUN works.
- **RUN button:**
  - An 84px circle at bottom-right labelled "RUN / HOLD". It is active while held and turns coral.
  - It is released on `pointerup`, `pointercancel` and `lostpointercapture`. The long-press context menu is suppressed.
- **Page behavior:**
  - The map screen uses `touch-action: none`, `user-select: none` and `-webkit-touch-callout: none`. Setup screens scroll normally.
  - `overscroll-behavior: none` disables pull-to-refresh.
- **Lifecycle:** auto-pause on `visibilitychange` (hidden). Clear joystick and RUN state on pause, blur and screen change.
- **Orientation:** both portrait and landscape are supported, with no rotate prompt.

---

## 9. State

```ts
type CharId = 'scout' | 'courier' | 'tinker';
interface GameState {
  screen: 'character' | 'location' | 'loading' | 'map';
  char: CharId;
  place: { label: string; lat: number; lng: number } | null;
  map: MapModel | null;            // roads, areas, labels, graph, bounds, landmarks
  pos: { x: number; y: number };   // world px; always isWalkable
  facing: number;                  // radians
  stamina: number;                 // 0–100
  found: Set<number>;
  input: { keys: Set<string>; stick: { active: boolean; x: number; y: number }; run: boolean };
  paused: boolean;
}
```

---

## 10. Accessibility

- Use real `<button>`, `<input>` and `<label>` elements. Card selection uses `aria-pressed`. Stats and stamina use `role="meter"`.
- Every icon-only button has an `aria-label`, including Pause, Clear address and RUN. Decorative SVGs are `aria-hidden`.
- Text contrast is at least 4.5:1. Focus is always visible. The pause dialog traps focus and restores it on close.
- `prefers-reduced-motion` disables the bob, the hover lift, the toast slide and the loading animation.
- Pinch-zoom stays enabled. Don't set `maximum-scale`.

---

## 11. Acceptance criteria

**Real maps**
- [ ] Entering two different real addresses (e.g. one dense downtown and one suburban) produces two clearly different maps whose streets, names, parks and water match OpenStreetMap for those places.
- [ ] Street labels and the HUD street pill show real street names.
- [ ] Landmarks are real nearby named places, placed on the nearest street.
- [ ] OSM attribution is visible. Built maps are cached, so a repeat visit loads in under 3s.
- [ ] Loading errors and "not enough streets" show their messages and recovery actions.

**Streets only**
- [ ] The player spawns on a street, even when the address is inside a park or a large building.
- [ ] With keyboard and joystick, holding into any block, building, park, water or footpath never moves the player off the street. A fuzz test that sends random input for 10,000 frames on 3 real cached maps never produces a non-walkable position.
- [ ] Movement slides smoothly along diagonal and curved streets, and turns at intersections are forgiving.

**Mobile**
- [ ] The whole flow is completable by touch alone on a 390×844 portrait phone and on an 844×390 landscape phone. Nothing is clipped, and the layout doesn't widen beyond the screen.
- [ ] The joystick gives analog speed, and holding RUN with the other thumb sprints. Releasing either one always stops it, including when a finger slides off.
- [ ] Switching apps auto-pauses. There is no pull-to-refresh, text selection or callout on the map.
- [ ] HUD elements respect safe areas on notched phones.

**Desktop and general**
- [ ] Fixed mode matches the mockups at 1280×800 and scales correctly at other sizes.
- [ ] The CTA, preview and HUD all reflect the selected character. Start is disabled without a geocoded result.
- [ ] Esc/P pause works. Change location and Change character reset the run.
- [ ] There are no console errors. Vitest covers projection, `isWalkable`, slide and corner assist, the stamina math and spawn snapping. Playwright runs the flow on desktop and on mobile emulation with touch.

---

## 12. Open questions

1. Which geocoding provider should production use, and what is the budget? This sets the rate limits and terms.
2. Is a self-hosted Overpass instance (or a vector-tile service such as MapLibre with OpenFreeMap or MapTiler) acceptable for production traffic? If vector tiles are used for visuals, collision must still come from the same OSM road geometry so they line up.
3. Should progress (found landmarks per place) be saved?
4. Should Luck affect anything beyond POI selection?
5. What is the final name and logo?
