// Board rules for the "pull everything" game (no physics here, so it stays easy to test).
// Values mirror wireframes/sling-play-mock.html and docs/requirements/2026-10-26_引っぱる操作の本体移行.md.

export type SPlayer = 'p1' | 'p2';
export type SCell = SPlayer | null;
export type SGrid = SCell[][];
export type BlastLevel = 1 | 2 | 3 | 4;

export const COLS = 10;
export const ROWS = 10;
export const WIN_LEN = 5;
export const BOMB_EVERY = 5;   // gummies thrown per bomb

export const NAME: Record<SPlayer, string> = { p1: 'ソーダ', p2: 'オレンジ' };
export const other = (p: SPlayer): SPlayer => (p === 'p1' ? 'p2' : 'p1');

export function emptyGrid(): SGrid {
  return Array.from({ length: ROWS }, () => Array<SCell>(COLS).fill(null));
}

export function topEmpty(grid: SGrid, c: number): number {
  for (let r = ROWS - 1; r >= 0; r--) if (!grid[r][c]) return r;
  return -1;
}

// ぽふ = only that cell; ドン and ドカッ reach one cell up/down/left/right; ドッカーン (gold band) reaches three
export const ARM_LEN: Record<BlastLevel, number> = { 1: 0, 2: 1, 3: 1, 4: 3 };
export const LEVEL_NAME: Record<BlastLevel, string> = { 1: 'ぽふ', 2: 'ドン', 3: 'ドカッ！', 4: 'ドッカーン！！' };
export const levelFromImpact = (impact: number): BlastLevel => (impact < 4.5 ? 1 : impact < 8.5 ? 2 : 3);

// Cells hit by a blast, clipped to the board
export function blastCells(level: BlastLevel, c: number, r: number): [number, number][] {
  const out: [number, number][] = [[r, c]];
  for (let k = 1; k <= ARM_LEN[level]; k++) out.push([r - k, c], [r + k, c], [r, c - k], [r, c + k]);
  return out.filter(([rr, cc]) => rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS);
}

// Gummies above emptied cells drop down. Returns where each moved gummy came from ('row-col' → old row).
export function compact(grid: SGrid): Record<string, number> {
  const from: Record<string, number> = {};
  for (let c = 0; c < COLS; c++) {
    const st: [SPlayer, number][] = [];
    for (let r = ROWS - 1; r >= 0; r--) { const p = grid[r][c]; if (p) st.push([p, r]); }
    for (let r = ROWS - 1; r >= 0; r--) {
      const it = st.shift();
      grid[r][c] = it ? it[0] : null;
      if (it && it[1] !== r) from[`${r}-${c}`] = it[1];
    }
  }
  return from;
}

// First five-in-a-row found for each player
export function findLines(grid: SGrid): Partial<Record<SPlayer, [number, number][]>> {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]] as const, found: Partial<Record<SPlayer, [number, number][]>> = {};
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = grid[r][c]; if (!p || found[p]) continue;
    for (const [dr, dc] of dirs) {
      const cells: [number, number][] = [[r, c]];
      for (let k = 1; k < WIN_LEN; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || grid[rr][cc] !== p) break;
        cells.push([rr, cc]);
      }
      if (cells.length >= WIN_LEN) { found[p] = cells; break; }
    }
  }
  return found;
}

export interface TurnResult { winner: SPlayer | null; cells: [number, number][] | null; draw: boolean; note: string }

// Both complete at once (only possible after a blast): the thrower wins. Only the opponent: self-destruct.
export function judge(grid: SGrid, thrower: SPlayer): TurnResult {
  const lines = findLines(grid), opp = other(thrower);
  const w = lines[thrower] ? thrower : lines[opp] ? opp : null;
  if (w) {
    const note = w !== thrower ? 'じばく！' : lines[opp] ? 'どうじに そろった → なげた人の かち' : '';
    return { winner: w, cells: lines[w] ?? null, draw: false, note };
  }
  return { winner: null, cells: null, draw: grid[0].every(Boolean), note: '' };
}
