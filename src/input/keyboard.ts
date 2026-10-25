import { state } from '../state';

const KEYMAP: Record<string, string> = { w: 'w', arrowup: 'w', a: 'a', arrowleft: 'a', s: 's', arrowdown: 's', d: 'd', arrowright: 'd' };

export function updateKeycaps() {
  document.querySelectorAll<HTMLElement>('kbd[data-k]').forEach((k) => k.classList.toggle('on', state.input.keys.has(k.dataset.k!)));
}

export function initKeyboard(onPause: () => void) {
  addEventListener('keydown', (e) => {
    if (state.screen !== 'map') return;
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') { if (!e.repeat) onPause(); return; }
    if (state.paused) return;
    if (KEYMAP[k]) { state.input.keys.add(KEYMAP[k]); e.preventDefault(); updateKeycaps(); }
    else if (k === 'shift') state.input.keys.add('shift');
  });
  addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) state.input.keys.delete(KEYMAP[k]);
    if (k === 'shift') state.input.keys.delete('shift');
    updateKeycaps();
  });
}
