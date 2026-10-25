import { DEAD_ZONE, MAX_DT } from '../config';
import type { CharId } from '../data/characters';
import { CHARS } from '../data/characters';

export const clampDt = (dt: number) => Math.max(0, Math.min(MAX_DT, dt));

/** Spec §7: (120 + Speed×1.2) px/s × (running ? 1.7 : 1) × magnitude. */
export function speedFor(char: CharId, running: boolean, magnitude: number) {
  return (120 + CHARS[char].stats.Speed * 1.2) * (running ? 1.7 : 1) * magnitude;
}

export interface StaminaIn { moving: boolean; wantsRun: boolean }

/** Running needs stamina > 0 and drains (45 − Stamina×0.3)/s. Regen: 10/s walking, 18/s standing. */
export function updateStamina(char: CharId, stamina: number, inp: StaminaIn, dt: number) {
  const running = inp.moving && inp.wantsRun && stamina > 0;
  let s = stamina;
  if (running) s = Math.max(0, s - dt * (45 - CHARS[char].stats.Stamina * 0.3));
  else s = Math.min(100, s + dt * (inp.moving ? 10 : 18));
  return { stamina: s, running };
}

/** Joystick vector → unit direction and 0–1 magnitude (0.15 dead zone, rescaled). */
export function stickVector(x: number, y: number) {
  const len = Math.hypot(x, y);
  if (len <= DEAD_ZONE) return { dx: 0, dy: 0, mag: 0 };
  return { dx: x / len, dy: y / len, mag: Math.min(1, (len - DEAD_ZONE) / (1 - DEAD_ZONE)) };
}

export function keyVector(keys: ReadonlySet<string>) {
  const dx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
  const dy = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
  const len = Math.hypot(dx, dy);
  return len ? { dx: dx / len, dy: dy / len, mag: 1 } : { dx: 0, dy: 0, mag: 0 };
}
