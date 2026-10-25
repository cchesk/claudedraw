export interface Vec { x: number; y: number }

export interface Segment {
  ax: number; ay: number; bx: number; by: number;
  hw: number;            // walkable half-width
  dx: number; dy: number; // unit direction a->b
  len: number;
  way: number;           // index into World.ways
  nk: string;            // graph node key of endpoint a (for connectivity)
}

export interface WayInfo { name: string; cls: string; hw: number }

export interface Intersection { x: number; y: number; names: string[]; dirs: Vec[] }

export type BBox4 = [number, number, number, number];

export interface Road { pts: Vec[]; cls: string; hw: number; walkable: boolean; kind: 'street' | 'path' | 'other'; bbox: BBox4 }

export type AreaKind = 'grass' | 'wood' | 'water' | 'building' | 'buildingTall';
export interface Area { kind: AreaKind; rings: Vec[][]; bbox: BBox4; size: number; key: string }

export interface Poi { name: string; x: number; y: number; cat: string; rarity: number; key: string }

export interface Landmark { name: string; x: number; y: number; poiX: number; poiY: number; cat: string; key?: string }

export interface Label { text: string; x: number; y: number; angle: number }

/** Render data for one fetched chunk: every feature intersecting the chunk, in world px. */
export interface Chunk { i: number; j: number; roads: Road[]; areas: Area[] }

export type { World as MapModel } from './world';
