import type { CharId } from '../data/characters';
import { advance, isWalkable } from '../map/collision';
import type { MapModel } from '../map/types';
import { clampDt, keyVector, speedFor, stickVector, updateStamina } from './rules';

export interface Body { x: number; y: number; stamina: number; facing: number }
export interface FrameInput { keys: ReadonlySet<string>; stick: { active: boolean; x: number; y: number }; run: boolean }
export interface FrameResult { moving: boolean; blocked: boolean; running: boolean }

/** One simulation frame: input → speed/stamina → streets-only movement. Shared by the game loop and the fuzz test. */
export function stepPlayer(m: MapModel, b: Body, ch: CharId, inp: FrameInput, rawDt: number): FrameResult {
  const dt = clampDt(rawDt);
  const sv = inp.stick.active ? stickVector(inp.stick.x, inp.stick.y) : { dx: 0, dy: 0, mag: 0 };
  const v = sv.mag > 0 ? sv : keyVector(inp.keys);
  const moving = v.mag > 0;
  const { stamina, running } = updateStamina(ch, b.stamina, { moving, wantsRun: inp.keys.has('shift') || inp.run }, dt);
  b.stamina = stamina;
  let blocked = false;
  if (moving) {
    b.facing = Math.atan2(v.dy, v.dx);
    const r = advance(m, b.x, b.y, v.dx, v.dy, speedFor(ch, running, v.mag) * dt);
    // belt and braces: the position is only ever set to a walkable point
    if (r.moved && isWalkable(m, r.x, r.y)) { b.x = r.x; b.y = r.y; }
    blocked = r.blocked && !r.moved;
  }
  return { moving, blocked, running: running && moving };
}
