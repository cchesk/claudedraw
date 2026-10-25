import { CHARS } from '../data/characters';
import { createGeocoder, type Place } from '../geo/geocoder';
import { view } from '../layout';
import { loadMap } from '../map/pipeline';
import { LOW, paintMap } from '../map/render';
import { state } from '../state';
import { avatar } from '../ui/avatar';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const pinIcon = (c: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-12a7 7 0 0114 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
const geoIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const geocoder = createGeocoder(state.demo);
let results: Place[] = [];
let selected: Place | null = null;
let active = -1;
let bias: { lat: number; lng: number } | null = null;
let searchCtl: AbortController | null = null;
let searchTimer: number | undefined;
let pending: Promise<void> = Promise.resolve();
let previewCtl: AbortController | null = null;
let previewTimer: number | undefined;
let go: (s: 'character' | 'loading') => void = () => {};

function renderList() {
  const sug = $('#suggest');
  const rows = results.map((p, i) =>
    `<button class="opt" type="button" role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}">${pinIcon(i === active ? '#FF8A65' : '#9AA6BD')}<span><b>${esc(p.line1)}</b><small>${esc(p.line2)}</small></span></button>`).join('');
  sug.innerHTML = rows +
    `<button class="opt geo" type="button" data-geo="1">${geoIcon}Use my current location</button>`;
  $('#addr').setAttribute('aria-expanded', String(results.length > 0));
  if (active >= 0) $('#addr').setAttribute('aria-activedescendant', `opt-${active}`); else $('#addr').removeAttribute('aria-activedescendant');
}

function note(msg: string, err = false) { const n = $('#loc-note'); n.textContent = msg; n.classList.toggle('err', err); }

function syncCard() {
  $('#preview-addr').textContent = selected?.label ?? 'No address yet';
  $('#preview-name').textContent = CHARS[state.char].name;
  $('#preview-avatar').innerHTML = avatar(state.char, 40);
  $<HTMLButtonElement>('#start').disabled = !selected;
}

async function drawPreview(p: Place) {
  previewCtl?.abort();
  const ctl = (previewCtl = new AbortController());
  const box = $('#preview'), canvas = $<HTMLCanvasElement>('#preview-canvas');
  box.classList.remove('has-map', 'has-pin');
  $('#preview-empty').textContent = 'Loading a preview of the real streets…';
  try {
    const map = await loadMap(p.lat, p.lng, { demo: state.demo, signal: ctl.signal });
    if (ctl.signal.aborted) return;
    const w = box.clientWidth, h = box.clientHeight, k = view.stageScale * Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k));
    const ctx = canvas.getContext('2d')!;
    const s = Math.max(w, h) / 700;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#172033'; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2 - map.originPx.x * s, h * 0.44 - map.originPx.y * s);
    ctx.scale(s, s);
    paintMap(ctx, map, LOW);
    box.classList.add('has-map', 'has-pin');
  } catch (e) {
    if (ctl.signal.aborted) return;
    $('#preview-empty').textContent = 'Preview unavailable right now. You can still start exploring.';
    console.warn('preview failed', e);
  }
}

function choose(p: Place) {
  selected = p;
  $<HTMLInputElement>('#addr').value = p.label;
  note('');
  syncCard();
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => drawPreview(p), 600);
}

async function search(q: string) {
  searchCtl?.abort();
  const ctl = (searchCtl = new AbortController());
  try {
    const r = await geocoder.autocomplete(q, ctl.signal, bias);
    if (ctl.signal.aborted) return;
    results = r; active = -1; renderList();
    note(r.length ? '' : 'No matches. Try adding a city or a street name.');
  } catch (e) {
    if (ctl.signal.aborted) return;
    note('Address search is unavailable right now. Check your connection and try again.', true);
    console.warn('geocode failed', e);
  }
}

function onInput() {
  const q = $<HTMLInputElement>('#addr').value.trim();
  if (selected && q !== selected.label) { selected = null; syncCard(); }
  clearTimeout(searchTimer);
  if (q.length < 3) { searchCtl?.abort(); results = []; active = -1; renderList(); note(''); return; }
  pending = new Promise<void>((resolve) => {
    searchTimer = window.setTimeout(() => { search(q).finally(resolve); }, 250);
  });
}

function useMyLocation() {
  if (!navigator.geolocation) { note('This browser cannot share a location. Type an address instead.', true); return; }
  note('Finding you…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    bias = { lat, lng };
    let place: Place = { label: `Current location (${lat.toFixed(4)}, ${lng.toFixed(4)})`, line1: 'Current location', line2: '', lat, lng };
    try { const r = await geocoder.reverse(lat, lng); if (r) place = { ...r, lat, lng }; } catch { /* keep coordinates label */ }
    choose(place);
  }, () => note('Location permission was denied. Type an address instead.', true), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

async function startNow() {
  if (!selected) {
    // Enter before results arrive: wait for the pending search, then take the first suggestion.
    clearTimeout(searchTimer);
    const q = $<HTMLInputElement>('#addr').value.trim();
    if (!results.length && q.length >= 3) await search(q);
    if (active < 0 && results[0]) choose(results[0]); else if (results[active]) choose(results[active]);
  }
  if (!selected) return;
  state.place = { label: selected.label, lat: selected.lat, lng: selected.lng };
  go('loading');
}

export function showLocation() {
  syncCard();
  renderList();
  if (!state.touch) $('#addr').focus();
}

export function initLocation(nav: (s: 'character' | 'loading') => void) {
  go = nav;
  const addr = $<HTMLInputElement>('#addr');
  addr.addEventListener('input', onInput);
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) { active = (active + 1) % results.length; renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && results.length) { active = (active - 1 + results.length) % results.length; renderList(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); addr.blur(); void pending.then(startNow); }
  });
  $('#clear').onclick = () => { addr.value = ''; selected = null; results = []; active = -1; previewCtl?.abort(); $('#preview').classList.remove('has-map', 'has-pin'); $('#preview-empty').textContent = 'Pick an address to preview the real streets around it.'; syncCard(); renderList(); note(''); addr.focus(); };
  $('#suggest').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.opt'); if (!b) return;
    if (b.dataset.geo) { useMyLocation(); return; }
    const p = results[Number(b.dataset.i)]; if (p) { active = Number(b.dataset.i); choose(p); renderList(); }
  });
  $('#back').onclick = () => go('character');
  $('#start').onclick = () => void startNow();
  // Bias results to the user's location only if they already granted it (never prompt just for that).
  navigator.permissions?.query({ name: 'geolocation' }).then((r) => {
    if (r.state === 'granted') navigator.geolocation.getCurrentPosition((p) => { bias = { lat: p.coords.latitude, lng: p.coords.longitude }; }, () => {});
  }).catch(() => {});
  renderList(); syncCard();
}
