import { GEOAPIFY_KEY, GEOCODER, PHOTON_URL } from '../config';

export interface Place { label: string; line1: string; line2: string; lat: number; lng: number }

export interface Geocoder {
  name: string;
  autocomplete(q: string, signal?: AbortSignal, bias?: { lat: number; lng: number } | null): Promise<Place[]>;
  reverse(lat: number, lng: number, signal?: AbortSignal): Promise<Place | null>;
  staticPreview?(lat: number, lng: number): string | null;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function fromProps(p: Record<string, string | undefined>, lng: number, lat: number): Place {
  const street = p.street ? `${p.housenumber ? p.housenumber + ' ' : ''}${p.street}` : '';
  const line1 = p.name && p.name !== street ? (street && p.type === 'house' ? street : p.name) : street || p.name || 'Unnamed place';
  const line2 = [p.city || p.town || p.village || p.district || p.county, p.state, p.country].filter(Boolean).join(', ');
  const label = [line1, line2].filter(Boolean).join(', ');
  return { label, line1, line2, lat, lng };
}

/** Photon (photon.komoot.io): keyless, OSM-based. Usage policy: be gentle (we debounce + abort). */
export class PhotonGeocoder implements Geocoder {
  name = 'photon';
  constructor(private base = PHOTON_URL) {}
  private map(json: { features?: PhotonFeature[] }): Place[] {
    return (json.features ?? []).map((f) => fromProps(f.properties, f.geometry.coordinates[0], f.geometry.coordinates[1]));
  }
  async autocomplete(q: string, signal?: AbortSignal, bias?: { lat: number; lng: number } | null) {
    const u = new URL('/api/', this.base);
    u.searchParams.set('q', q); u.searchParams.set('limit', '5'); u.searchParams.set('lang', 'en');
    if (bias) { u.searchParams.set('lat', String(bias.lat)); u.searchParams.set('lon', String(bias.lng)); }
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error(`Geocoder ${r.status}`);
    return this.map(await r.json());
  }
  async reverse(lat: number, lng: number, signal?: AbortSignal) {
    const u = new URL('/reverse', this.base);
    u.searchParams.set('lat', String(lat)); u.searchParams.set('lon', String(lng)); u.searchParams.set('lang', 'en');
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error(`Geocoder ${r.status}`);
    return this.map(await r.json())[0] ?? null;
  }
}

/** Optional commercial provider; key comes from VITE_GEOAPIFY_KEY (never committed). */
export class GeoapifyGeocoder implements Geocoder {
  name = 'geoapify';
  constructor(private key: string) {}
  private map(json: { features?: PhotonFeature[] }): Place[] {
    return (json.features ?? []).map((f) => {
      const p = f.properties as Record<string, string | undefined>;
      const [lng, lat] = f.geometry.coordinates;
      const line1 = p.address_line1 ?? p.name ?? 'Unnamed place';
      const line2 = p.address_line2 ?? '';
      return { label: [line1, line2].filter(Boolean).join(', '), line1, line2, lat, lng };
    });
  }
  async autocomplete(q: string, signal?: AbortSignal, bias?: { lat: number; lng: number } | null) {
    const u = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
    u.searchParams.set('text', q); u.searchParams.set('limit', '5'); u.searchParams.set('format', 'geojson'); u.searchParams.set('apiKey', this.key);
    if (bias) u.searchParams.set('bias', `proximity:${bias.lng},${bias.lat}`);
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error(`Geocoder ${r.status}`);
    return this.map(await r.json());
  }
  async reverse(lat: number, lng: number, signal?: AbortSignal) {
    const u = new URL('https://api.geoapify.com/v1/geocode/reverse');
    u.searchParams.set('lat', String(lat)); u.searchParams.set('lon', String(lng)); u.searchParams.set('format', 'geojson'); u.searchParams.set('apiKey', this.key);
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error(`Geocoder ${r.status}`);
    return this.map(await r.json())[0] ?? null;
  }
}

/** Offline stand-in used only behind ?demo=1. */
export class DemoGeocoder implements Geocoder {
  name = 'demo';
  private places: Place[] = [
    { label: '221 Maple Street, Demo City', line1: '221 Maple Street', line2: 'Demo City, Demoland', lat: 40.0, lng: -75.0 },
    { label: '221 Maple Avenue, Demo City', line1: '221 Maple Avenue', line2: 'Demo City, Demoland', lat: 40.0, lng: -75.0 },
  ];
  async autocomplete(q: string) { return q.trim() ? this.places : []; }
  async reverse() { return this.places[0]; }
}

export function createGeocoder(demo: boolean): Geocoder {
  if (demo) return new DemoGeocoder();
  if (GEOCODER === 'geoapify' && GEOAPIFY_KEY) return new GeoapifyGeocoder(GEOAPIFY_KEY);
  return new PhotonGeocoder();
}
