export type Player = 'p1' | 'p2' | 'p3' | 'p4';
export type PlayerCount = 2 | 3 | 4;
export type Cell = Player | null;
export type Board = Cell[][];
export type GameMode = '2player' | 'cpu' | 'online';
export type GameStatus = 'idle' | 'waiting' | 'playing' | 'won' | 'draw';

export interface GameConfig {
  cols: number;
  rows: number;
  winLength: number;
}

export interface WinResult {
  winner: Player;
  cells: [number, number][];
}

export const DEFAULT_CONFIG: GameConfig = {
  cols: 10,
  rows: 10,
  winLength: 5,
};

// Canvas layout constants
export const CELL = 56;         // px per grid cell
export const PREVIEW_ROWS = 2;  // rows above grid for block preview

export function colsForPlayerCount(n: PlayerCount): number {
  if (n === 3) return 20;
  if (n === 4) return 40;
  return 10;
}
