export interface Vec { x: number; y: number }

export interface Segment {
  ax: number; ay: number; bx: number; by: number;
  hw: number;            // walkable half-width
  dx: number; dy: number; // unit direction a->b
  len: number;
  way: number;           // index into MapModel.ways
}

export interface WayInfo { name: string; cls: string; hw: number; nodes: number[] /* intersection ids */ }

export interface Intersection { x: number; y: number; names: string[]; dirs: Vec[] }

export interface Road { pts: Vec[]; cls: string; hw: number; way: number; walkable: boolean; kind: 'street' | 'path' | 'other' }

export type AreaKind = 'grass' | 'wood' | 'water' | 'building' | 'buildingTall';
export interface Area { kind: AreaKind; rings: Vec[][]; bbox: [number, number, number, number]; size: number }

export interface Poi { name: string; x: number; y: number; cat: string; rarity: number }

export interface Landmark { name: string; x: number; y: number; poiX: number; poiY: number; cat: string }

export interface Label { text: string; x: number; y: number; angle: number }

export interface MapModel {
  origin: { lat: number; lng: number };
  width: number; height: number; pxPerM: number;
  roads: Road[];
  areas: Area[];
  labels: Label[];
  pois: Poi[];
  segments: Segment[];
  ways: WayInfo[];
  intersections: Intersection[];
  hash: SpatialHash;
  /** world position of the geocoded origin */
  originPx: Vec;
}

export interface SpatialHash { cell: number; cols: number; rows: number; cells: Int32Array[] | number[][] }
