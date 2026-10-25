import { describe, expect, it } from 'vitest';
import { clampDt, keyVector, speedFor, stickVector, updateStamina } from '../../src/game/rules';

describe('speed (spec §7)', () => {
  it('(120 + Speed×1.2) × 1.7 when running × magnitude', () => {
    expect(speedFor('courier', false, 1)).toBeCloseTo(198);
    expect(speedFor('courier', true, 1)).toBeCloseTo(198 * 1.7);
    expect(speedFor('scout', false, 0.5)).toBeCloseTo((120 + 108) * 0.5);
  });
  it('diagonal keys are never faster than straight', () => {
    const v = keyVector(new Set(['w', 'd']));
    expect(Math.hypot(v.dx, v.dy)).toBeCloseTo(1);
    expect(keyVector(new Set(['a', 'd'])).mag).toBe(0);
  });
  it('clamps large dt to 0.05s', () => {
    expect(clampDt(1)).toBe(0.05); expect(clampDt(-1)).toBe(0); expect(clampDt(0.016)).toBe(0.016);
  });
});

describe('stamina', () => {
  it('drains (45 − Stamina×0.3)/s while running', () => {
    const r = updateStamina('courier', 100, { moving: true, wantsRun: true }, 1);
    expect(r.running).toBe(true); expect(r.stamina).toBeCloseTo(100 - (45 - 21));
  });
  it('cannot run at 0 stamina, and regenerates 10/s walking, 18/s standing', () => {
    expect(updateStamina('scout', 0, { moving: true, wantsRun: true }, 1)).toEqual({ stamina: 10, running: false });
    expect(updateStamina('scout', 50, { moving: false, wantsRun: true }, 1).stamina).toBeCloseTo(68);
    expect(updateStamina('scout', 50, { moving: true, wantsRun: false }, 1).stamina).toBeCloseTo(60);
  });
  it('stays within 0–100', () => {
    expect(updateStamina('tinker', 99.9, { moving: false, wantsRun: false }, 1).stamina).toBe(100);
    expect(updateStamina('scout', 1, { moving: true, wantsRun: true }, 1).stamina).toBe(0);
  });
});

describe('joystick', () => {
  it('has a 0.15 dead zone and rescales to 0–1', () => {
    expect(stickVector(0.1, 0).mag).toBe(0);
    expect(stickVector(1, 0).mag).toBeCloseTo(1);
    expect(stickVector(0.575, 0).mag).toBeCloseTo(0.5);
    expect(stickVector(0, -0.5).dy).toBeCloseTo(-1);
  });
});
