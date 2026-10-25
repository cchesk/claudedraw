import { PX_PER_M } from '../config';

export interface Projector {
  lat0: number; lng0: number; pxPerM: number;
  /** world px of the bbox top-left corner, in unshifted projected px */
  offX: number; offY: number;
}

const M_LNG = 111320;
const M_LAT = 110540;

/** Raw local equirectangular projection (spec §6.3), before shifting to the bbox top-left. */
export function rawProject(lat0: number, lng0: number, lat: number, lng: number, pxPerM = PX_PER_M) {
  return {
    x: (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * M_LNG * pxPerM,
    y: -(lat - lat0) * M_LAT * pxPerM,
  };
}

export function makeProjector(lat0: number, lng0: number, halfM: number, pxPerM = PX_PER_M): Projector {
  return { lat0, lng0, pxPerM, offX: -halfM * pxPerM, offY: -halfM * pxPerM };
}

/** lat/lng -> world px, with the bbox's top-left at (0,0). */
export function toWorld(p: Projector, lat: number, lng: number) {
  const r = rawProject(p.lat0, p.lng0, lat, lng, p.pxPerM);
  return { x: r.x - p.offX, y: r.y - p.offY };
}

export function toLatLng(p: Projector, x: number, y: number) {
  const rx = x + p.offX, ry = y + p.offY;
  return {
    lat: p.lat0 - ry / (M_LAT * p.pxPerM),
    lng: p.lng0 + rx / (Math.cos((p.lat0 * Math.PI) / 180) * M_LNG * p.pxPerM),
  };
}

/** Half-extents in degrees of a square of `halfM` metres around lat0. */
export function bboxFor(lat0: number, lng0: number, halfM: number) {
  const dLat = halfM / M_LAT;
  const dLng = halfM / (Math.cos((lat0 * Math.PI) / 180) * M_LNG);
  return { south: lat0 - dLat, north: lat0 + dLat, west: lng0 - dLng, east: lng0 + dLng };
}
