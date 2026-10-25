import { describe, expect, it } from 'vitest';
import { stepPlayer } from '../../src/game/frame';
import { isWalkable } from '../../src/map/collision';
import { findSpawn } from '../../src/map/spawn';
import type { CharId } from '../../src/data/characters';
import { demoMap, FIXTURES, loadFixture, rng } from './helpers';

const KEYS = ['w', 'a', 's', 'd'];

function fuzz(map: ReturnType<typeof demoMap>, seed: number, frames = 10000) {
  const r = rng(seed), chars: CharId[] = ['scout', 'courier', 'tinker'];
  const sp = findSpawn(map)!;
  const body = { x: sp.x, y: sp.y, stamina: 100, facing: 0 };
  expect(isWalkable(map, body.x, body.y)).toBe(true);
  const inp = { keys: new Set<string>(), stick: { active: false, x: 0, y: 0 }, run: false };
  let hold = 0, moved = 0, bad = 0;
  for (let f = 0; f < frames; f++) {
    if (hold-- <= 0) {
      hold = 3 + Math.floor(r() * 60);
      inp.keys.clear();
      if (r() < 0.5) { for (const k of KEYS) if (r() < 0.4) inp.keys.add(k); if (r() < 0.3) inp.keys.add('shift'); inp.stick.active = false; }
      else { const a = r() * Math.PI * 2, m = r(); inp.stick = { active: true, x: Math.cos(a) * m, y: Math.sin(a) * m }; inp.run = r() < 0.3; }
    }
    const px = body.x, py = body.y;
    // frame times include big hitches; the sim clamps them
    stepPlayer(map, body, chars[Math.floor(f / 3500) % 3], inp, r() < 0.05 ? 0.3 : 0.004 + r() * 0.03);
    if (!isWalkable(map, body.x, body.y)) bad++;
    if (Math.hypot(body.x - px, body.y - py) > 0) moved++;
  }
  return { bad, moved };
}

describe('streets-only fuzz (spec §11): random input never yields a non-walkable position', () => {
  for (const name of FIXTURES) {
    it(`10,000 frames on ${name}`, () => {
      const { map } = loadFixture(name);
      const { bad, moved } = fuzz(map, 1234);
      expect(bad).toBe(0);
      expect(moved).toBeGreaterThan(1500); // the player really did travel, not just stand still
    });
  }
  it('10,000 frames on the demo grid, two more seeds on downtown', () => {
    expect(fuzz(demoMap(), 7).bad).toBe(0);
    const { map } = loadFixture('downtown');
    expect(fuzz(map, 99).bad).toBe(0);
    expect(fuzz(map, 2024).bad).toBe(0);
  });
});
