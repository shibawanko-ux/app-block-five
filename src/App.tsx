import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import type { Board, GameMode, GameStatus, Player, PlayerCount, WinResult } from './types';
import { CELL as BASE_CELL, DEFAULT_CONFIG, PREVIEW_ROWS, colsForPlayerCount } from './types';
import { checkWin, createBoard, isDraw } from './gameLogic';
import { getCpuMove } from './cpuPlayer';
import SlingGame from './sling/SlingGame';
import MuteButton from './sling/MuteButton';
import SoundTest from './sling/SoundTest';
import { starPath, starPoints } from './sling/draw';
import { setMusic } from './sling/sound';
import { COLORS as THEME, FONTS } from './theme';
import {
  createRoom, joinRoom, emitDrop, emitSettle, emitBomb, emitStart, emitSkip,
  subscribeEvent, subscribeAllConnected, subscribeAnyOpponentDisconnect, removeRoom,
  registerDisconnect, leaveRoomAsGuest, subscribeHostDisconnect,
} from './firebase';
import type { RoomEvent } from './firebase';

const { Engine, Bodies, Body, Composite, Events } = Matter;

// ── Turn timer ────────────────────────────────────────────────────────────────
const TURN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_STREAK = 3;

// ── Bomb ──────────────────────────────────────────────────────────────────────
const BOMBS_PER_PLAYER = 1;

interface BombEntry { col: number; row: number; turnsLeft: number; placedBy: Player }

interface ExplodeState {
  frame: number;
  flashCx: number; flashCy: number;
  cells: Array<{ col: number; row: number; player: Player; removeAt: number }>;
  droppers: Array<{ col: number; row: number; toRow: number; player: Player }>;
  REMOVE_END: number;
  DROP_END: number;
  preBoard: Board;
  postBoard: Board;
  onDone: () => void;
}

function createExplodeState(
  explosions: Array<{ col: number; row: number }>,
  preBoard: Board,
  postBoard: Board,
  onDone: () => void,
): ExplodeState {
  const REMOVE_END = 28;
  const DROP_END = 52;
  // Removal schedule: center=2, then 4 cardinal neighbors=14 (cross shape only)
  const ORDER: Array<[number, number, number]> = [
    [0, 0, 2],
    [-1, 0, 14], [1, 0, 14], [0, -1, 14], [0, 1, 14],
  ];

  const cellMap = new Map<string, ExplodeState['cells'][0]>();
  for (const exp of explosions) {
    for (const [dr, dc, removeAt] of ORDER) {
      const r = exp.row + dr, c = exp.col + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS && preBoard[r][c]) {
        const key = `${r}-${c}`;
        if (!cellMap.has(key)) {
          cellMap.set(key, { col: c, row: r, player: preBoard[r][c]!, removeAt });
        }
      }
    }
  }
  const cells = Array.from(cellMap.values());
  const explodedSet = new Set(cells.map(c => `${c.row}-${c.col}`));

  // Compute droppers: blocks that move toward the bottom after explosion
  const droppers: ExplodeState['droppers'] = [];
  for (let c2 = 0; c2 < COLS; c2++) {
    const preBlocks: Array<{ row: number; player: Player }> = [];
    const postBlocks: Array<{ row: number; player: Player }> = [];
    for (let r2 = ROWS - 1; r2 >= 0; r2--) {
      if (preBoard[r2][c2] && !explodedSet.has(`${r2}-${c2}`)) preBlocks.push({ row: r2, player: preBoard[r2][c2]! });
      if (postBoard[r2][c2]) postBlocks.push({ row: r2, player: postBoard[r2][c2]! });
    }
    for (let i = 0; i < Math.min(preBlocks.length, postBlocks.length); i++) {
      if (preBlocks[i].row !== postBlocks[i].row) {
        droppers.push({ col: c2, row: preBlocks[i].row, toRow: postBlocks[i].row, player: preBlocks[i].player });
      }
    }
  }

  return {
    frame: 0,
    flashCx: explosions[0].col * CELL + CELL / 2,
    flashCy: GRID_Y + explosions[0].row * CELL + CELL / 2,
    cells, droppers, REMOVE_END, DROP_END, preBoard, postBoard, onDone,
  };
}

function applyExplosion(board: Board, col: number, row: number): Board {
  const next = board.map(r => [...r]);
  // Remove center + 4 cardinal neighbors (cross shape)
  for (const [dr, dc] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]) {
    const r = row + dr, c = col + dc;
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) next[r][c] = null;
  }
  // Gravity: pack each column toward the bottom
  for (let c = 0; c < COLS; c++) {
    const stack: Player[] = [];
    for (let r = ROWS - 1; r >= 0; r--) { if (next[r][c]) stack.push(next[r][c]!); }
    for (let r = ROWS - 1; r >= 0; r--) { next[r][c] = stack.length ? stack.shift()! : null; }
  }
  return next;
}

// ── Layout ────────────────────────────────────────────────────────────────────
const CFG = DEFAULT_CONFIG;

/**
 * Compute cell size so the canvas fits both width and height of the viewport.
 * totalRows = PREVIEW_ROWS(2) + ROWS(10) = 12.
 * ~100px reserved for turn indicator, gaps, and browser chrome.
 */
function computeCell(cols: number): number {
  if (typeof window === 'undefined') return BASE_CELL;
  // Use 2-player column count (10) as the width reference so the board always
  // fits without shrinking cells. Wider boards (3P/4P) scroll horizontally.
  const refCols    = Math.min(cols, 10);
  const cellByWidth  = Math.floor((window.innerWidth  -  16) / refCols);
  const cellByHeight = Math.floor((window.innerHeight - 100) / 12);
  return Math.max(24, Math.min(BASE_CELL, Math.min(cellByWidth, cellByHeight)));
}

let COLS = CFG.cols;
const ROWS = CFG.rows;
let CELL = computeCell(COLS); // dynamic: shrinks on small screens
let W = COLS * CELL;
let GRID_Y = PREVIEW_ROWS * CELL;
let H = GRID_Y + ROWS * CELL;
let BLOCK = CELL - 8;

function nextTurn(current: Player, playerCount: number): Player {
  const idx = parseInt(current[1]); // 1, 2, 3, 4
  return `p${(idx % playerCount) + 1}` as Player;
}

// ── Colors ────────────────────────────────────────────────────────────────────
const COLOR: Record<Player, string> = {
  p1: THEME.p1.base, p2: THEME.p2.base, p3: '#eab308', p4: '#22c55e',
};

// P3/P4 tones are provisional (DESIGN.md §2: not decided yet)
const GUMMY_TONE: Record<Player, { light: string; base: string; deep: string }> = {
  p1: THEME.p1,
  p2: THEME.p2,
  p3: { light: '#F7D35A', base: '#eab308', deep: '#B88A05' },
  p4: { light: '#5FDB8B', base: '#22c55e', deep: '#16924A' },
};

// factor > 1 = lighter, < 1 = darker (default 1 = no change)
function hexToRgba(hex: string, a: number, factor = 1): string {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor));
  const g = Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor));
  const b = Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor));
  return `rgba(${r},${g},${b},${a})`;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface FallingBlock { body: Matter.Body; player: Player }
interface SquashState { value: number; velocity: number; active: boolean }
interface Confetti {
  x: number; y: number; vx: number; vy: number;
  rotation: number; rotVel: number;
  w: number; h: number; color: string; opacity: number;
}

const CONFETTI_PALETTE: Record<Player | 'draw', string[]> = {
  p1:   [COLOR.p1, THEME.p1.light, THEME.accent, '#ffffff', THEME.sub],
  p2:   [COLOR.p2, THEME.p2.light, THEME.accent, '#ffffff', THEME.sub],
  p3:   [COLOR.p3, '#fde68a', '#fbbf24', '#ffffff', '#f59e0b'],
  p4:   [COLOR.p4, '#86efac', '#fbbf24', '#ffffff', '#34d399'],
  draw: ['#fbbf24', '#f59e0b', '#ffffff', '#94a3b8'],
};

function makeConfetti(winner: Player | null): Confetti {
  const key = winner ?? 'draw';
  const palette = CONFETTI_PALETTE[key];
  return {
    x: Math.random() * W,
    y: -20 - Math.random() * 60,
    vx: (Math.random() - 0.5) * 7,
    vy: Math.random() * 2 + 0.5,
    rotation: Math.random() * Math.PI * 2,
    rotVel: (Math.random() - 0.5) * 0.25,
    w: Math.random() * 9 + 5,
    h: Math.random() * 5 + 3,
    color: palette[Math.floor(Math.random() * palette.length)],
    opacity: 1,
  };
}

interface UIState {
  status: GameStatus;
  currentPlayer: Player;
  winner: Player | null;
  mode: GameMode;
  winResult: WinResult | null;
}

const INIT_UI: UIState = {
  status: 'idle', currentPlayer: 'p1', winner: null, mode: '2player', winResult: null,
};

// ── Draw helpers ──────────────────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Gummy block — translucent jelly body, top/bottom edges, gloss and a per-player mark
// so players can be told apart without relying on color (DESIGN.md §4).
function drawGummy(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  player: Player, alpha = 1,
) {
  const tone = GUMMY_TONE[player];
  const r = Math.min(w, h) * 0.3;
  ctx.save();
  ctx.globalAlpha *= alpha;

  const grad = ctx.createLinearGradient(x, y, x + w * 0.35, y + h);
  grad.addColorStop(0, tone.light);
  grad.addColorStop(0.55, tone.base);
  grad.addColorStop(1, tone.deep);
  ctx.fillStyle = grad;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();

  // Bottom dark edge + top white edge give the "puffy" depth
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y + h - Math.max(3, h * 0.12), w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x, y, w, Math.max(2, h * 0.08));
  ctx.restore();

  // Gloss
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  roundRect(ctx, x + w * 0.18, y + h * 0.12, w * 0.34, h * 0.18, h * 0.09);
  ctx.fill();

  // Player mark
  const cx = x + w / 2, cy = y + h / 2;
  const m = Math.min(w, h);
  ctx.lineCap = 'round';
  if (player === 'p1') {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(2, m * 0.08);
    ctx.beginPath(); ctx.arc(cx, cy, m * 0.19, 0, Math.PI * 2); ctx.stroke();
  } else if (player === 'p2') {
    // ☆ (an × read as "wrong" to kids — DESIGN.md §4)
    ctx.strokeStyle = 'rgba(120,30,10,0.55)';
    ctx.lineWidth = Math.max(2, m * 0.075); ctx.lineJoin = 'round';
    ctx.beginPath();
    starPoints(m * 0.24, m * 0.105).forEach(([px, py], i) => (i ? ctx.lineTo(cx + px, cy + py + m * 0.02) : ctx.moveTo(cx + px, cy + py + m * 0.02)));
    ctx.closePath(); ctx.stroke();
  } else if (player === 'p3') {
    ctx.strokeStyle = 'rgba(90,60,0,0.55)';
    ctx.lineWidth = Math.max(2, m * 0.08);
    const d = m * 0.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy + d * 0.8); ctx.lineTo(cx - d, cy + d * 0.8); ctx.closePath();
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(0,70,30,0.55)';
    ctx.lineWidth = Math.max(2, m * 0.08);
    const d = m * 0.16;
    ctx.strokeRect(cx - d, cy - d, d * 2, d * 2);
  }
  ctx.restore();
}

// Falling block — drawn with physics rotation + squash-and-stretch
function drawRotatedBlock(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, angle: number,
  size: number, player: Player,
  squash = 0,
) {
  const w = size * (1 + squash * 0.8);
  const h = size * (1 - squash);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.shadowBlur = 18;
  ctx.shadowColor = hexToRgba(COLOR[player], 0.6);
  drawGummy(ctx, -w / 2, -h / 2, w, h, player);
  ctx.restore();
}

// Settled block (axis-aligned), optional win glow
function drawSettledBlock(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number,
  size: number, player: Player, isWin: boolean,
) {
  if (isWin) {
    ctx.save();
    ctx.shadowBlur = 16;
    ctx.shadowColor = THEME.accent;
    ctx.strokeStyle = hexToRgba(THEME.accent, 0.9);
    ctx.lineWidth = 3;
    roundRect(ctx, bx + 2, by + 2, size + 4, size + 4, (size + 4) * 0.3);
    ctx.stroke();
    ctx.restore();
  }
  drawGummy(ctx, bx + 4, by + 4, size, size, player);
}

// Bomb — black ball, red fuse, turns-left digit (no emoji: DESIGN.md §4)
function drawBomb(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, turnsLeft: number) {
  ctx.save();
  const g = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.1, cx, cy, radius);
  g.addColorStop(0, '#5a5a5a');
  g.addColorStop(0.6, THEME.bomb);
  g.addColorStop(1, '#111');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = THEME.fuse;
  ctx.lineWidth = Math.max(2, radius * 0.18);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + radius * 0.5, cy - radius * 0.75);
  ctx.quadraticCurveTo(cx + radius * 0.9, cy - radius * 1.3, cx + radius * 1.2, cy - radius * 1.05);
  ctx.stroke();
  ctx.fillStyle = turnsLeft === 1 ? THEME.fuse : THEME.accent;
  ctx.font = `${Math.round(radius * 1.05)}px ${FONTS.logo}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(turnsLeft), cx, cy + radius * 0.08);
  ctx.restore();
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  ui: UIState,
  falling: FallingBlock | null,
  board: Board,
  previewX: number,
  squash = 0,
  confetti: Confetti[] = [],
  textScale = 0,
  remoteFalling: FallingBlock | null = null,
  myOnlineRole: Player | null = null,
  bombs: BombEntry[] = [],
  bombHoverCell: { col: number; row: number } | null = null,
  isBombMode = false,
  explodeAnim: ExplodeState | null = null,
  showGrid = true,
  playerCount: 2 | 3 | 4 = 2,
) {
  // Background — night sky above, glass jar below
  const sky = ctx.createLinearGradient(0, 0, 0, GRID_Y);
  sky.addColorStop(0, THEME.bgTop);
  sky.addColorStop(1, THEME.bg);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, GRID_Y);

  ctx.fillStyle = THEME.jar;
  ctx.fillRect(0, GRID_Y, W, ROWS * CELL);
  const depth = ctx.createLinearGradient(0, H - CELL * 2, 0, H);
  depth.addColorStop(0, 'rgba(0,0,0,0)');
  depth.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = depth;
  ctx.fillRect(0, H - CELL * 2, W, CELL * 2);

  if (showGrid) {
    ctx.strokeStyle = THEME.jarLine;
    ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * CELL, GRID_Y); ctx.lineTo(c * CELL, H); ctx.stroke();
    }
    for (let r = 1; r < ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, GRID_Y + r * CELL); ctx.lineTo(W, GRID_Y + r * CELL); ctx.stroke();
    }
  }

  // Jar rim and glass reflection
  ctx.strokeStyle = THEME.glass;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(1, GRID_Y); ctx.lineTo(1, H - 1); ctx.lineTo(W - 1, H - 1); ctx.lineTo(W - 1, GRID_Y); ctx.stroke();
  const shine = ctx.createLinearGradient(0, GRID_Y, 0, H);
  shine.addColorStop(0, 'rgba(255,255,255,0.18)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  roundRect(ctx, 6, GRID_Y + 10, 5, ROWS * CELL * 0.7, 2.5);
  ctx.fill();

  const isHumanTurn =
    ui.status === 'playing' && !falling &&
    !(ui.mode === 'cpu' && ui.currentPlayer === 'p2') &&
    !(ui.mode === 'online' && myOnlineRole !== null && ui.currentPlayer !== myOnlineRole);

  if (isHumanTurn && !isBombMode) {
    const clr = COLOR[ui.currentPlayer];
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = hexToRgba(clr, 0.65);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(previewX, 4 + BLOCK); ctx.lineTo(previewX, GRID_Y); ctx.stroke();
    ctx.setLineDash([]);

    drawGummy(ctx, previewX - BLOCK / 2, 4, BLOCK, BLOCK, ui.currentPlayer, 0.6);

    // Landing preview: the cell this drop would fill if it falls straight down
    const col = Math.max(0, Math.min(COLS - 1, Math.floor(previewX / CELL)));
    let landRow = -1;
    for (let r = ROWS - 1; r >= 0; r--) { if (!board[r][col]) { landRow = r; break; } }
    if (landRow >= 0) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = clr;
      ctx.fillStyle = hexToRgba(clr, 0.16);
      ctx.lineWidth = 2;
      roundRect(ctx, col * CELL + 4, GRID_Y + landRow * CELL + 4, BLOCK, BLOCK, BLOCK * 0.3);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Settled blocks (with optional explosion animation)
  const winSet = new Set((ui.winResult?.cells ?? []).map(([r, c]) => `${r}-${c}`));
  if (!explodeAnim) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = board[r][c];
        if (!cell) continue;
        drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, cell, winSet.has(`${r}-${c}`));
      }
    }
  } else {
    const { frame, cells, droppers, REMOVE_END, DROP_END, preBoard, postBoard, flashCx, flashCy } = explodeAnim;
    const FADE_DUR = 6;
    if (frame < REMOVE_END) {
      const cellLookup = new Map<string, typeof cells[0]>();
      for (const cd of cells) cellLookup.set(`${cd.row}-${cd.col}`, cd);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = preBoard[r][c];
          if (!cell) continue;
          const key = `${r}-${c}`;
          const cd = cellLookup.get(key);
          if (!cd) {
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, cell, winSet.has(key));
          } else if (frame < cd.removeAt) {
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, cell, false);
          } else if (frame < cd.removeAt + FADE_DUR) {
            ctx.globalAlpha = 1 - (frame - cd.removeAt) / FADE_DUR;
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, cell, false);
            ctx.globalAlpha = 1;
          }
        }
      }
      const flashFade = Math.max(0, 1 - frame / (REMOVE_END * 0.75));
      const flashRadius = CELL * 0.7 + frame * (CELL * 0.18);
      if (flashFade > 0) {
        const g = ctx.createRadialGradient(flashCx, flashCy, 0, flashCx, flashCy, flashRadius);
        g.addColorStop(0, `rgba(255,220,60,${flashFade.toFixed(2)})`);
        g.addColorStop(0.4, `rgba(255,80,10,${(flashFade * 0.8).toFixed(2)})`);
        g.addColorStop(1, 'rgba(255,30,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(flashCx, flashCy, flashRadius, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      const t = Math.min(1, (frame - REMOVE_END) / (DROP_END - REMOVE_END));
      const ease = 1 - (1 - t) * (1 - t);
      const dropperKeys = new Set(droppers.map(d => `${d.toRow}-${d.col}`));
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = postBoard[r][c];
          if (!cell) continue;
          if (dropperKeys.has(`${r}-${c}`)) continue;
          drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, cell, winSet.has(`${r}-${c}`));
        }
      }
      for (const d of droppers) {
        const fromY = GRID_Y + d.row * CELL;
        const toY = GRID_Y + d.toRow * CELL;
        drawSettledBlock(ctx, d.col * CELL, fromY + (toY - fromY) * ease, BLOCK, d.player, false);
      }
    }
  }

  // Bomb hover highlight
  if (bombHoverCell) {
    const bx = bombHoverCell.col * CELL;
    const by = GRID_Y + bombHoverCell.row * CELL;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    roundRect(ctx, bx + 3, by + 3, CELL - 6, CELL - 6, (CELL - 6) * 0.3);
    ctx.stroke();
    ctx.strokeStyle = THEME.fuse;
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    roundRect(ctx, bx + 3, by + 3, CELL - 6, CELL - 6, (CELL - 6) * 0.3);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Bombs drawn on top of settled blocks
  for (const bomb of bombs) {
    const cx = bomb.col * CELL + CELL / 2;
    const cy = GRID_Y + bomb.row * CELL + CELL / 2;
    drawBomb(ctx, cx, cy, BLOCK * 0.36, bomb.turnsLeft);
  }

  // Falling block — draw only the "active" body once (remoteFalling is same body as falling in online mode)
  const drawnBody = falling ?? remoteFalling;
  if (drawnBody) {
    const { x, y } = drawnBody.body.position;
    const appliedSquash = falling ? squash : 0;
    drawRotatedBlock(ctx, x, y, drawnBody.body.angle, BLOCK, drawnBody.player, appliedSquash);
  }

  // ── Win / Draw overlay ───────────────────────────────────────────────────
  if (ui.status === 'won' || ui.status === 'draw') {
    ctx.fillStyle = hexToRgba(THEME.bg, 0.62);
    ctx.fillRect(0, 0, W, H);

    for (const p of confetti) {
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 1);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (textScale > 0.01) {
      ctx.save();
      ctx.translate(W / 2, H / 2 - 24);
      ctx.scale(textScale, textScale);

      const winColor = ui.status === 'won' && ui.winner ? COLOR[ui.winner] : THEME.accent;
      const winLabel = ui.status === 'draw'
        ? 'DRAW'
        : ui.winner === 'p1' ? 'PLAYER 1'
        : ui.winner === 'p2' ? (ui.mode === 'cpu' ? 'CPU' : 'PLAYER 2')
        : ui.winner === 'p3' ? 'PLAYER 3'
        : 'PLAYER 4';

      ctx.shadowBlur = 70;
      ctx.shadowColor = winColor;
      ctx.fillStyle = winColor;
      ctx.font = `68px ${FONTS.logo}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(winLabel, 0, 0);

      if (ui.status === 'won') {
        ctx.shadowBlur = 24;
        ctx.shadowColor = '#ffffff';
        ctx.fillStyle = '#f8fafc';
        ctx.font = `34px ${FONTS.logo}`;
        ctx.fillText('WINS!', 0, 64);

        // Loser display — all players except winner
        const allP = (['p1', 'p2', 'p3', 'p4'] as Player[]).slice(0, playerCount);
        const losers = allP.filter(p => p !== ui.winner);
        if (losers.length > 0) {
          const loseY = 120;
          const spread = Math.min(110, (W * 0.45) / Math.max(1, losers.length - 1 || 1));
          const startX = -(losers.length - 1) * spread / 2;
          losers.forEach((p, i) => {
            const tx = startX + i * spread;
            const lLabel = p === 'p2' && ui.mode === 'cpu' ? 'CPU'
              : p === 'p1' ? 'PLAYER 1'
              : p === 'p2' ? 'PLAYER 2'
              : p === 'p3' ? 'PLAYER 3'
              : 'PLAYER 4';
            ctx.globalAlpha = 0.7;
            ctx.shadowBlur = 10; ctx.shadowColor = COLOR[p];
            ctx.fillStyle = COLOR[p];
            ctx.font = `22px ${FONTS.logo}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(lLabel, tx, loseY);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#94a3b8';
            ctx.font = `15px ${FONTS.logo}`;
            ctx.fillText('LOSES', tx, loseY + 27);
            ctx.globalAlpha = 1;
          });
        }
      }

      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const fallingRef = useRef<FallingBlock | null>(null);
  const boardRef = useRef<Board>(createBoard(CFG));
  const settledCntRef = useRef(0);
  const previewXRef = useRef(W / 2);
  const animRef = useRef(0);

  const squashRef = useRef<SquashState>({ value: 0, velocity: 0, active: false });
  const confettiRef = useRef<Confetti[]>([]);
  const winAnimRef = useRef({ textScale: 0, textScaleVel: 0, frame: 0 });

  const uiRef = useRef<UIState>(INIT_UI);
  const [ui, setUi] = useState<UIState>(INIT_UI);
  // "ふたりで" now plays the pull-everything game (docs/requirements/2026-10-26_引っぱる操作の本体移行.md)
  const [slingOn, setSlingOn] = useState<false | '2player' | 'cpu'>(false);
  // BGM: the menu tune on menus, the play tune while a game is on screen (starts after the first touch)
  useEffect(() => {
    setMusic(slingOn || ui.status === 'playing' || ui.status === 'won' || ui.status === 'draw' ? 'play' : 'menu');
  }, [slingOn, ui.status]);
  const gameIdRef = useRef(0);   // bumps on start/quit so stale CPU timers don't move in a new game
  const [askQuit, setAskQuit] = useState(false);

  // ── Online multiplayer state ───────────────────────────────────────────────
  const onlineRef = useRef<{
    roomCode: string;
    myRole: Player;
    unsubEvent: (() => void) | null;
    unsubAllConnected: (() => void) | null;
    unsubDisconnect: (() => void) | null;
    unsubHostWait: (() => void) | null;
  }>({ roomCode: '', myRole: 'p1', unsubEvent: null, unsubAllConnected: null, unsubDisconnect: null, unsubHostWait: null });

  const remoteBodyRef = useRef<FallingBlock | null>(null);
  const floorBodyRef = useRef<Matter.Body | null>(null);
  const rightWallBodyRef = useRef<Matter.Body | null>(null);

  // ── Turn timer state ───────────────────────────────────────────────────────
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutStreakRef = useRef<Record<Player, number>>({ p1: 0, p2: 0, p3: 0, p4: 0 });
  const playerCountRef = useRef<PlayerCount>(2);
  const isAutoDropRef = useRef(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  // ── Bomb state ────────────────────────────────────────────────────────────
  const bombsRef = useRef<BombEntry[]>([]);
  const explodeAnimRef = useRef<ExplodeState | null>(null);
  const actionModeRef = useRef<'drop' | 'bomb'>('drop');
  const bombHoverCellRef = useRef<{ col: number; row: number } | null>(null);
  const bombsRemainingRef = useRef<Record<Player, number>>({
    p1: BOMBS_PER_PLAYER, p2: BOMBS_PER_PLAYER, p3: BOMBS_PER_PLAYER, p4: BOMBS_PER_PLAYER,
  });
  const [actionMode, setActionMode] = useState<'drop' | 'bomb'>('drop');
  const [bombsRemaining, setBombsRemaining] = useState<Record<Player, number>>({
    p1: BOMBS_PER_PLAYER, p2: BOMBS_PER_PLAYER, p3: BOMBS_PER_PLAYER, p4: BOMBS_PER_PLAYER,
  });
  const [showGrid, setShowGrid] = useState(false);
  const showGridRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // ── Online UI state ────────────────────────────────────────────────────────
  const [selectedPlayerCount, setSelectedPlayerCount] = useState<PlayerCount>(2);
  const [connectedCount, setConnectedCount] = useState(1);
  const [waitingForStart, setWaitingForStart] = useState(false);
  const [canvasCols, setCanvasCols] = useState(CFG.cols);
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3);
  const [cellPx, setCellPx] = useState(CELL);

  const [onlineScreen, setOnlineScreen] = useState<'menu' | 'join'>('menu');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [onlineError, setOnlineError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectMsg, setDisconnectMsg] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const [autoDropMsg, setAutoDropMsg] = useState(false);
  // Player who is one more timeout away from losing (shown as a warning on their turn)
  const [timeoutWarnPlayer, setTimeoutWarnPlayer] = useState<Player | null>(null);
  // Short notice when a bomb tap lands on a cell that can't take a bomb
  const [bombNotice, setBombNotice] = useState(false);
  const bombNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBombNotice = () => {
    setBombNotice(true);
    if (bombNoticeTimerRef.current) clearTimeout(bombNoticeTimerRef.current);
    bombNoticeTimerRef.current = setTimeout(() => setBombNotice(false), 1500);
  };
  const trackTimeoutStreak = (player: Player, wasAuto: boolean): boolean => {
    if (wasAuto) {
      timeoutStreakRef.current[player]++;
      if (timeoutStreakRef.current[player] >= MAX_TIMEOUT_STREAK) { setTimeoutWarnPlayer(null); return true; }
      if (timeoutStreakRef.current[player] === MAX_TIMEOUT_STREAK - 1) setTimeoutWarnPlayer(player);
    } else {
      timeoutStreakRef.current[player] = 0;
      setTimeoutWarnPlayer(w => (w === player ? null : w));
    }
    return false;
  };

  const patchUi = (patch: Partial<UIState>) => {
    const next = { ...uiRef.current, ...patch };
    uiRef.current = next;
    setUi(next);
  };

  // ── Physics engine ────────────────────────────────────────────────────────
  useEffect(() => {
    const engine = Engine.create({ gravity: { y: 2.5 } });
    engineRef.current = engine;
    const wt = 20;
    const floor = Bodies.rectangle(W / 2, H + wt / 2, 5000, wt, { isStatic: true, label: 'floor' });
    const leftWall = Bodies.rectangle(-wt / 2, H / 2, wt, H * 2, { isStatic: true, label: 'wall' });
    const rightWall = Bodies.rectangle(W + wt / 2, H / 2, wt, H * 2, { isStatic: true, label: 'wall' });
    Composite.add(engine.world, [floor, leftWall, rightWall]);
    floorBodyRef.current = floor;
    rightWallBodyRef.current = rightWall;

    // Squash-and-stretch: trigger on collision proportional to impact velocity
    Events.on(engine, 'collisionStart', (event) => {
      const fb = fallingRef.current;
      if (!fb) return;
      for (const pair of event.pairs) {
        if (pair.bodyA === fb.body || pair.bodyB === fb.body) {
          const impactVy = Math.abs(fb.body.velocity.y);
          if (impactVy > 2.0) {
            const amt = Math.min(0.72, impactVy * 0.09);
            if (amt > squashRef.current.value) {
              squashRef.current = { value: amt, velocity: 0, active: true };
            }
          }
          break;
        }
      }
    });

    return () => { Engine.clear(engine); };
  }, []);

  // ── Resize: recalc cell size when not in-game ─────────────────────────────
  useEffect(() => {
    const onResize = () => {
      if (uiRef.current.status === 'playing') return;
      CELL = computeCell(COLS);
      W = COLS * CELL;
      GRID_Y = PREVIEW_ROWS * CELL;
      H = GRID_Y + ROWS * CELL;
      BLOCK = CELL - 8;
      setCellPx(CELL);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Board resize ──────────────────────────────────────────────────────────
  const resetBoardWidth = useCallback((playerCount: PlayerCount) => {
    COLS = colsForPlayerCount(playerCount);
    CELL = computeCell(COLS);
    W = COLS * CELL;
    GRID_Y = PREVIEW_ROWS * CELL;
    H = GRID_Y + ROWS * CELL;
    BLOCK = CELL - 8;
    playerCountRef.current = playerCount;
    previewXRef.current = W / 2;
    setCanvasCols(COLS);
    setCellPx(CELL);
    // Reposition physics walls for new board width / height
    const floor = floorBodyRef.current;
    const rightWall = rightWallBodyRef.current;
    if (floor) Body.setPosition(floor, { x: W / 2, y: H + 10 });
    if (rightWall) Body.setPosition(rightWall, { x: W + 10, y: H / 2 });
  }, []);

  // ── Drop block ────────────────────────────────────────────────────────────
  const dropBlock = useCallback((x: number, player: Player) => {
    if (fallingRef.current || explodeAnimRef.current) return;
    const engine = engineRef.current;
    if (!engine) return;
    const col = Math.floor(x / CELL);
    if (col < 0 || col >= COLS || boardRef.current[0][col] !== null) return;

    const body = Bodies.rectangle(x, CELL / 2, BLOCK, BLOCK, {
      restitution: 0.15,
      friction: 0.35,
      frictionAir: 0.015,
      label: `block-${player}`,
    });
    Composite.add(engine.world, body);
    fallingRef.current = { body, player };
    settledCntRef.current = 0;
  }, []);

  // ── Turn timer ────────────────────────────────────────────────────────────
  const clearTurnTimer = useCallback(() => {
    if (turnTimerRef.current) { clearTimeout(turnTimerRef.current); turnTimerRef.current = null; }
    if (countdownIntervalRef.current) { clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = null; }
    setCountdown(null);
  }, []);

  const startTurnTimer = useCallback((player: Player) => {
    clearTurnTimer();
    if (uiRef.current.mode === 'cpu' && player === 'p2') return;

    let remaining = TURN_TIMEOUT_SEC;
    setCountdown(remaining);
    countdownIntervalRef.current = setInterval(() => {
      remaining--;
      setCountdown(remaining);
      if (remaining <= 0) { clearInterval(countdownIntervalRef.current!); countdownIntervalRef.current = null; }
    }, 1000);

    turnTimerRef.current = setTimeout(() => {
      turnTimerRef.current = null;
      const s = uiRef.current;
      if (s.status !== 'playing' || s.currentPlayer !== player) return;
      if (s.mode === 'online' && player !== onlineRef.current.myRole) return;

      const validCols = Array.from({ length: COLS }, (_, i) => i)
        .filter(c => boardRef.current[0][c] === null);
      if (!validCols.length) return;

      isAutoDropRef.current = true;
      actionModeRef.current = 'drop';
      setActionMode('drop');
      bombHoverCellRef.current = null;
      setCountdown(null);
      setAutoDropMsg(true);
      setTimeout(() => setAutoDropMsg(false), 1500);
      const x = validCols[Math.floor(Math.random() * validCols.length)] * CELL + CELL / 2;
      dropBlock(x, player);
      if (s.mode === 'online') emitDrop(onlineRef.current.roomCode, player, x);
    }, TURN_TIMEOUT_SEC * 1000);
  }, [clearTurnTimer, dropBlock]);

  // Rebuild all static 'settled' bodies from boardRef after explosion-induced changes
  const rebuildSettledBodies = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    Composite.allBodies(engine.world)
      .filter(b => b.label === 'settled')
      .forEach(b => Composite.remove(engine.world, b));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (boardRef.current[r][c]) {
          Composite.add(engine.world, Bodies.rectangle(
            c * CELL + CELL / 2, GRID_Y + r * CELL + CELL / 2,
            BLOCK, BLOCK, { isStatic: true, label: 'settled' },
          ));
        }
      }
    }
  }, []);

  // ── Settle handler ────────────────────────────────────────────────────────
  const settleRef = useRef<(f: FallingBlock) => void>(() => {});
  settleRef.current = (falling: FallingBlock) => {
    const engine = engineRef.current!;
    Composite.remove(engine.world, falling.body);
    fallingRef.current = null;
    settledCntRef.current = 0;

    const isAuto = isAutoDropRef.current;
    isAutoDropRef.current = false;

    const col = Math.max(0, Math.min(COLS - 1, Math.floor(falling.body.position.x / CELL)));
    const board = boardRef.current;
    let row = -1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r][col] === null) { row = r; break; }
    }
    if (row === -1) {
      const next: Player = nextTurn(falling.player, playerCountRef.current);
      patchUi({ currentPlayer: next });
      // Online: this player's turn produced no board change (column full) —
      // still notify the remote client so their turn state doesn't desync.
      if (uiRef.current.mode === 'online') {
        emitSkip(onlineRef.current.roomCode, falling.player);
      }
      if (!(uiRef.current.mode === 'cpu' && next === 'p2')) {
        startTurnTimer(next);
      }
      if (uiRef.current.mode === 'cpu' && next === 'p2') {
        { const gid = gameIdRef.current; setTimeout(() => {
          if (gid !== gameIdRef.current || uiRef.current.status !== 'playing') return;   // the game was quit or restarted
          const cpuCol = getCpuMove(boardRef.current, 'p2', 'p1', CFG.winLength);
          dropBlock(cpuCol * CELL + CELL / 2, 'p2');
        }, 700); }
      }
      return;
    }

    const newBoard = board.map(r => [...r]);
    newBoard[row][col] = falling.player;
    boardRef.current = newBoard;

    Composite.add(engine.world, Bodies.rectangle(
      col * CELL + CELL / 2,
      GRID_Y + row * CELL + CELL / 2,
      BLOCK, BLOCK,
      { isStatic: true, label: 'settled' },
    ));

    // Online: emit settle event so remote clients can snap board.
    // Must fire before any win/draw/timeout early-return below, otherwise the
    // move that decides the game never reaches the opponent's client.
    if (uiRef.current.mode === 'online') {
      emitSettle(onlineRef.current.roomCode, falling.player, col, row, isAuto);
    }

    const wr = checkWin(newBoard, CFG.winLength);
    if (wr) { clearTurnTimer(); patchUi({ status: 'won', winner: wr.winner, winResult: wr }); return; }
    if (isDraw(newBoard)) { clearTurnTimer(); patchUi({ status: 'draw' }); return; }

    // Timeout streak tracking (only in 2-player modes)
    if ((isAuto && playerCountRef.current === 2) || !isAuto) {
      if (trackTimeoutStreak(falling.player, isAuto)) {
        clearTurnTimer();
        const opponent = nextTurn(falling.player, playerCountRef.current);
        patchUi({ status: 'won', winner: opponent, winResult: null });
        return;
      }
    }

    const next: Player = nextTurn(falling.player, playerCountRef.current);
    patchUi({ currentPlayer: next });

    // Process bomb timers: decrement → animate explosion if turnsLeft reaches 0
    {
      const preBoard = boardRef.current;
      const survivors: BombEntry[] = [];
      const explodingBombs: Array<{ col: number; row: number }> = [];
      for (const bomb of bombsRef.current) {
        const left = bomb.turnsLeft - 1;
        if (left <= 0) {
          explodingBombs.push({ col: bomb.col, row: bomb.row });
        } else {
          survivors.push({ ...bomb, turnsLeft: left });
        }
      }
      if (explodingBombs.length > 0) {
        let postBoard = preBoard;
        for (const { col: bc, row: br } of explodingBombs) {
          postBoard = applyExplosion(postBoard, bc, br);
        }
        bombsRef.current = survivors;
        clearTurnTimer();
        explodeAnimRef.current = createExplodeState(explodingBombs, preBoard, postBoard, () => {
          bombsRef.current = bombsRef.current.filter(b => postBoard[b.row][b.col] !== null);
          boardRef.current = postBoard;
          rebuildSettledBodies();
          const wrAfterBomb = checkWin(postBoard, CFG.winLength);
          if (wrAfterBomb) { clearTurnTimer(); patchUi({ status: 'won', winner: wrAfterBomb.winner, winResult: wrAfterBomb }); return; }
          if (isDraw(postBoard)) { clearTurnTimer(); patchUi({ status: 'draw' }); return; }
          if (!(uiRef.current.mode === 'cpu' && next === 'p2')) startTurnTimer(next);
          if (uiRef.current.mode === 'cpu' && next === 'p2') {
            { const gid = gameIdRef.current; setTimeout(() => {
              if (gid !== gameIdRef.current || uiRef.current.status !== 'playing') return;   // the game was quit or restarted
              const cpuCol = getCpuMove(boardRef.current, 'p2', 'p1', CFG.winLength);
              dropBlock(cpuCol * CELL + CELL / 2, 'p2');
            }, 700); }
          }
        });
        return;
      } else {
        bombsRef.current = survivors;
      }
    }

    if (!(uiRef.current.mode === 'cpu' && next === 'p2')) {
      startTurnTimer(next);
    }

    if (uiRef.current.mode === 'cpu' && next === 'p2') {
      { const gid = gameIdRef.current; setTimeout(() => {
        if (gid !== gameIdRef.current || uiRef.current.status !== 'playing') return;   // the game was quit or restarted
        const cpuCol = getCpuMove(newBoard, 'p2', 'p1', CFG.winLength);
        dropBlock(cpuCol * CELL + CELL / 2, 'p2');
      }, 700); }
    }
  };

  // ── Game loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const loop = () => {
      const engine = engineRef.current;
      if (engine) {
        Engine.update(engine, 1000 / 60);
        const f = fallingRef.current;
        const isMyBlock = !f || uiRef.current.mode !== 'online' || f.player === onlineRef.current.myRole;
        if (f && isMyBlock && uiRef.current.status === 'playing') {
          const { x: vx, y: vy } = f.body.velocity;
          const speed = Math.sqrt(vx * vx + vy * vy);
          const angVel = Math.abs(f.body.angularVelocity);
          const inGrid = f.body.position.y > GRID_Y;
          if (speed < 0.5 && angVel < 0.05 && inGrid) {
            // Physics guidance: while settling, gently steer X toward column center
            const targetCol = Math.max(0, Math.min(COLS - 1, Math.round((f.body.position.x - CELL / 2) / CELL)));
            const targetX = targetCol * CELL + CELL / 2;
            const corrVx = (targetX - f.body.position.x) * 0.18;
            Body.setVelocity(f.body, { x: corrVx, y: vy });
            Body.setAngularVelocity(f.body, f.body.angularVelocity * 0.65);
            if (++settledCntRef.current >= 20) settleRef.current(f);
          } else {
            settledCntRef.current = 0;
          }
        }
      }

      // Squash spring
      const sq = squashRef.current;
      if (sq.active) {
        sq.velocity += -0.30 * sq.value;
        sq.velocity *= 0.73;
        sq.value += sq.velocity;
        if (Math.abs(sq.value) < 0.004 && Math.abs(sq.velocity) < 0.004) {
          sq.value = 0; sq.velocity = 0; sq.active = false;
        }
      }

      // Win animation
      const wa = winAnimRef.current;
      const st = uiRef.current.status;
      if (st === 'won' || st === 'draw') {
        wa.frame++;
        const winner = uiRef.current.winner;
        if (wa.frame === 1) {
          confettiRef.current = Array.from({ length: 80 }, () => makeConfetti(winner));
        } else if (wa.frame < 120 && wa.frame % 8 === 0) {
          confettiRef.current.push(...Array.from({ length: 5 }, () => makeConfetti(winner)));
        }
        confettiRef.current = confettiRef.current
          .map(p => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            vy: p.vy + 0.1,
            vx: p.vx * 0.99,
            rotation: p.rotation + p.rotVel,
            opacity: p.y > H * 0.78 ? Math.max(0, p.opacity - 0.025) : p.opacity,
          }))
          .filter(p => p.opacity > 0.01 && p.y < H + 40);
        wa.textScaleVel += 0.25 * (1 - wa.textScale);
        wa.textScaleVel *= 0.70;
        wa.textScale += wa.textScaleVel;
      } else {
        wa.frame = 0; wa.textScale = 0; wa.textScaleVel = 0;
        confettiRef.current = [];
      }

      // Advance explosion animation frame
      const ea = explodeAnimRef.current;
      if (ea) {
        ea.frame++;
        if (ea.frame >= ea.DROP_END) {
          explodeAnimRef.current = null;
          ea.onDone();
        }
      }

      // Draw in logical px; the backing store is scaled by devicePixelRatio
      const scale = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawFrame(ctx, uiRef.current, fallingRef.current, boardRef.current, previewXRef.current, squashRef.current.value, confettiRef.current, winAnimRef.current.textScale, remoteBodyRef.current, onlineRef.current.myRole, bombsRef.current, bombHoverCellRef.current, actionModeRef.current === 'bomb', explodeAnimRef.current, showGridRef.current, playerCountRef.current);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Shared interaction helpers (mouse + touch) ────────────────────────────
  const handlePreviewMove = (rawX: number, rawY: number) => {
    const s = uiRef.current;
    if (s.status !== 'playing' || explodeAnimRef.current) return;
    if (actionModeRef.current === 'bomb') {
      const bCol = Math.floor(rawX / CELL);
      const bRow = Math.floor((rawY - GRID_Y) / CELL);
      if (rawY >= GRID_Y && bRow >= 0 && bRow < ROWS && bCol >= 0 && bCol < COLS) {
        const cell = boardRef.current[bRow]?.[bCol];
        if (cell !== null && cell !== undefined && cell !== s.currentPlayer) {
          bombHoverCellRef.current = { col: bCol, row: bRow };
          return;
        }
      }
      bombHoverCellRef.current = null;
      return;
    }
    if (fallingRef.current) return;
    if (s.mode === 'cpu' && s.currentPlayer === 'p2') return;
    if (s.mode === 'online' && s.currentPlayer !== onlineRef.current.myRole) return;
    previewXRef.current = Math.max(BLOCK / 2, Math.min(W - BLOCK / 2, rawX));
  };

  const handleInteract = (rawX: number, rawY: number) => {
    const s = uiRef.current;
    if (s.status !== 'playing' || explodeAnimRef.current) return;

    if (actionModeRef.current === 'bomb') {
      // A block is still falling: the turn is already used, so no bomb this turn
      if (fallingRef.current) return;
      if (s.mode === 'cpu' && s.currentPlayer === 'p2') return;
      if (s.mode === 'online' && s.currentPlayer !== onlineRef.current.myRole) return;
      const bCol = Math.floor(rawX / CELL);
      const bRow = Math.floor((rawY - GRID_Y) / CELL);
      if (rawY >= GRID_Y && bRow >= 0 && bRow < ROWS && bCol >= 0 && bCol < COLS) {
        const cell = boardRef.current[bRow]?.[bCol];
        const hasBomb = bombsRef.current.some(b => b.col === bCol && b.row === bRow);
        if (cell !== null && cell !== undefined && cell !== s.currentPlayer && !hasBomb && bombsRemainingRef.current[s.currentPlayer] > 0) {
          placeBombAt(bCol, bRow);
          return;
        }
      }
      // Invalid target — stay in bomb mode (cancel only via the bomb button) and say why
      showBombNotice();
      return;
    }
    if (fallingRef.current) return;
    if (s.mode === 'cpu' && s.currentPlayer === 'p2') return;
    if (s.mode === 'online' && s.currentPlayer !== onlineRef.current.myRole) return;
    const x = Math.max(BLOCK / 2, Math.min(W - BLOCK / 2, rawX));
    clearTurnTimer();
    isAutoDropRef.current = false;
    dropBlock(x, s.currentPlayer);
    if (s.mode === 'online') emitDrop(onlineRef.current.roomCode, s.currentPlayer, x);
  };

  // ── Mouse events ──────────────────────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    handlePreviewMove(
      (e.clientX - rect.left) * (W / rect.width),
      (e.clientY - rect.top) * (H / rect.height),
    );
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    handleInteract(
      (e.clientX - rect.left) * (W / rect.width),
      (e.clientY - rect.top) * (H / rect.height),
    );
  };

  // ── Touch events ──────────────────────────────────────────────────────────
  // touchAction:'pan-x' lets the browser handle horizontal scroll natively.
  // We record touch start to distinguish a tap (drop) from a pan (scroll).
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const t = e.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    // horizontal pans are claimed by the browser (pan-x); only non-horizontal
    // moves fire here — update the column preview for diagonal/vertical drags
    const t = e.touches[0];
    if (!t) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    handlePreviewMove(
      (t.clientX - rect.left) * (W / rect.width),
      (t.clientY - rect.top) * (H / rect.height),
    );
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (!t) return;
    // Only treat as a tap (drop) if touch barely moved and ended quickly
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (start) {
      const dx = Math.abs(t.clientX - start.x);
      const dy = Math.abs(t.clientY - start.y);
      const dt = Date.now() - start.time;
      if (dx > 22 || dy > 22 || dt > 600) return; // was a scroll / long-press
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    handleInteract(
      (t.clientX - rect.left) * (W / rect.width),
      (t.clientY - rect.top) * (H / rect.height),
    );
  };

  // ── Game control ──────────────────────────────────────────────────────────
  const clearPhysics = () => {
    const engine = engineRef.current;
    if (!engine) return;
    Composite.allBodies(engine.world)
      .filter(b => b.label !== 'floor' && b.label !== 'wall')
      .forEach(b => Composite.remove(engine.world, b));
    fallingRef.current = null;
    remoteBodyRef.current = null;
    settledCntRef.current = 0;
    boardRef.current = createBoard({ ...CFG, cols: COLS });
    previewXRef.current = W / 2;
    bombsRef.current = [];
    explodeAnimRef.current = null;
    bombHoverCellRef.current = null;
    actionModeRef.current = 'drop';
    setActionMode('drop');
    const resetBombs = { p1: BOMBS_PER_PLAYER, p2: BOMBS_PER_PLAYER, p3: BOMBS_PER_PLAYER, p4: BOMBS_PER_PLAYER };
    bombsRemainingRef.current = resetBombs;
    setBombsRemaining(resetBombs);
  };

  const startGame = (mode: GameMode) => {
    if (mode === '2player' || mode === 'cpu') { setSlingOn(mode); return; }
    gameIdRef.current++;
    resetBoardWidth(2); // 2player/cpu always use 10 cols
    clearPhysics();
    timeoutStreakRef.current = { p1: 0, p2: 0, p3: 0, p4: 0 };
    setTimeoutWarnPlayer(null);
    patchUi({ status: 'playing', currentPlayer: 'p1', winner: null, mode, winResult: null });
    startTurnTimer('p1');
  };

  // ── Online: handle remote events from Firebase ────────────────────────────
  const handleRemoteEventRef = useRef<(ev: RoomEvent) => void>(() => {});
  handleRemoteEventRef.current = (ev: RoomEvent) => {
    if (ev.player === onlineRef.current.myRole) return; // ignore own events echoed back

    // Guest receives 'start' from host — initialize game
    if (ev.type === 'start' && ev.playerCount != null) {
      const pc = ev.playerCount;
      resetBoardWidth(pc);
      clearPhysics();
      timeoutStreakRef.current = { p1: 0, p2: 0, p3: 0, p4: 0 };
    setTimeoutWarnPlayer(null);

      // Replace the wait-phase host-only listener with full opponent-disconnect coverage
      onlineRef.current.unsubHostWait?.();
      onlineRef.current.unsubHostWait = null;

      // Subscribe to opponent disconnects (guests do this on start)
      const myRole = onlineRef.current.myRole;
      const code = onlineRef.current.roomCode;
      const unsubDisconnect = subscribeAnyOpponentDisconnect(code, myRole, pc, (role) => {
        if (uiRef.current.status === 'playing') {
          onlineRef.current.unsubDisconnect?.();
          onlineRef.current.unsubDisconnect = null;
          setDisconnectMsg(`${role.toUpperCase()} の接続が切れました`);
        }
      });
      onlineRef.current.unsubDisconnect = unsubDisconnect;

      setWaitingForStart(false);
      patchUi({ status: 'playing', mode: 'online', currentPlayer: 'p1', winner: null, winResult: null });
      startTurnTimer('p1');
      return;
    }

    if (ev.type === 'drop' && ev.x != null) {
      const engine = engineRef.current;
      if (!engine || fallingRef.current) return;
      const body = Bodies.rectangle(ev.x, CELL / 2, BLOCK, BLOCK, {
        restitution: 0.15,
        friction: 0.35,
        frictionAir: 0.015,
        label: `block-${ev.player}-remote`,
      });
      Composite.add(engine.world, body);
      remoteBodyRef.current = { body, player: ev.player };
      fallingRef.current = { body, player: ev.player };
      settledCntRef.current = 0;
    }

    if (ev.type === 'settle' && ev.col != null && ev.row != null) {
      const engine = engineRef.current;
      if (!engine) return;

      if (remoteBodyRef.current) {
        Composite.remove(engine.world, remoteBodyRef.current.body);
        remoteBodyRef.current = null;
      }
      if (fallingRef.current && fallingRef.current.player !== onlineRef.current.myRole) {
        Composite.remove(engine.world, fallingRef.current.body);
        fallingRef.current = null;
      }
      settledCntRef.current = 0;

      const { col, row, player } = ev;
      const board = boardRef.current;
      if (board[row][col] !== null) return;

      const newBoard = board.map(r => [...r]);
      newBoard[row][col] = player;
      boardRef.current = newBoard;

      Composite.add(engine.world, Bodies.rectangle(
        col * CELL + CELL / 2,
        GRID_Y + row * CELL + CELL / 2,
        BLOCK, BLOCK,
        { isStatic: true, label: 'settled' },
      ));

      const wr = checkWin(newBoard, CFG.winLength);
      if (wr) { clearTurnTimer(); patchUi({ status: 'won', winner: wr.winner, winResult: wr }); return; }
      if (isDraw(newBoard)) { clearTurnTimer(); patchUi({ status: 'draw' }); return; }

      const wasAuto = ev.timeout === true;
      if ((wasAuto && playerCountRef.current === 2) || !wasAuto) {
        if (trackTimeoutStreak(player, wasAuto)) {
          clearTurnTimer();
          const opponent = nextTurn(player, playerCountRef.current);
          patchUi({ status: 'won', winner: opponent, winResult: null });
          return;
        }
      }

      const next: Player = nextTurn(player, playerCountRef.current);
      patchUi({ currentPlayer: next });

      // Process bomb timers
      {
        const preBoard = boardRef.current;
        const survivors: BombEntry[] = [];
        const explodingBombs: Array<{ col: number; row: number }> = [];
        for (const bomb of bombsRef.current) {
          const left = bomb.turnsLeft - 1;
          if (left <= 0) {
            explodingBombs.push({ col: bomb.col, row: bomb.row });
          } else {
            survivors.push({ ...bomb, turnsLeft: left });
          }
        }
        if (explodingBombs.length > 0) {
          let postBoard = preBoard;
          for (const { col: bc, row: br } of explodingBombs) {
            postBoard = applyExplosion(postBoard, bc, br);
          }
          bombsRef.current = survivors;
          clearTurnTimer();
          explodeAnimRef.current = createExplodeState(explodingBombs, preBoard, postBoard, () => {
            bombsRef.current = bombsRef.current.filter(b => postBoard[b.row][b.col] !== null);
            boardRef.current = postBoard;
            rebuildSettledBodies();
            const wrAfterBomb = checkWin(postBoard, CFG.winLength);
            if (wrAfterBomb) { clearTurnTimer(); patchUi({ status: 'won', winner: wrAfterBomb.winner, winResult: wrAfterBomb }); return; }
            if (isDraw(postBoard)) { clearTurnTimer(); patchUi({ status: 'draw' }); return; }
            startTurnTimer(next);
          });
        } else {
          bombsRef.current = survivors;
          startTurnTimer(next);
        }
      }
    }

    if (ev.type === 'bomb' && ev.col != null && ev.row != null) {
      bombsRef.current = [...bombsRef.current, { col: ev.col, row: ev.row, turnsLeft: 2, placedBy: ev.player }];
      const nb = { ...bombsRemainingRef.current, [ev.player]: bombsRemainingRef.current[ev.player] - 1 };
      bombsRemainingRef.current = nb;
      setBombsRemaining(nb);
      const next: Player = nextTurn(ev.player, playerCountRef.current);
      patchUi({ currentPlayer: next });
      startTurnTimer(next);
    }

    if (ev.type === 'skip') {
      // Remote player's drop landed in a full column — no board change, just advance the turn.
      const engine = engineRef.current;
      if (engine && remoteBodyRef.current) {
        Composite.remove(engine.world, remoteBodyRef.current.body);
        remoteBodyRef.current = null;
      }
      if (engine && fallingRef.current && fallingRef.current.player !== onlineRef.current.myRole) {
        Composite.remove(engine.world, fallingRef.current.body);
        fallingRef.current = null;
      }
      settledCntRef.current = 0;
      const next: Player = nextTurn(ev.player, playerCountRef.current);
      patchUi({ currentPlayer: next });
      startTurnTimer(next);
    }
  };

  // ── Bomb placement ────────────────────────────────────────────────────────
  const placeBombAt = useCallback((col: number, row: number) => {
    const s = uiRef.current;
    const player = s.currentPlayer;

    bombsRef.current = [...bombsRef.current, { col, row, turnsLeft: 2, placedBy: player }];
    const nextBombs = { ...bombsRemainingRef.current, [player]: bombsRemainingRef.current[player] - 1 };
    bombsRemainingRef.current = nextBombs;
    setBombsRemaining(nextBombs);
    actionModeRef.current = 'drop';
    setActionMode('drop');
    bombHoverCellRef.current = null;

    const next: Player = nextTurn(player, playerCountRef.current);
    clearTurnTimer();
    patchUi({ currentPlayer: next });
    startTurnTimer(next);

    if (s.mode === 'online') {
      emitBomb(onlineRef.current.roomCode, player, col, row);
    }
  }, [clearTurnTimer, startTurnTimer]);

  // ── Online: room creation (host = P1) ─────────────────────────────────────
  const createOnlineRoom = async () => {
    setIsConnecting(true);
    setOnlineError('');
    setConnectedCount(1);
    try {
      const playerCount = selectedPlayerCount;
      const code = await createRoom(playerCount);
      onlineRef.current.myRole = 'p1';
      onlineRef.current.roomCode = code;
      setCreatedCode(code);
      clearPhysics();
      patchUi({ status: 'waiting', mode: 'online', currentPlayer: 'p1', winner: null, winResult: null });

      registerDisconnect(code, 'p1');

      // Subscribe to events immediately (bomb/drop during wait + game events)
      const unsubEvent = subscribeEvent(code, (ev) => handleRemoteEventRef.current(ev));
      onlineRef.current.unsubEvent = unsubEvent;

      const unsubAllConnected = subscribeAllConnected(code, playerCount, (allConnected, count) => {
        setConnectedCount(count);
        if (allConnected) {
          unsubAllConnected();
          onlineRef.current.unsubAllConnected = null;

          // Subscribe to any opponent disconnect during game
          const unsubDisconnect = subscribeAnyOpponentDisconnect(code, 'p1', playerCount, (role) => {
            if (uiRef.current.status === 'playing') {
              onlineRef.current.unsubDisconnect?.();
              onlineRef.current.unsubDisconnect = null;
              setDisconnectMsg(`${role.toUpperCase()} の接続が切れました`);
            }
          });
          onlineRef.current.unsubDisconnect = unsubDisconnect;

          // Host starts game and broadcasts to guests
          resetBoardWidth(playerCount);
          clearPhysics();
          timeoutStreakRef.current = { p1: 0, p2: 0, p3: 0, p4: 0 };
    setTimeoutWarnPlayer(null);
          patchUi({ status: 'playing', mode: 'online', currentPlayer: 'p1', winner: null, winResult: null });
          startTurnTimer('p1');
          emitStart(code, playerCount);
        }
      });
      onlineRef.current.unsubAllConnected = unsubAllConnected;
    } catch {
      setOnlineError('ルーム作成に失敗しました。再試行してください。');
    } finally {
      setIsConnecting(false);
    }
  };

  // ── Online: join room (guest = P2/P3/P4) ─────────────────────────────────
  const joinOnlineRoom = async () => {
    const code = roomCodeInput.trim();
    if (code.length !== 4 || !/^\d{4}$/.test(code)) {
      setOnlineError('4桁の数字を入力してください');
      return;
    }
    setIsConnecting(true);
    setOnlineError('');
    try {
      const myRole = await joinRoom(code); // returns 'p2', 'p3', or 'p4'
      onlineRef.current.myRole = myRole;
      onlineRef.current.roomCode = code;

      registerDisconnect(code, myRole);

      // Watch the host's connection while waiting for 'start' — otherwise a host
      // disconnect during this phase leaves the guest stuck on the waiting screen.
      const unsubHostWait = subscribeHostDisconnect(code, () => {
        if (uiRef.current.status === 'waiting') {
          onlineRef.current.unsubHostWait?.();
          onlineRef.current.unsubHostWait = null;
          setDisconnectMsg('ホストの接続が切れました');
        }
      });
      onlineRef.current.unsubHostWait = unsubHostWait;

      // Subscribe to events — 'start' event will kick off the game
      const unsubEvent = subscribeEvent(code, (ev) => handleRemoteEventRef.current(ev));
      onlineRef.current.unsubEvent = unsubEvent;

      // Show waiting overlay until host emits 'start'
      setWaitingForStart(true);
      clearPhysics();
      patchUi({ status: 'waiting', mode: 'online', currentPlayer: 'p1', winner: null, winResult: null });
    } catch (e) {
      setOnlineError(e instanceof Error ? e.message : 'エラーが発生しました');
    } finally {
      setIsConnecting(false);
    }
  };

  const leaveOnlineRoom = () => {
    clearTurnTimer();
    onlineRef.current.unsubEvent?.();
    onlineRef.current.unsubAllConnected?.();
    onlineRef.current.unsubDisconnect?.();
    onlineRef.current.unsubHostWait?.();
    onlineRef.current.unsubEvent = null;
    onlineRef.current.unsubAllConnected = null;
    onlineRef.current.unsubDisconnect = null;
    onlineRef.current.unsubHostWait = null;
    if (onlineRef.current.roomCode) {
      // Only the host owns the room; a guest leaving must not delete it out
      // from under the host and any other still-connected players.
      if (onlineRef.current.myRole === 'p1') {
        removeRoom(onlineRef.current.roomCode);
      } else {
        leaveRoomAsGuest(onlineRef.current.roomCode, onlineRef.current.myRole);
      }
      onlineRef.current.roomCode = '';
    }
    setCreatedCode('');
    setRoomCodeInput('');
    setOnlineError('');
    setDisconnectMsg('');
    setWaitingForStart(false);
    setConnectedCount(1);
    setOnlineScreen('menu');
  };

  const resetGame = () => {
    gameIdRef.current++;
    setAskQuit(false);
    leaveOnlineRoom();
    resetBoardWidth(2);
    clearPhysics();
    patchUi({ ...INIT_UI });
  };

  // ── UI helpers ────────────────────────────────────────────────────────────
  const playerLabel = (p: Player) => {
    if (p === 'p1') return 'ソーダ';
    if (p === 'p2') return ui.mode === 'cpu' ? 'CPU' : 'オレンジ';
    if (p === 'p3') return 'Player 3';
    return 'Player 4';
  };

  const statusColor = () => {
    if (ui.status === 'waiting') return THEME.sub;
    if (ui.status === 'won' && ui.winner) return COLOR[ui.winner];
    if (ui.status === 'draw') return THEME.accent;
    return COLOR[ui.currentPlayer];
  };

  const statusText = () => {
    if (ui.status === 'waiting') return waitingForStart ? 'ホストを待っています…' : 'みんなを待っています…';
    if (ui.status === 'won' && ui.winner) return `${playerLabel(ui.winner)}の勝ち！`;
    if (ui.status === 'draw') return '引き分け';
    const isMyTurnNow =
      !(ui.mode === 'cpu' && ui.currentPlayer === 'p2') &&
      !(ui.mode === 'online' && ui.currentPlayer !== onlineRef.current.myRole);
    if (actionMode === 'bomb' && isMyTurnNow) return 'ばくだんを しかける';
    if (ui.mode === 'online') {
      return ui.currentPlayer === onlineRef.current.myRole
        ? 'あなたの ばん'
        : `${playerLabel(ui.currentPlayer)}の ばん`;
    }
    return `${playerLabel(ui.currentPlayer)}の ばん`;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: `radial-gradient(120% 70% at 50% 0%, ${THEME.bgTop} 0%, ${THEME.bg} 60%)`, color: THEME.text, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 16, fontFamily: FONTS.body }}>

      {/* Turn band — the current player's color + mark, readable from a distance */}
      {(ui.status === 'playing' || ui.status === 'won' || ui.status === 'draw' || ui.status === 'waiting') && (() => {
        const clr = statusColor();
        const markPlayer: Player | null =
          ui.status === 'won' ? ui.winner : ui.status === 'playing' ? ui.currentPlayer : null;
        const timerColor = countdown === null ? THEME.accent : countdown > 10 ? THEME.accent : THEME.fuse;
        const timerPct = countdown === null ? 0 : (countdown / TURN_TIMEOUT_SEC) * 100;
        const isCpuTurn = ui.mode === 'cpu' && ui.currentPlayer === 'p2';
        const isRemoteTurn = ui.mode === 'online' && ui.currentPlayer !== onlineRef.current.myRole;
        // The 34x34 slot is always reserved so the band never changes height between turns
        const slot: 'timer' | 'thinking' | 'idle' | 'none' =
          ui.status !== 'playing' ? 'none'
          : isCpuTurn ? 'thinking'
          : countdown !== null && !autoDropMsg ? 'timer'
          : 'idle';
        return (
          <div style={{
            width: canvasCols * cellPx, maxWidth: 'calc(100vw - 32px)', minHeight: 54,
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 16,
            background: `linear-gradient(90deg, ${hexToRgba(clr, 0.35)}, ${hexToRgba(clr, 0.08)})`,
            boxShadow: `inset 0 0 0 2px ${hexToRgba(clr, 0.6)}`,
            transition: 'background 0.25s ease-out, box-shadow 0.25s ease-out',
          }}>
            {markPlayer && <GummyChip player={markPlayer} size={22} />}
            <span style={{ fontFamily: FONTS.heading, fontSize: 15, color: THEME.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {statusText()}
            </span>
            {ui.status === 'playing' && autoDropMsg && (
              <span style={{ fontSize: 12, fontWeight: 800, color: THEME.accent, whiteSpace: 'nowrap' }}>時間切れ！</span>
            )}
            {ui.status === 'playing' && (
              <button
                onClick={() => { if (askQuit) resetGame(); else { setAskQuit(true); setTimeout(() => setAskQuit(false), 3000); } }}
                aria-label="やめて メニューへ"
                style={{
                  marginLeft: 'auto', minWidth: 34, height: 34, flexShrink: 0, borderRadius: 999, border: 0, cursor: 'pointer', padding: askQuit ? '0 12px' : 0,
                  background: askQuit ? THEME.accent : 'rgba(255,255,255,0.10)', color: askQuit ? THEME.bgTop : THEME.muted,
                  fontFamily: FONTS.heading, fontSize: askQuit ? 12 : 15,
                }}
              >{askQuit ? 'やめる？' : '✕'}</button>
            )}
            <div style={{ marginLeft: ui.status === 'playing' ? 0 : 'auto', width: 34, height: 34, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
              {slot === 'timer' && (
                <div className="slot-fade" style={{
                  width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  opacity: isRemoteTurn ? 0.6 : 1,
                  background: `conic-gradient(${timerColor} 0 ${timerPct}%, rgba(255,255,255,0.12) ${timerPct}% 100%)`,
                }}>
                  <span style={{
                    width: 26, height: 26, borderRadius: '50%', background: THEME.bg,
                    display: 'grid', placeItems: 'center', fontFamily: FONTS.logo, fontSize: 13, color: THEME.text,
                  }}>{countdown}</span>
                </div>
              )}
              {slot === 'thinking' && (
                <div className="slot-fade" aria-label="考え中" style={{ display: 'flex', gap: 3 }}>
                  {[0, 1, 2].map(i => (
                    <span key={i} className="thinking-dot" style={{
                      width: 8, height: 8, borderRadius: '30%', background: COLOR.p2, animationDelay: `${i * 0.2}s`,
                    }} />
                  ))}
                </div>
              )}
              {slot === 'idle' && (
                <div className="slot-fade" style={{ width: 34, height: 34, borderRadius: '50%', boxShadow: 'inset 0 0 0 4px rgba(255,255,255,0.12)', opacity: 0.6 }} />
              )}
            </div>
          </div>
        );
      })()}

      {/* Canvas — horizontally scrollable for wide boards */}
      <div style={{ position: 'relative', overflowX: 'auto', maxWidth: '100vw' }}>
        <canvas
          ref={canvasRef}
          width={Math.round(canvasCols * cellPx * dpr)}
          height={Math.round((PREVIEW_ROWS + ROWS) * cellPx * dpr)}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ width: canvasCols * cellPx, height: (PREVIEW_ROWS + ROWS) * cellPx, borderRadius: 14, display: 'block', cursor: ui.status === 'playing' ? (actionMode === 'bomb' ? 'crosshair' : 'crosshair') : 'default', touchAction: actionMode === 'bomb' ? 'none' : 'pan-x' }}
        />

        {/* ── Guest waiting for host overlay ──────────────────────────────── */}
        {waitingForStart && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            background: hexToRgba(THEME.bg, 0.94),
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 24,
          }}>
            <div style={{ fontSize: 48 }}>⏳</div>
            <div style={{ color: '#36C2F0', fontSize: 18, fontWeight: 700 }}>
              ホストがゲームを準備中…
            </div>
            <div style={{ color: '#FFE14D', fontSize: 15, fontWeight: 700 }}>
              {connectedCount} 人が接続中
            </div>
            <div style={{ color: '#BFAED6', fontSize: 13 }}>
              全員が揃うまで待ちます
            </div>
            <button
              onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
              style={{ padding: '10px 28px', borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              キャンセル
            </button>
          </div>
        )}

        {/* ── Opponent disconnect overlay ──────────────────────────────────── */}
        {disconnectMsg && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            background: hexToRgba(THEME.bg, 0.94),
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 24,
          }}>
            <div style={{ fontSize: 48 }}>📡</div>
            <div style={{ color: '#FF7A59', fontSize: 20, fontWeight: 700 }}>{disconnectMsg}</div>
            <button
              onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
              style={{ padding: '12px 32px', borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              メニューへ
            </button>
          </div>
        )}

        {/* ── Title / Mode selection / Online / Waiting overlay ───────────── */}
        {(ui.status === 'idle' || ui.status === 'waiting') && !waitingForStart && (
          // Full screen (not inside the old board's box), so small phones see every button (DESIGN.md §5)
          <div style={{
            position: 'fixed', inset: 0, zIndex: 30,
            background: `radial-gradient(120% 70% at 50% 0%, ${THEME.bgTop} 0%, ${THEME.bg} 60%)`,
            display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '16px 0',
            alignItems: 'center', justifyContent: 'safe center', gap: 18,
          }}>

            {/* ── Normal mode select ── */}
            {ui.status === 'idle' && ui.mode !== 'online' && (<>
              <div style={{ textAlign: 'center' }}>
                <GummyLogo />
                <p style={{ fontFamily: FONTS.heading, color: THEME.muted, fontSize: 15, marginTop: 12 }}>
                  ぷにっと引っぱって、5つそろえろ
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 280, padding: '0 16px' }}>
                {/* Until online moves to the pull controls, the new games sit on top (docs/requirements/2026-10-26_引っぱる操作の本体移行.md) */}
                {([
                  { mode: '2player' as GameMode, label: 'ふたりで（1台を交代で）', note: '', badge: true, bg: THEME.accent, fg: THEME.bg },
                  { mode: 'cpu'     as GameMode, label: 'CPUとあそぶ', note: '', badge: true, bg: THEME.sub, fg: THEME.bg },
                  { mode: 'online'  as GameMode, label: 'オンライン対戦', note: 'まえの あそびかた（おとす）', badge: false, bg: 'transparent', fg: THEME.text },
                ]).map(({ mode, label, note, badge, bg, fg }) => (
                  <button key={mode}
                    onClick={() => {
                      if (mode === 'online') {
                        setOnlineScreen('menu'); setOnlineError(''); setRoomCodeInput('');
                        patchUi({ status: 'idle', mode: 'online' });
                      } else {
                        startGame(mode);
                      }
                    }}
                    style={{
                      position: 'relative', width: '100%', padding: '13px 16px', borderRadius: 22, border: 0,
                      background: bg, color: fg, fontFamily: FONTS.heading, fontSize: 17, cursor: 'pointer',
                      boxShadow: bg === 'transparent'
                        ? `inset 0 0 0 2px ${THEME.glass}`
                        : 'inset 0 -5px 0 rgba(0,0,0,0.2), inset 0 3px 0 rgba(255,255,255,0.4)',
                      transition: 'transform 0.15s ease-out',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = ''; }}
                  >
                    {badge && mode === '2player' && (
                      <span style={{ position: 'absolute', top: -9, right: 14, padding: '2px 8px', borderRadius: 999, background: THEME.fuse, color: '#fff', fontFamily: FONTS.heading, fontSize: 11 }}>あたらしい！</span>
                    )}
                    {label}
                    {badge && <span style={{ display: 'block', fontFamily: FONTS.body, fontWeight: 800, fontSize: 12, marginTop: 2 }}>ひっぱって なげる</span>}
                    {note && <span style={{ display: 'block', fontFamily: FONTS.body, fontWeight: 800, fontSize: 11, marginTop: 2, opacity: 0.75 }}>{note}</span>}
                  </button>
                ))}
              </div>
              <div style={{ color: THEME.muted, fontSize: 12, textAlign: 'center', lineHeight: 1.7, padding: '0 16px' }}>
                たて・よこ・ななめに 5つ そろえたら かち！
              </div>
              <div
                onClick={() => { const n = !showGrid; setShowGrid(n); showGridRef.current = n; }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', cursor: 'pointer' }}
              >
                <span style={{ color: THEME.muted, fontSize: 13 }}>ますめを表示</span>
                <div
                  style={{ width: 36, height: 20, borderRadius: 10, background: showGrid ? THEME.p1.base : 'rgba(255,255,255,0.12)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
                >
                  <div style={{ position: 'absolute', top: 2, left: showGrid ? 17 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                </div>
              </div>
              {/* BGM credit required by the 魔王魂 terms (https://maou.audio/rule/) */}
              <a href="https://maou.audio/" target="_blank" rel="noopener noreferrer" style={{ color: THEME.muted, fontSize: 12, padding: '4px 16px', textDecoration: 'underline' }}>
                音楽：魔王魂
              </a>
            </>)}

            {/* ── Online sub-menu ── */}
            {ui.status === 'idle' && ui.mode === 'online' && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#FFF6EC', letterSpacing: 4 }}>オンライン対戦</div>
                <p style={{ color: '#BFAED6', fontSize: 12, marginTop: 8, letterSpacing: 2 }}>
                  ルームを作るか、4けたのコードで参加
                </p>
              </div>

              {onlineScreen === 'menu' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>

                  {/* Player count selector */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                    <div style={{ color: '#BFAED6', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>プレイ人数</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {([2, 3, 4] as PlayerCount[]).map(n => (
                        <button
                          key={n}
                          onClick={() => setSelectedPlayerCount(n)}
                          style={{
                            width: 56, height: 40, borderRadius: 8,
                            border: `1.5px solid ${selectedPlayerCount === n ? '#FFE14D' : 'rgba(255,255,255,0.12)'}`,
                            background: selectedPlayerCount === n ? 'rgba(255,225,77,0.15)' : 'transparent',
                            color: selectedPlayerCount === n ? '#FFE14D' : '#BFAED6',
                            fontSize: 16, fontWeight: 700,
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          {n}人
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={createOnlineRoom}
                    disabled={isConnecting}
                    style={{
                      width: 220, padding: '16px 20px', borderRadius: 12,
                      border: '1.5px solid #FFE14D', background: 'rgba(255,225,77,0.12)',
                      color: '#FFE14D', fontSize: 14, fontWeight: 700, letterSpacing: 1,
                      cursor: isConnecting ? 'wait' : 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {isConnecting ? '作成中…' : 'ルームを作る'}
                  </button>
                  <button
                    onClick={() => { setOnlineScreen('join'); setOnlineError(''); }}
                    style={{
                      width: 220, padding: '16px 20px', borderRadius: 12,
                      border: '1.5px solid #36C2F0', background: 'rgba(54,194,240,0.10)',
                      color: '#36C2F0', fontSize: 14, fontWeight: 700, letterSpacing: 1,
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    ルームに参加
                  </button>
                </div>
              )}

              {onlineScreen === 'join' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                  <input
                    type="text"
                    maxLength={4}
                    placeholder="4桁のコード"
                    value={roomCodeInput}
                    onChange={e => setRoomCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    onKeyDown={e => e.key === 'Enter' && joinOnlineRoom()}
                    style={{
                      width: 180, padding: '12px 16px', borderRadius: 10,
                      border: '1.5px solid rgba(255,255,255,0.2)', background: '#2B1B3D',
                      color: '#FFF6EC', fontSize: 24, fontWeight: 700, letterSpacing: 8,
                      textAlign: 'center', fontFamily: 'monospace', outline: 'none',
                    }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={joinOnlineRoom}
                      disabled={isConnecting}
                      style={{
                        padding: '12px 24px', borderRadius: 10,
                        border: '1.5px solid #36C2F0', background: 'rgba(54,194,240,0.12)',
                        color: '#36C2F0', fontSize: 13, fontWeight: 700,
                        cursor: isConnecting ? 'wait' : 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {isConnecting ? '接続中…' : '参加する'}
                    </button>
                    <button
                      onClick={() => { setOnlineScreen('menu'); setOnlineError(''); }}
                      style={{
                        padding: '12px 20px', borderRadius: 10,
                        border: '1.5px solid rgba(255,255,255,0.2)', background: 'transparent',
                        color: '#BFAED6', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >戻る</button>
                  </div>
                </div>
              )}

              {onlineError && (
                <p style={{ color: '#FF3B5C', fontSize: 12, marginTop: -20 }}>{onlineError}</p>
              )}

              <button
                onClick={() => patchUi({ status: 'idle', mode: '2player' })}
                style={{
                  padding: '12px 24px', borderRadius: 16,
                  border: `2px solid ${THEME.glass}`, background: 'transparent',
                  color: THEME.text, fontSize: 14, cursor: 'pointer', fontFamily: FONTS.heading,
                }}
              >← もどる</button>
            </>)}

            {/* ── Waiting for players (host) ── */}
            {ui.status === 'waiting' && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#FFF6EC', letterSpacing: 2 }}>
                  みんなを待っています
                </div>
                <p style={{ color: '#FFE14D', fontSize: 16, fontWeight: 700, marginTop: 10 }}>
                  {connectedCount} / {selectedPlayerCount} 人参加済み
                </p>
                <p style={{ color: '#BFAED6', fontSize: 12, marginTop: 4 }}>
                  このコードを友だちに教えてね
                </p>
              </div>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
              }}>
                <div style={{
                  fontSize: 52, fontWeight: 900, letterSpacing: 16,
                  color: '#FFE14D', fontFamily: 'monospace',
                  background: 'rgba(255,225,77,0.08)', padding: '16px 32px', borderRadius: 14,
                  border: '2px solid rgba(255,225,77,0.3)',
                }}>
                  {createdCode}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(createdCode).then(() => {
                      setCodeCopied(true);
                      setTimeout(() => setCodeCopied(false), 2000);
                    });
                  }}
                  style={{
                    padding: '8px 20px', borderRadius: 8,
                    border: `1px solid ${codeCopied ? '#FFE14D' : 'rgba(255,255,255,0.2)'}`,
                    background: codeCopied ? 'rgba(255,225,77,0.1)' : 'rgba(255,255,255,0.04)',
                    color: codeCopied ? '#FFE14D' : '#BFAED6',
                    fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'all 0.2s',
                  }}
                >{codeCopied ? 'コピーしました' : 'コードをコピー'}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#BFAED6', fontSize: 13 }}>ますめを表示</span>
                <div
                  onClick={() => { const n = !showGrid; setShowGrid(n); showGridRef.current = n; }}
                  style={{ width: 36, height: 20, borderRadius: 10, background: showGrid ? '#36C2F0' : 'rgba(255,255,255,0.12)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
                >
                  <div style={{ position: 'absolute', top: 2, left: showGrid ? 17 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                </div>
              </div>

              <button
                onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
                style={{
                  padding: '12px 24px', borderRadius: 16,
                  border: `2px solid ${THEME.glass}`, background: 'transparent',
                  color: THEME.text, fontSize: 14, cursor: 'pointer', fontFamily: FONTS.heading,
                }}
              >やめる</button>
            </>)}
          </div>
        )}

        {/* ── Action buttons overlay — positioned below WINS!/LOSES text ── */}
        {(ui.status === 'won' || ui.status === 'draw') && (
          <div style={{
            position: 'absolute',
            top: 'calc(50% + 175px)',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex', gap: 12, zIndex: 10,
            whiteSpace: 'nowrap',
          }}>
            {ui.mode !== 'online' && (
              <button onClick={() => startGame(ui.mode)} style={actionBtn('primary')}>もう一回</button>
            )}
            <button onClick={resetGame} style={actionBtn('ghost')}>メニュー</button>
          </div>
        )}
      </div>

      {/* Bottom bar — always shown while playing (fixed height) so the board never shifts */}
      {ui.status === 'playing' && (() => {
        const isMyTurn =
          !(ui.mode === 'cpu' && ui.currentPlayer === 'p2') &&
          !(ui.mode === 'online' && ui.currentPlayer !== onlineRef.current.myRole);
        const me: Player = ui.mode === 'cpu' ? 'p1'
          : ui.mode === 'online' ? (onlineRef.current.myRole ?? 'p1')
          : ui.currentPlayer;
        const playerCount = canvasCols >= 40 ? 4 : canvasCols >= 20 ? 3 : 2;
        const opponents = (['p1', 'p2', 'p3', 'p4'] as Player[]).slice(0, playerCount).filter(p => p !== me);
        const remaining = bombsRemaining[me];
        const active = actionMode === 'bomb' && isMyTurn;
        const disabled = !isMyTurn || (remaining === 0 && !active);
        const warn = isMyTurn && timeoutWarnPlayer === ui.currentPlayer;
        const hint = !isMyTurn
          ? (ui.mode === 'cpu' ? 'CPUが考え中…' : 'あいての ばん。少し待っててね')
          : active
            ? (bombNotice ? 'そこには しかけられないよ。あいてのグミをタップ' : 'あいてのグミをタップ。2手あとに まわり十字が消える（自分のグミも）')
            : warn ? 'あと1回 時間切れになると負け！' : 'おとしたい場所をタップ';
        return (
          <div style={{ width: canvasCols * cellPx, maxWidth: 'calc(100vw - 32px)', height: 52, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => {
                if (fallingRef.current) return;
                const next: 'drop' | 'bomb' = active ? 'drop' : 'bomb';
                actionModeRef.current = next;
                setActionMode(next);
                if (next === 'drop') bombHoverCellRef.current = null;
              }}
              disabled={disabled}
              aria-label={active ? '爆弾をやめる' : '爆弾を使う'}
              style={{
                position: 'relative', width: 52, height: 52, borderRadius: 16, flexShrink: 0, padding: 0,
                border: `2px solid ${active ? THEME.fuse : THEME.glass}`,
                background: active ? hexToRgba(THEME.fuse, 0.18) : 'rgba(255,255,255,0.06)',
                display: 'grid', placeItems: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                boxShadow: active ? `0 0 14px ${hexToRgba(THEME.fuse, 0.6)}` : 'none',
                transition: 'box-shadow 0.15s, border-color 0.15s, background 0.15s',
              }}
            >
              {/* Opponent's turn: dim the icon but keep the badge readable; out of bombs: grey badge */}
              <span style={{ opacity: !isMyTurn ? 0.35 : remaining === 0 ? 0.35 : 1, transition: 'opacity 0.2s ease-out', display: 'grid' }}>
                <BombIcon size={26} />
              </span>
              <span style={{
                position: 'absolute', bottom: -6, right: -6, padding: '2px 6px', borderRadius: 999,
                background: remaining > 0 ? '#D9244A' : '#555', color: '#fff',
                fontSize: 12, fontWeight: 900, lineHeight: 1.2,
              }}>×{remaining}</span>
            </button>
            <span className="slot-fade" key={hint} style={{ flex: 1, minWidth: 0, fontSize: 13, color: warn || bombNotice ? THEME.accent : THEME.muted, fontWeight: warn || bombNotice ? 800 : 400, lineHeight: 1.4 }}>
              {hint}
            </span>
            {/* Opponents' remaining bombs — numbers only, not buttons (hidden vs CPU: it never bombs) */}
            {ui.mode !== 'cpu' && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }} aria-label="あいての残り爆弾">
              <span style={{ fontSize: 11, color: THEME.muted }}>あいて</span>
              {opponents.map(p => (
                <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 800, color: bombsRemaining[p] > 0 ? THEME.text : THEME.muted }}>
                  <GummyChip player={p} size={16} />
                  <BombIcon size={12} />×{bombsRemaining[p]}
                </span>
              ))}
            </div>}
          </div>
        );
      })()}

      {slingOn && <SlingGame key={slingOn} cpu={slingOn === 'cpu'} onMenu={() => setSlingOn(false)} />}

      {new URLSearchParams(location.search).has('sounds') && <SoundTest />}

      {/* Sound on/off — same top-right spot on the menu (DESIGN.md §4) */}
      {!slingOn && (ui.status === 'idle' || ui.status === 'waiting') && (
        <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 35 }}><MuteButton /></div>
      )}

      {/* Phones on their side (height < 500): the game is pulled downwards, so ask to turn it upright (CSS-only, index.css) */}
      <div className="rotate-hint" role="alert">
        <span className="rotate-phone" aria-hidden />
        <span style={{ fontFamily: FONTS.heading, fontSize: 18 }}>たてに して あそんでね</span>
      </div>
    </div>
  );
}

// Title logo — gummy letters that squash one by one (CSS keyframes in index.css)
const LOGO_COLORS = [THEME.p1, THEME.p2, { base: THEME.accent, deep: '#C9A800' }];
function GummyLogo() {
  const rows = ['BLOCK', 'FIVE'];
  let i = 0;
  return (
    <div style={{ fontFamily: FONTS.logo, fontSize: 'min(52px, 12vw)', lineHeight: 1.05 }}>
      {rows.map(row => (
        <div key={row}>
          {[...row].map(ch => {
            const tone = LOGO_COLORS[i % LOGO_COLORS.length];
            const delay = `${(i++) * 0.08}s`;
            return (
              <span key={`${row}-${i}`} className="gummy-letter" style={{ color: tone.base, textShadow: `0 4px 0 ${tone.deep}`, animationDelay: delay }}>
                {ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Small CSS gummy used in DOM UI (turn band etc.) — mirrors drawGummy's mark per player
function GummyChip({ player, size }: { player: Player; size: number }) {
  const tone = GUMMY_TONE[player];
  const mark: React.CSSProperties =
    player === 'p1' ? { width: size * 0.4, height: size * 0.4, borderRadius: '50%', border: `${Math.max(2, size * 0.09)}px solid rgba(255,255,255,0.85)` }
    : {};
  return (
    <span style={{
      width: size, height: size, borderRadius: '30%', flexShrink: 0, display: 'inline-grid', placeItems: 'center',
      background: `linear-gradient(160deg, ${tone.light}, ${tone.base} 55%, ${tone.deep})`,
      boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.22), inset 0 2px 0 rgba(255,255,255,0.35)',
    }}>
      {player === 'p2'
        ? <svg width={size * 0.6} height={size * 0.6} viewBox="-1 -1 2 2" aria-hidden><path d={starPath(0.95, 0.42)} fill="none" stroke="rgba(120,30,10,0.6)" strokeWidth={0.24} strokeLinejoin="round" /></svg>
        : <span style={mark} />}
    </span>
  );
}

function BombIcon({ size }: { size: number }) {
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-block' }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, #5a5a5a, ${THEME.bomb} 60%, #111)`,
      }} />
      <span style={{
        position: 'absolute', right: '4%', top: '-14%', width: '34%', height: '34%',
        borderTop: `3px solid ${THEME.fuse}`, borderRight: `3px solid ${THEME.fuse}`, borderRadius: '0 60% 0 0',
      }} />
    </span>
  );
}

function actionBtn(kind: 'primary' | 'ghost'): React.CSSProperties {
  return {
    padding: '12px 24px', borderRadius: 20, border: 0,
    background: kind === 'primary' ? THEME.accent : 'rgba(43,27,61,0.85)',
    color: kind === 'primary' ? THEME.bg : THEME.text,
    boxShadow: kind === 'primary'
      ? 'inset 0 -4px 0 rgba(0,0,0,0.2), inset 0 3px 0 rgba(255,255,255,0.4)'
      : `inset 0 0 0 2px ${THEME.glass}`,
    fontFamily: FONTS.heading, fontSize: 14,
    cursor: 'pointer',
  } as React.CSSProperties;
}
