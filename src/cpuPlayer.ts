import type { Board, Cell, Player } from './types';
import { checkWin, dropPiece } from './gameLogic';

const WIN_SCORE = 1_000_000;

function getValidCols(board: Board): number[] {
  return board[0].map((_, c) => c).filter((c) => board[0][c] === null);
}

function scoreWindow(
  window: Cell[],
  player: Player,
  opponent: Player,
  winLength: number,
): number {
  const p = window.filter((c) => c === player).length;
  const o = window.filter((c) => c === opponent).length;
  const empty = window.filter((c) => c === null).length;

  if (p === winLength) return WIN_SCORE;
  if (o > 0 && p > 0) return 0;
  if (o === winLength - 1 && empty === 1) return -10000;
  if (p === winLength - 1 && empty === 1) return 10000;
  if (p === winLength - 2 && empty === 2) return 100;
  if (p === winLength - 3 && empty === 3) return 10;
  return 0;
}

function scoreBoard(
  board: Board,
  player: Player,
  opponent: Player,
  winLength: number,
): number {
  const rows = board.length;
  const cols = board[0].length;
  let score = 0;

  const directions: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

  for (const [dr, dc] of directions) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const window: Cell[] = [];
        for (let i = 0; i < winLength; i++) {
          const nr = r + dr * i;
          const nc = c + dc * i;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
          window.push(board[nr][nc]);
        }
        if (window.length === winLength) {
          score += scoreWindow(window, player, opponent, winLength);
        }
      }
    }
  }

  // Center column preference
  const centerCol = Math.floor(cols / 2);
  for (let r = 0; r < rows; r++) {
    if (board[r][centerCol] === player) score += 3;
  }

  return score;
}

function minimax(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  isMax: boolean,
  cpu: Player,
  human: Player,
  winLength: number,
): [number, number | null] {
  const winResult = checkWin(board, winLength);
  if (winResult) {
    return winResult.winner === cpu
      ? [WIN_SCORE + depth, null]
      : [-WIN_SCORE - depth, null];
  }

  const validCols = getValidCols(board);
  if (validCols.length === 0 || depth === 0) {
    return [scoreBoard(board, cpu, human, winLength), null];
  }

  let bestCol = validCols[Math.floor(validCols.length / 2)];

  if (isMax) {
    let maxScore = -Infinity;
    for (const col of validCols) {
      const next = dropPiece(board, col, cpu);
      if (!next) continue;
      const [score] = minimax(next, depth - 1, alpha, beta, false, cpu, human, winLength);
      if (score > maxScore) {
        maxScore = score;
        bestCol = col;
      }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return [maxScore, bestCol];
  } else {
    let minScore = Infinity;
    for (const col of validCols) {
      const next = dropPiece(board, col, human);
      if (!next) continue;
      const [score] = minimax(next, depth - 1, alpha, beta, true, cpu, human, winLength);
      if (score < minScore) {
        minScore = score;
        bestCol = col;
      }
      beta = Math.min(beta, score);
      if (alpha >= beta) break;
    }
    return [minScore, bestCol];
  }
}

export function getCpuMove(
  board: Board,
  cpu: Player,
  human: Player,
  winLength: number,
  depth = 4,
): number {
  const [, col] = minimax(board, depth, -Infinity, Infinity, true, cpu, human, winLength);
  const validCols = getValidCols(board);
  return col ?? validCols[Math.floor(validCols.length / 2)];
}
