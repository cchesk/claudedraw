import { PX_PER_M } from '../config';

export interface Projector { lat0: number; lng0: number; pxPerM: number }

const M_LNG = 111320;
const M_LAT = 110540;

/** Raw local equirectangular projection (spec §6.3), before shifting to the bbox top-left. */
export function rawProject(lat0: number, lng0: number, lat: number, lng: number, pxPerM = PX_PER_M) {
  return {
    x: (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * M_LNG * pxPerM,
    y: -(lat - lat0) * M_LAT * pxPerM,
  };
}

/** The world is unbounded: the geocoded origin is (0,0), +x east, +y south. */
export function makeProjector(lat0: number, lng0: number, pxPerM = PX_PER_M): Projector {
  return { lat0, lng0, pxPerM };
}

export function toWorld(p: Projector, lat: number, lng: number) {
  return rawProject(p.lat0, p.lng0, lat, lng, p.pxPerM);
}

export function toLatLng(p: Projector, x: number, y: number) {
  return {
    lat: p.lat0 - y / (M_LAT * p.pxPerM),
    lng: p.lng0 + x / (Math.cos((p.lat0 * Math.PI) / 180) * M_LNG * p.pxPerM),
  };
}

export interface BBox { south: number; west: number; north: number; east: number }

/** lat/lng bbox of a world-px rectangle (consistent with toWorld, so chunks tile without gaps). */
export function bboxOfRect(p: Projector, x0: number, y0: number, x1: number, y1: number): BBox {
  const nw = toLatLng(p, x0, y0), se = toLatLng(p, x1, y1);
  return { south: se.lat, north: nw.lat, west: nw.lng, east: se.lng };
}

/** Half-extents in degrees of a square of `halfM` metres around lat0. */
export function bboxFor(lat0: number, lng0: number, halfM: number) {
  const dLat = halfM / M_LAT;
  const dLng = halfM / (Math.cos((lat0 * Math.PI) / 180) * M_LNG);
  return { south: lat0 - dLat, north: lat0 + dLat, west: lng0 - dLng, east: lng0 + dLng };
}
