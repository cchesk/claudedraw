// All tunables live here. The walkable set (spec §6.4) is the single source of truth for "streets only".

export const PX_PER_M = 2;
export const BBOX_HALF_M = 400;
export const BBOX_RETRY_HALF_M = 700;
export const MIN_SEGMENTS = 3;
export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

/** highway=* values the player may walk on. `service` is handled separately (alley only). */
export const WALKABLE_HIGHWAYS: ReadonlySet<string> = new Set([
  'residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'pedestrian', 'service',
]);

/** Footpath-like highways: drawn thin, never walkable. */
export const FOOTPATH_HIGHWAYS: ReadonlySet<string> = new Set([
  'footway', 'path', 'cycleway', 'steps', 'bridleway', 'corridor', 'track', 'pedestrian_area',
]);

/** Road half-width in world px at PX_PER_M = 2 (spec §6.4). */
export const HALF_WIDTH: Readonly<Record<string, number>> = {
  primary: 22, secondary: 20, tertiary: 18, residential: 16, unclassified: 16, living_street: 16, pedestrian: 16, service: 12,
};
export const ROAD_DRAW_EXTRA = 4;

export const BOUNDS_INSET = 20;
export const HASH_CELL = 64;
export const ASSIST_RADIUS = 40;
export const ASSIST_ANGLE = (60 * Math.PI) / 180;
export const MAX_DT = 0.05;
export const PICKUP_RADIUS = 30;
export const LANDMARK_MIN_DIST_PX = 120 * PX_PER_M;
export const FAR_SPAWN_NOTICE_PX = 150 * PX_PER_M;
export const DEAD_ZONE = 0.15;
export const STICK_RADIUS = 52;

export const COLORS = {
  ink: '#0F1521', ground: '#172033', building: '#1F2A42', buildingTall: '#22304B', water: '#1A2E4A', park: '#1C3A2E',
  tree: '#245040', path: '#2D5C49', street: '#2E3A56', dash: '#44527A', label: '#8592AE', otherRoad: '#222B42',
  lime: '#C8F04A', coral: '#FF8A65', sky: '#6EC1FF',
};

// Optional provider config comes from VITE_* env vars. Nothing secret is ever committed.
const env = import.meta.env as Record<string, string | undefined>;
export const GEOCODER = env.VITE_GEOCODER ?? 'photon';
export const GEOAPIFY_KEY = env.VITE_GEOAPIFY_KEY ?? '';
export const PHOTON_URL = env.VITE_PHOTON_URL ?? 'https://photon.komoot.io';
export const OVERPASS_URLS = (env.VITE_OVERPASS_URL ??
  'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.openstreetmap.fr/api/interpreter')
  .split(',').map((s) => s.trim()).filter(Boolean);
