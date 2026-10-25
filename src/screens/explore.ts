import { PICKUP_RADIUS, PX_PER_M } from '../config';
import { CHARS } from '../data/characters';
import { stepPlayer } from '../game/frame';
import { initKeyboard, updateKeycaps } from '../input/keyboard';
import { initTouch, resetTouch } from '../input/touch';
import { view } from '../layout';
import { isWalkable, nearestRoadPoint, streetNameAt } from '../map/collision';
import { chunkFetcher } from '../map/pipeline';
import { drawLabels, drawMinimap, drawStar, pickScale, TileCache } from '../map/render';
import { pickLandmarks } from '../map/spawn';
import { Streamer } from '../map/streamer';
import { clearInput, state } from '../state';
import { avatar } from '../ui/avatar';
import { spawnNotice } from './loading';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
type Nav = (s: 'location' | 'character') => void;

const MINI_RADIUS_PX = 300 * PX_PER_M; // the minimap shows ~300 m around the player
const TILE_BUDGET = 3;                 // tiles rendered per frame at most

let nav: Nav = () => {};
let canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, mini: HTMLCanvasElement, mctx: CanvasRenderingContext2D;
let tiles: TileCache | null = null;
let streamer: Streamer | null = null;
let vw = 1280, vh = 800, k = 1, mk = 1, zoom = 1;
let last = 0, raf = 0, frame = 0, lastStreet = '', toastTimer = 0, questTimer = 0, restoreFocus: HTMLElement | null = null;
let walking = false, blocked = false;
let used = new Set<string>();
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
  stopWorld();
  state.found = new Set(); state.stamina = 100; state.landmarks = []; state.map = null; state.quest = 1;
}

function stopWorld() {
  streamer?.dispose(); streamer = null; tiles = null;
  clearTimeout(questTimer); questTimer = 0;
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
  zoom = view.fluid ? 0.85 : 1;
  canvas.width = Math.max(1, Math.round(vw * k)); canvas.height = Math.max(1, Math.round(vh * k));
  mk = view.stageScale * Math.min(window.devicePixelRatio || 1, 2);
  const mw = mini.clientWidth || 176;
  mini.width = Math.round(mw * mk); mini.height = Math.round((mini.clientHeight || mw) * mk);
  tiles?.setScale(pickScale(zoom * k));
}

export function resizeExplore() {
  if (!state.map) return;
  layoutMetrics();
  // A resize must never leave the player off-street.
  if (!isWalkable(state.map, state.pos.x, state.pos.y)) {
    const p = nearestRoadPoint(state.map, state.pos.x, state.pos.y, state.map.reachable);
    if (p) { state.pos.x = p.x; state.pos.y = p.y; }
  }
  draw();
}

export function enterExplore() {
  const m = state.map;
  if (!m) { nav('location'); return; }
  stopWorld();
  const c = CHARS[state.char];
  const player = $('#player');
  player.style.setProperty('--c', c.color);
  $('#knob').style.setProperty('--c', c.color);
  player.querySelector('.avatar')!.innerHTML = avatar(state.char, 48);
  const hp = $('#hud-portrait'); hp.style.background = c.tile; hp.innerHTML = avatar(state.char, 32);
  $('#hud-name').textContent = c.name;
  $('#stamina').style.background = c.color;
  state.paused = false; $('#paused').classList.remove('show');
  lastStreet = ''; walking = false; blocked = false; frame = 0;
  used = new Set(state.landmarks.map((l) => l.key).filter((x): x is string => !!x));
  tiles = new TileCache(m);
  streamer = new Streamer(m, chunkFetcher(m, state.demo), () => { $('#s-map').dataset.chunks = String(m.chunks.size); });
  $('#s-map').dataset.chunks = String(m.chunks.size);
  layoutMetrics();
  updateQuest();
  draw();
  document.fonts?.load('500 11px "JetBrains Mono"').catch(() => {});
  if (spawnNotice) toast(spawnNotice, 3600);
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function leaveExplore() {
  cancelAnimationFrame(raf);
  stopWorld();
  state.paused = false; $('#paused').classList.remove('show');
  resetTouch(); updateKeycaps();
}

function updateQuest() {
  const n = state.found.size, total = state.landmarks.length;
  $('#quest-label').textContent = state.quest > 1 ? `QUEST ${state.quest}` : 'CURRENT QUEST';
  $('#quest-count').textContent = `${n} / ${total}`;
  $('#quest-title').textContent = n === total && total > 0 ? 'Quest complete!' : `Find ${total} landmarks nearby`;
  $('#quest-bars').innerHTML = state.landmarks.map((_, i) => `<div style="height:6px;border-radius:3px;background:${i < n ? 'var(--lime)' : 'var(--track)'}"></div>`).join('');
}

/** The world is endless: finishing a quest hands out the next one, further out in the already-loaded map. */
function nextQuest() {
  questTimer = 0;
  const m = state.map;
  if (!m || state.screen !== 'map') return;
  state.quest++;
  const lms = pickLandmarks(m, state.pos, CHARS[state.char].stats.Luck, Math.random, { maxDist: 1800, exclude: used });
  for (const l of lms) if (l.key) used.add(l.key);
  state.landmarks = lms; state.found = new Set();
  updateQuest();
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
  if (frame++ % 6 === 0) streamer?.update(state.pos.x, state.pos.y);

  state.landmarks.forEach((l, i) => {
    if (state.found.has(i) || Math.hypot(l.x - state.pos.x, l.y - state.pos.y) > PICKUP_RADIUS) return;
    state.found.add(i);
    navigator.vibrate?.(40);
    updateQuest();
    const done = state.found.size === state.landmarks.length;
    toast(done ? 'Quest complete! All landmarks found' : `Found: ${l.name}`);
    if (done && !questTimer) questTimer = window.setTimeout(nextQuest, 2400);
  });
  draw(now);
}

function setNetNote() {
  const el = $('#net-note');
  const s = streamer, m = state.map;
  const d = s && m ? s.wanted(state.pos.x, state.pos.y)[0]?.d : undefined;
  const show = !!s && d !== undefined && d < 260 && s.status !== 'idle';
  el.hidden = !show;
  if (show) { el.classList.toggle('err', s!.status === 'error'); el.textContent = s!.status === 'error' ? 'Map server is slow, retrying…' : 'Loading more map…'; }
}

function draw(now = 0) {
  const m = state.map; if (!m || !tiles) return;
  const { x, y } = state.pos;
  // Endless map: the camera is always centred on the player.
  const tx = vw / 2 - x * zoom, ty = vh / 2 - y * zoom;
  const rect = { x0: -tx / zoom, y0: -ty / zoom, x1: (vw - tx) / zoom, y1: (vh - ty) / zoom };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#172033'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k * zoom, 0, 0, k * zoom, k * tx, k * ty);
  ctx.imageSmoothingQuality = 'high';
  const T = tiles.px;
  let budget = TILE_BUDGET;
  for (let j = Math.floor(rect.y0 / T); j <= Math.floor(rect.y1 / T); j++) for (let i = Math.floor(rect.x0 / T); i <= Math.floor(rect.x1 / T); i++) {
    const cached = tiles.get(i, j, false);
    const c = cached ?? (budget > 0 ? tiles.get(i, j, true) : null);
    if (!cached && c) budget--;
    if (c) ctx.drawImage(c, i * T - 0.5, j * T - 0.5, T + 1, T + 1);
  }
  drawLabels(ctx, m.labels, rect);

  const pulse = Math.sin(now / 400) * 0.5 + 0.5;
  state.landmarks.forEach((l, i) => {
    if (state.found.has(i)) return;
    if (l.x < rect.x0 - 60 || l.x > rect.x1 + 60 || l.y < rect.y0 - 60 || l.y > rect.y1 + 60) return;
    ctx.strokeStyle = 'rgba(238,242,248,.35)'; ctx.lineWidth = 2; ctx.setLineDash([3, 6]);
    if (l.poiX !== l.x || l.poiY !== l.y) { ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(l.poiX, l.poiY); ctx.stroke(); }
    ctx.setLineDash([]);
    drawStar(ctx, l.x, l.y, LM_COLORS[i % 3], pulse);
  });

  const p = $('#player');
  p.style.transform = `translate(${vw / 2 - 48}px, ${vh / 2 - 48}px) scale(${zoom})`;
  p.dataset.x = x.toFixed(1); p.dataset.y = y.toFixed(1); // world position, handy for tests
  p.classList.toggle('walking', walking);
  p.classList.toggle('blocked', blocked);
  p.querySelector<HTMLElement>('.arrow')!.style.transform = `rotate(${state.facing + Math.PI / 2}rad)`;

  $('#stamina').style.width = state.stamina + '%';
  $('#stamina-meter').setAttribute('aria-valuenow', String(Math.round(state.stamina)));
  const name = streetNameAt(m, x, y) || lastStreet;
  if (name !== lastStreet) { $('#street').textContent = name; lastStreet = name; }
  if (frame % 2 === 0) { drawMini(m, x, y); setNetNote(); }
}

function drawMini(m: NonNullable<typeof state.map>, x: number, y: number) {
  const size = mini.clientWidth || 176, s = size / (2 * MINI_RADIUS_PX);
  mctx.setTransform(mk, 0, 0, mk, 0, 0);
  drawMinimap(mctx, m, x, y, MINI_RADIUS_PX, size);
  // viewport rectangle (the camera always follows the player)
  const rw = (vw / zoom) * s, rh = (vh / zoom) * s;
  mctx.lineWidth = 1.5; mctx.strokeStyle = '#9AA6BD';
  mctx.strokeRect(size / 2 - rw / 2, size / 2 - rh / 2, rw, rh);
  state.landmarks.forEach((l, i) => {
    if (state.found.has(i)) return;
    let dx = (l.x - x) * s, dy = (l.y - y) * s;
    const d = Math.hypot(dx, dy), edge = size / 2 - 7;
    const off = d > edge; if (off) { dx *= edge / d; dy *= edge / d; }
    mctx.globalAlpha = off ? 0.7 : 1;
    mctx.fillStyle = LM_COLORS[i % 3]; mctx.beginPath(); mctx.arc(size / 2 + dx, size / 2 + dy, off ? 3 : 4, 0, Math.PI * 2); mctx.fill();
    mctx.globalAlpha = 1;
  });
  mctx.fillStyle = CHARS[state.char].color; mctx.strokeStyle = '#0F1521'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.arc(size / 2, size / 2, 6, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
}
