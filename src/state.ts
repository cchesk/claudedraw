import type { CharId } from './data/characters';
import type { Landmark, MapModel } from './map/types';

export interface Place { label: string; lat: number; lng: number }

export interface GameState {
  screen: 'character' | 'location' | 'loading' | 'map';
  char: CharId;
  place: Place | null;
  map: MapModel | null;
  pos: { x: number; y: number };
  facing: number;
  stamina: number;
  found: Set<number>;
  landmarks: Landmark[];
  input: { keys: Set<string>; stick: { active: boolean; x: number; y: number }; run: boolean };
  paused: boolean;
  touch: boolean;
  demo: boolean;
}

export const state: GameState = {
  screen: 'character',
  char: 'courier',
  place: null,
  map: null,
  pos: { x: 0, y: 0 },
  facing: 0,
  stamina: 100,
  found: new Set(),
  landmarks: [],
  input: { keys: new Set(), stick: { active: false, x: 0, y: 0 }, run: false },
  paused: false,
  touch: false,
  demo: new URLSearchParams(location.search).get('demo') === '1',
};

export function clearInput() {
  state.input.keys.clear();
  state.input.stick.active = false; state.input.stick.x = 0; state.input.stick.y = 0;
  state.input.run = false;
}
