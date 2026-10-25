export type CharId = 'scout' | 'courier' | 'tinker';

export interface Character {
  name: string; tag: string; color: string; tile: string; body: 'down' | 'up' | 'round';
  stats: { Speed: number; Stamina: number; Luck: number };
}

export const CHARS: Record<CharId, Character> = {
  scout: { name: 'Scout', tag: 'FAST · LIGHT', color: '#C8F04A', tile: '#1D2840', body: 'down', stats: { Speed: 90, Stamina: 45, Luck: 60 } },
  courier: { name: 'Courier', tag: 'STEADY · BALANCED', color: '#FF8A65', tile: '#2A2638', body: 'up', stats: { Speed: 65, Stamina: 70, Luck: 65 } },
  tinker: { name: 'Tinker', tag: 'TOUGH · LUCKY', color: '#6EC1FF', tile: '#1B2A3E', body: 'round', stats: { Speed: 40, Stamina: 90, Luck: 85 } },
};
export const ORDER: CharId[] = ['scout', 'courier', 'tinker'];
