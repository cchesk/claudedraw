import { STICK_RADIUS } from '../config';
import { view } from '../layout';
import { state } from '../state';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
let pointerId: number | null = null;
let origin = { x: 0, y: 0 };

export function resetStick() {
  pointerId = null;
  const st = state.input.stick; st.active = false; st.x = 0; st.y = 0;
  const stick = $('#stick');
  $('#knob').style.transform = '';
  stick.classList.add('idle');
  stick.style.left = ''; stick.style.top = '';
}

export function setRun(on: boolean) {
  state.input.run = on;
  $('#run').classList.toggle('on', on);
}

export function resetTouch() { resetStick(); setRun(false); }

/** Floating joystick on the left of the map + hold-to-run button (spec §8.2). */
export function initTouch() {
  const zone = $('#stick-zone'), stick = $('#stick'), knob = $('#knob'), run = $('#run');
  // Pointer position in stage coordinates (the fixed-mode stage is scaled).
  const local = (e: PointerEvent) => {
    const r = $('#s-map').getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.stageScale, y: (e.clientY - r.top) / view.stageScale };
  };
  zone.addEventListener('pointerdown', (e) => {
    if (state.paused || pointerId !== null) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    pointerId = e.pointerId;
    origin = local(e);
    const st = state.input.stick; st.active = true; st.x = 0; st.y = 0;
    stick.style.left = origin.x + 'px'; stick.style.top = origin.y + 'px';
    stick.classList.remove('idle');
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const p = local(e);
    let vx = p.x - origin.x, vy = p.y - origin.y;
    const d = Math.hypot(vx, vy);
    if (d > STICK_RADIUS) { vx *= STICK_RADIUS / d; vy *= STICK_RADIUS / d; }
    knob.style.transform = `translate(${vx}px, ${vy}px)`;
    state.input.stick.x = vx / STICK_RADIUS; state.input.stick.y = vy / STICK_RADIUS;
  });
  const end = (e: PointerEvent) => { if (e.pointerId === pointerId) resetStick(); };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);

  run.addEventListener('pointerdown', (e) => { e.preventDefault(); run.setPointerCapture(e.pointerId); setRun(true); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) run.addEventListener(t, () => setRun(false));
  run.addEventListener('contextmenu', (e) => e.preventDefault());
  zone.addEventListener('contextmenu', (e) => e.preventDefault());
}
