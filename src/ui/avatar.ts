import { CHARS, type CharId } from '../data/characters';

export function avatar(id: CharId, w: number): string {
  const c = CHARS[id], h = Math.round((w * 140) / 120);
  const head = id === 'tinker' ? 40 : 38;
  const shape = { down: '<path d="M26 68 H94 L60 124 Z"/>', up: '<path d="M60 64 L96 124 H24 Z"/>', round: '<circle cx="60" cy="94" r="30"/>' }[c.body];
  return `<svg width="${w}" height="${h}" viewBox="0 0 120 140" role="img" aria-label="${c.name}"><g fill="${c.color}"><circle cx="60" cy="${head}" r="20"/>${shape}</g>` +
    `<circle cx="53" cy="${head - 2}" r="3" fill="#0F1521"/><circle cx="67" cy="${head - 2}" r="3" fill="#0F1521"/></svg>`;
}
