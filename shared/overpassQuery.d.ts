export interface BBox { south: number; west: number; north: number; east: number }
export function buildQuery(b: BBox, phase: 'roads' | 'detail'): string;
