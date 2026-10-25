import { CHARS, ORDER, type CharId } from '../data/characters';
import { state } from '../state';
import { avatar } from '../ui/avatar';

export function selectChar(id: CharId, scroll = false) {
  state.char = id;
  document.querySelectorAll<HTMLButtonElement>('#cards .card').forEach((b) => {
    const on = b.dataset.id === id;
    b.setAttribute('aria-pressed', String(on));
    if (scroll && on && document.body.classList.contains('fluid')) b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
  document.getElementById('cta-name')!.textContent = CHARS[id].name;
}

export function initCharacter(go: (s: 'location') => void) {
  const cards = document.getElementById('cards')!;
  cards.innerHTML = ORDER.map((id) => {
    const c = CHARS[id];
    const stats = Object.entries(c.stats).map(([k, v]) =>
      `<div class="stat"><span>${k}</span><div class="bar" role="meter" aria-label="${k}" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100"><i style="width:${v}%"></i></div></div>`).join('');
    return `<button class="card" type="button" data-id="${id}" aria-pressed="false" style="--c:${c.color}">
      <span class="badge">SELECTED</span>
      <div class="portrait" style="background:${c.tile}">${avatar(id, 120)}</div>
      <div class="card-head"><span class="card-name">${c.name}</span><span class="card-tag">${c.tag}</span></div>
      <div class="stats">${stats}</div></button>`;
  }).join('');
  cards.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.card');
    if (b) selectChar(b.dataset.id as CharId, true);
  });
  selectChar(state.char);
  document.getElementById('to-location')!.onclick = () => go('location');

  addEventListener('keydown', (e) => {
    if (state.screen !== 'character') return;
    const i = ORDER.indexOf(state.char);
    if (e.key === 'ArrowRight') { selectChar(ORDER[(i + 1) % 3], true); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { selectChar(ORDER[(i + 2) % 3], true); e.preventDefault(); }
    else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button')) go('location');
  });
}
