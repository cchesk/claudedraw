import { PICKUP_RADIUS } from '../config';
import { CHARS } from '../data/characters';
import { stepPlayer } from '../game/frame';
import { initKeyboard, updateKeycaps } from '../input/keyboard';
import { initTouch, resetTouch } from '../input/touch';
import { view } from '../layout';
import { isWalkable, nearestRoadPoint, streetNameAt } from '../map/collision';
import { drawStar, pickScale, renderStatic, paintMap } from '../map/render';
import { spawnNotice } from './loading';
import { clearInput, state } from '../state';
import { avatar } from '../ui/avatar';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
type Nav = (s: 'location' | 'character') => void;

let nav: Nav = () => {};
let canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, mini: HTMLCanvasElement, mctx: CanvasRenderingContext2D;
let staticLayer: HTMLCanvasElement | null = null, staticScale = 0;
let miniLayer: HTMLCanvasElement | null = null;
let vw = 1280, vh = 800, k = 1, zoom = 1, tx = 0, ty = 0;
let last = 0, raf = 0, lastStreet = '', toastTimer = 0, restoreFocus: HTMLElement | null = null;
let walking = false, blocked = false;
const LM_COLORS = ['#C8F04A', '#6EC1FF', '#C8F04A'];

export function initExplore(n: Nav) {
  nav = n;
  canvas = $('#map-canvas'); ctx = canvas.getContext('2d')!;
  mini = $('#minimap'); mctx = mini.getContext('2d')!;
  initKeyboard(() => setPaused(!state.paused));
  initTouch();
  addEventListener('blur', () => { if (state.screen === 'map') { clearInput(); resetTouch(); updateKeycaps(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.screen === 'map') setPaused(true); });
  $('#pause').onclick = () => setPaused(true);
  $('#resume').onclick = () => setPaused(false);
  $('#change-loc').onclick = () => { setPaused(false); resetRun(); nav('location'); };
  $('#change-char').onclick = () => { setPaused(false); resetRun(); nav('character'); };
  $('#paused').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...$('#paused').querySelectorAll<HTMLElement>('button:not([hidden]), a[href]')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { lastEl.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { first.focus(); e.preventDefault(); }
  });
}

function resetRun() {
  state.found = new Set(); state.stamina = 100; state.landmarks = []; state.map = null; staticLayer = null; miniLayer = null;
}

export function setPaused(p: boolean) {
  if (state.screen !== 'map') return;
  if (p === state.paused) return;
  state.paused = p; clearInput(); resetTouch(); updateKeycaps();
  $('#paused').classList.toggle('show', p);
  if (p) { restoreFocus = document.activeElement as HTMLElement | null; $('#resume').focus(); }
  else (restoreFocus && restoreFocus !== document.body ? restoreFocus : $('#pause')).focus({ preventScroll: true });
}

function layoutMetrics() {
  const vp = $('#viewport');
  vw = vp.clientWidth || 1280; vh = vp.clientHeight || 800;
  k = view.stageScale * Math.min(window.devicePixelRatio || 1, 2.5);
  const m = state.map!;
  if (!view.fluid) zoom = 1;
  else zoom = Math.min(1.2, Math.max(0.85, Math.max(vw / m.width, vh / m.height)));
  canvas.width = Math.max(1, Math.round(vw * k)); canvas.height = Math.max(1, Math.round(vh * k));
  const mw = mini.clientWidth || 176, mk = view.stageScale * Math.min(window.devicePixelRatio || 1, 2);
  mini.width = Math.round(mw * mk); mini.height = Math.round((mini.clientHeight || mw) * mk);
  // static layers
  const want = pickScale(m, zoom * k);
  if (!staticLayer || Math.abs(want - staticScale) / staticScale > 0.25) { staticLayer = renderStatic(m, want); staticScale = want; }
  const ml = document.createElement('canvas'); ml.width = mini.width; ml.height = mini.height;
  const c = ml.getContext('2d')!;
  c.scale(ml.width / m.width, ml.height / m.height);
  paintMap(c, m, { labels: false, trees: false, buildings: false, dash: false });
  miniLayer = ml;
}

export function resizeExplore() {
  if (!state.map) return;
  layoutMetrics();
  // A resize must never leave the player off-street.
  if (!isWalkable(state.map, state.pos.x, state.pos.y)) {
    const p = nearestRoadPoint(state.map, state.pos.x, state.pos.y);
    if (p) { state.pos.x = p.x; state.pos.y = p.y; }
  }
  draw();
}

export function enterExplore() {
  const m = state.map;
  if (!m) { nav('location'); return; }
  const c = CHARS[state.char];
  const player = $('#player');
  player.style.setProperty('--c', c.color);
  $('#knob').style.setProperty('--c', c.color);
  player.querySelector('.avatar')!.innerHTML = avatar(state.char, 48);
  const hp = $('#hud-portrait'); hp.style.background = c.tile; hp.innerHTML = avatar(state.char, 32);
  $('#hud-name').textContent = c.name;
  $('#stamina').style.background = c.color;
  state.paused = false; $('#paused').classList.remove('show');
  lastStreet = ''; walking = false; blocked = false;
  staticLayer = null;
  layoutMetrics();
  updateQuest();
  draw();
  document.fonts?.load('500 11px "JetBrains Mono"').then(() => { if (state.screen === 'map' && state.map === m) { staticLayer = null; layoutMetrics(); draw(); } }).catch(() => {});
  if (spawnNotice) toast(spawnNotice, 3600);
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function leaveExplore() {
  cancelAnimationFrame(raf);
  state.paused = false; $('#paused').classList.remove('show');
  resetTouch(); updateKeycaps();
}

function updateQuest() {
  const n = state.found.size, total = state.landmarks.length;
  $('#quest-count').textContent = `${n} / ${total}`;
  $('#quest-title').textContent = n === total && total > 0 ? 'Quest complete!' : `Find ${total} landmarks nearby`;
  $('#quest-bars').innerHTML = state.landmarks.map((_, i) => `<div style="height:6px;border-radius:3px;background:${i < n ? 'var(--lime)' : 'var(--track)'}"></div>`).join('');
}

function toast(msg: string, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

function tick(now: number) {
  raf = requestAnimationFrame(tick);
  if (state.screen !== 'map' || state.paused || !state.map) { last = now; return; }
  const dt = (now - last) / 1000; last = now;
  const m = state.map;
  const body = { x: state.pos.x, y: state.pos.y, stamina: state.stamina, facing: state.facing };
  const r = stepPlayer(m, body, state.char, state.input, dt);
  state.pos.x = body.x; state.pos.y = body.y; state.stamina = body.stamina; state.facing = body.facing;
  blocked = r.blocked;
  walking = r.moving && !r.blocked;

  state.landmarks.forEach((l, i) => {
    if (state.found.has(i) || Math.hypot(l.x - state.pos.x, l.y - state.pos.y) > PICKUP_RADIUS) return;
    state.found.add(i);
    navigator.vibrate?.(40);
    updateQuest();
    toast(state.found.size === state.landmarks.length ? 'Quest complete! All landmarks found' : `Found: ${l.name}`);
  });
  draw(now);
}

function draw(now = 0) {
  const m = state.map; if (!m || !staticLayer) return;
  const { x, y } = state.pos;
  // Camera follows the player, clamps to the map, and centres the map on an axis where it is smaller than the view.
  const ww = m.width * zoom, wh = m.height * zoom;
  tx = ww <= vw ? (vw - ww) / 2 : Math.min(0, Math.max(vw - ww, vw / 2 - x * zoom));
  ty = wh <= vh ? (vh - wh) / 2 : Math.min(0, Math.max(vh - wh, vh / 2 - y * zoom));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0B111C'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k * zoom, 0, 0, k * zoom, k * tx, k * ty);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(staticLayer, 0, 0, m.width, m.height);
  const pulse = Math.sin(now / 400) * 0.5 + 0.5;
  state.landmarks.forEach((l, i) => {
    if (state.found.has(i)) return;
    ctx.strokeStyle = 'rgba(238,242,248,.35)'; ctx.lineWidth = 2; ctx.setLineDash([3, 6]);
    if (l.poiX !== l.x || l.poiY !== l.y) { ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(l.poiX, l.poiY); ctx.stroke(); }
    ctx.setLineDash([]);
    drawStar(ctx, l.x, l.y, LM_COLORS[i % 3], pulse);
  });

  const p = $('#player');
  p.style.transform = `translate(${x * zoom + tx - 48}px, ${y * zoom + ty - 48}px) scale(${zoom})`;
  p.dataset.x = x.toFixed(1); p.dataset.y = y.toFixed(1); // world position, handy for tests
  p.classList.toggle('walking', walking);
  p.classList.toggle('blocked', blocked);
  p.querySelector<HTMLElement>('.arrow')!.style.transform = `rotate(${state.facing + Math.PI / 2}rad)`;

  const sEl = $('#stamina'); sEl.style.width = state.stamina + '%';
  $('#stamina-meter').setAttribute('aria-valuenow', String(Math.round(state.stamina)));
  const name = streetNameAt(m, x, y) || lastStreet;
  if (name !== lastStreet) { $('#street').textContent = name; lastStreet = name; }
  drawMini(m, x, y);
}

function drawMini(m: NonNullable<typeof state.map>, x: number, y: number) {
  if (!miniLayer) return;
  const sx = mini.width / m.width, sy = mini.height / m.height, d = mini.width / (mini.clientWidth || 176);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.drawImage(miniLayer, 0, 0);
  mctx.lineWidth = 1.5 * d; mctx.strokeStyle = '#9AA6BD';
  mctx.strokeRect(-tx / zoom * sx, -ty / zoom * sy, (vw / zoom) * sx, (vh / zoom) * sy);
  state.landmarks.forEach((l, i) => {
    if (state.found.has(i)) return;
    mctx.fillStyle = LM_COLORS[i % 3]; mctx.beginPath(); mctx.arc(l.x * sx, l.y * sy, 4 * d, 0, Math.PI * 2); mctx.fill();
  });
  mctx.fillStyle = CHARS[state.char].color; mctx.strokeStyle = '#0F1521'; mctx.lineWidth = 2 * d;
  mctx.beginPath(); mctx.arc(x * sx, y * sy, 6 * d, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
}
