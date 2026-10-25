// Usage: node scripts/make-fixture.mjs <name> <lat> <lng> <halfMetres>
// Fetches OSM API 0.6 map XML and converts it to Overpass `out geom` JSON shape.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, latS, lngS, halfS] = process.argv.slice(2);
if (!name || !latS || !lngS || !halfS) {
  console.error('usage: make-fixture.mjs <name> <lat> <lng> <halfMetres>');
  process.exit(1);
}
const lat = +latS, lng = +lngS, halfM = +halfS;
const dLat = halfM / 111320;
const dLng = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(6)).join(',');
const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`;

const xml = execFileSync('curl', ['-sS', '-f', '-m', '120', '-H', 'User-Agent: streetquest-fixture/1.0', url], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});

const KEEP = new Set(['name', 'ref', 'highway', 'area', 'access', 'service', 'tunnel', 'bridge', 'building',
  'building:levels', 'leisure', 'landuse', 'natural', 'waterway', 'amenity', 'tourism', 'historic', 'type',
  'footway', 'layer']);

const unesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
});
const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = unesc(m[2]);
  return o;
};
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// Parse top-level node/way/relation elements.
const nodes = new Map(), ways = new Map(), rels = [];
const elRe = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
for (const m of xml.matchAll(elRe)) {
  const kind = m[1], a = attrs(m[2]), body = m[4] || '';
  const tags = {};
  for (const t of body.matchAll(/<tag\b([^>]*?)\/>/g)) {
    const ta = attrs(t[1]);
    if (KEEP.has(ta.k)) tags[ta.k] = ta.v;
  }
  const id = +a.id;
  if (kind === 'node') {
    nodes.set(id, { id, lat: r6(+a.lat), lon: r6(+a.lon), tags });
  } else if (kind === 'way') {
    const nds = [...body.matchAll(/<nd\b[^>]*?ref="(\d+)"/g)].map((x) => +x[1]);
    ways.set(id, { id, nds, tags });
  } else {
    const members = [...body.matchAll(/<member\b([^>]*?)\/>/g)].map((x) => attrs(x[1]));
    rels.push({ id, members, tags });
  }
}

const geomOf = (w) => w.nds.filter((n) => nodes.has(n)).map((n) => ({ lat: nodes.get(n).lat, lon: nodes.get(n).lon }));
const hasPoi = (t) => t.name && (t.amenity || t.tourism || t.historic || t.leisure);
const wayOk = (t) =>
  t.highway || t.building ||
  ['park', 'garden', 'playground'].includes(t.leisure) ||
  ['grass', 'forest'].includes(t.landuse) ||
  ['water', 'wood'].includes(t.natural) ||
  t.waterway === 'riverbank' || hasPoi(t);
const relOk = (t) =>
  t.type === 'multipolygon' &&
  (t.natural === 'water' || t.leisure === 'park' || t.landuse === 'grass' || t.waterway === 'riverbank');

const elements = [];
for (const w of ways.values()) {
  if (!wayOk(w.tags)) continue;
  const geometry = geomOf(w);
  if (geometry.length < 2) continue;
  elements.push({ type: 'way', id: w.id, nodes: w.nds, geometry, tags: w.tags });
}
for (const n of nodes.values()) {
  if (hasPoi(n.tags)) elements.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags });
}
for (const r of rels) {
  if (!relOk(r.tags)) continue;
  const members = [];
  for (const mb of r.members) {
    if (mb.type !== 'way') continue;
    const w = ways.get(+mb.ref);
    if (!w) continue;
    members.push({ type: 'way', ref: w.id, role: mb.role || '', geometry: geomOf(w) });
  }
  if (members.length) elements.push({ type: 'relation', id: r.id, tags: r.tags, members });
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify({ _meta: { name, lat, lng, halfM }, elements });
writeFileSync(out, json);

const walk = new Set(['residential', 'tertiary', 'secondary', 'primary', 'pedestrian', 'unclassified', 'living_street']);
const els = elements;
console.log(JSON.stringify({
  name, bbox, nodesInXml: nodes.size, bytes: json.length,
  walkableHighways: els.filter((e) => e.type === 'way' && walk.has(e.tags.highway)).length,
  allHighways: els.filter((e) => e.type === 'way' && e.tags.highway).length,
  buildings: els.filter((e) => e.type === 'way' && e.tags.building).length,
  namedPois: els.filter((e) => hasPoi(e.tags)).length,
  waterParkWays: els.filter((e) => e.type === 'way' && (e.tags.natural === 'water' || ['park', 'garden'].includes(e.tags.leisure))).length,
  relations: els.filter((e) => e.type === 'relation').length,
}));
