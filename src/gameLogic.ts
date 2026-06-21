import type { Board, Cell, GameConfig, Player, WinResult } from './types';

export function createBoard({ cols, rows }: GameConfig): Board {
  return Array.from({ length: rows }, () => Array<Cell>(cols).fill(null));
}

export function dropPiece(board: Board, col: number, player: Player): Board | null {
  const rows = board.length;
  for (let row = rows - 1; row >= 0; row--) {
    if (board[row][col] === null) {
      const next = board.map((r) => [...r]);
      next[row][col] = player;
      return next;
    }
  }
  return null; // column full
}

export function isColumnFull(board: Board, col: number): boolean {
  return board[0][col] !== null;
}

export function checkWin(board: Board, winLength: number): WinResult | null {
  const rows = board.length;
  const cols = board[0].length;
  const directions: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c]) continue;
      const player = board[r][c] as Player;

      for (const [dr, dc] of directions) {
        const cells: [number, number][] = [[r, c]];
        for (let i = 1; i < winLength; i++) {
          const nr = r + dr * i;
          const nc = c + dc * i;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || board[nr][nc] !== player) break;
          cells.push([nr, nc]);
        }
        if (cells.length === winLength) return { winner: player, cells };
      }
    }
  }
  return null;
}

export function isDraw(board: Board): boolean {
  return board[0].every((cell) => cell !== null);
}
