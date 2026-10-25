// Shared by the browser client and the Render proxy so both always send the exact same query.
const FOOT = 'footway|path|cycleway|steps|bridleway|corridor|track|pedestrian_area';
const DRIVE = 'driveway|parking_aisle|drive-through|emergency_access';

/**
 * Two small queries per chunk instead of one big one (spec §6.2 lists the same features):
 *  - roads: every street the player can use (+ named POIs for landmarks). Small and fast, so the map is playable at once.
 *  - detail: buildings, parks, water, footpaths and driveways. Big, but only needed for looks, so it loads in the background.
 */
export function buildQuery(b, phase) {
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  const body = phase === 'roads' ? `
way["highway"]["highway"!~"^(${FOOT}|proposed|construction|elevator|platform|service)$"](${bb});
way["highway"="service"]["service"!~"^(${DRIVE})$"](${bb});
node["name"]["amenity"](${bb});
node["name"]["tourism"](${bb});
node["name"]["historic"](${bb});
node["name"]["leisure"](${bb});
way["name"]["amenity"](${bb});
way["name"]["tourism"](${bb});
way["name"]["historic"](${bb});
way["name"]["leisure"](${bb});` : `
way["highway"~"^(${FOOT})$"](${bb});
way["highway"="service"]["service"~"^(${DRIVE})$"](${bb});
way["building"](${bb});
way["leisure"~"^(park|garden|playground)$"](${bb});
way["landuse"~"^(grass|forest)$"](${bb});
way["natural"~"^(water|wood)$"](${bb});
way["waterway"="riverbank"](${bb});
relation["type"="multipolygon"]["natural"="water"](${bb});
relation["type"="multipolygon"]["leisure"~"^(park|garden)$"](${bb});
relation["type"="multipolygon"]["landuse"="grass"](${bb});
relation["type"="multipolygon"]["waterway"="riverbank"](${bb});`;
  return `[out:json][timeout:25];(${body}
);out geom qt;`;
}

