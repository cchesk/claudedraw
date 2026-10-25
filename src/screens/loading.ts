import { OverpassError } from '../geo/overpass';
import { findSpawn, pickLandmarks } from '../map/spawn';
import { loadMap, NotEnoughStreets } from '../map/pipeline';
import { CHARS } from '../data/characters';
import { state } from '../state';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const STEPS = ['Finding streets…', 'Drawing the neighborhood…', 'Placing landmarks…'];
let ctl: AbortController | null = null;
let go: (s: 'location' | 'map') => void = () => {};

export let spawnNotice = '';

async function run() {
  const place = state.place;
  if (!place) { go('location'); return; }
  ctl?.abort();
  const mine = (ctl = new AbortController());
  const scr = $('#s-loading');
  scr.classList.remove('failed');
  $('#loading-error').hidden = true;
  $('#loading-addr').textContent = place.label;
  const step = (n: number) => { $('#loading-step').textContent = STEPS[n]; };
  step(0);
  try {
    const map = await loadMap(place.lat, place.lng, { demo: state.demo, signal: mine.signal, onStep: (n) => step(n) });
    if (mine.signal.aborted) return;
    const spawn = findSpawn(map);
    if (!spawn) throw new NotEnoughStreets();
    step(2);
    state.map = map;
    state.pos = { x: spawn.x, y: spawn.y };
    state.landmarks = pickLandmarks(map, spawn, CHARS[state.char].stats.Luck);
    state.found = new Set();
    state.stamina = 100;
    spawnNotice = spawn.far ? `Starting at the nearest street, ${spawn.street}` : '';
    go('map');
  } catch (e) {
    if (mine.signal.aborted) return;
    let msg = 'Something went wrong while building the map.';
    if (e instanceof NotEnoughStreets) msg = e.message;
    else if (e instanceof OverpassError && e.kind === 'timeout') msg = 'The map server took too long to answer. Please retry in a moment.';
    else if (e instanceof OverpassError) msg = "Couldn't reach the map server. Check your connection and retry.";
    console.warn('map load failed', e);
    $('#loading-msg').textContent = msg + (e instanceof OverpassError ? `\n(${e.detail})` : e instanceof NotEnoughStreets ? '' : `\n(${e instanceof Error ? e.message : e})`);
    $('#loading-error').hidden = false;
    $('#loading-step').textContent = '';
    scr.classList.add('failed');
    $('#loading-retry').hidden = e instanceof NotEnoughStreets;
    ($('#loading-retry').hidden ? $('#loading-other') : $('#loading-retry')).focus();
  }
}

export const startLoading = () => { void run(); };

export function initLoading(nav: (s: 'location' | 'map') => void) {
  go = nav;
  $('#loading-retry').onclick = () => void run();
  $('#loading-other').onclick = () => { ctl?.abort(); go('location'); };
}
