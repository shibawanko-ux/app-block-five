import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import type { Board, GameMode, GameStatus, Player, PlayerCount, WinResult } from './types';
import { CELL, DEFAULT_CONFIG, PREVIEW_ROWS, colsForPlayerCount } from './types';
import { checkWin, createBoard, isDraw } from './gameLogic';
import { getCpuMove } from './cpuPlayer';
import {
  createRoom, joinRoom, emitDrop, emitSettle, emitBomb, emitStart,
  subscribeEvent, subscribeAllConnected, subscribeAnyOpponentDisconnect, removeRoom,
  registerDisconnect,
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
let COLS = CFG.cols;       // mutable: changes with playerCount
const ROWS = CFG.rows;
let W = COLS * CELL;       // mutable: changes with playerCount
const GRID_Y = PREVIEW_ROWS * CELL;
const H = GRID_Y + ROWS * CELL;
const BLOCK = CELL - 8;

function nextTurn(current: Player, playerCount: number): Player {
  const idx = parseInt(current[1]); // 1, 2, 3, 4
  return `p${(idx % playerCount) + 1}` as Player;
}

// ── Colors ────────────────────────────────────────────────────────────────────
const COLOR: Record<Player, string> = {
  p1: '#3b82f6', p2: '#ef4444', p3: '#eab308', p4: '#22c55e',
};

// factor > 1 = lighter, < 1 = darker (default 1 = no change)
function hexToRgba(hex: string, a: number, factor = 1): string {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor));
  const g = Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor));
  const b = Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor));
  return `rgba(${r},${g},${b},${a})`;
}

// Shift brightness of a hex color by a multiplier (>1 = lighter, <1 = darker)
function brighten(hex: string, factor: number): string {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * factor));
  const g = Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * factor));
  const b = Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * factor));
  return `rgb(${r},${g},${b})`;
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
  p1:   [COLOR.p1, '#93c5fd', '#fbbf24', '#ffffff', '#818cf8'],
  p2:   [COLOR.p2, '#fca5a5', '#fbbf24', '#ffffff', '#f472b6'],
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

// Falling block — gradient fill + glow, drawn with physics rotation + squash-and-stretch
function drawRotatedBlock(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, angle: number,
  size: number, player: Player,
  squash = 0,
) {
  const baseColor = COLOR[player];
  const w = size * (1 + squash * 0.8);
  const h = size * (1 - squash);
  const r = Math.max(4, Math.min(8, Math.min(w, h) * 0.18));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  ctx.shadowBlur = 22;
  ctx.shadowColor = hexToRgba(baseColor, 0.75);

  const grad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  grad.addColorStop(0, brighten(baseColor, 1.4));
  grad.addColorStop(1, brighten(baseColor, 0.6));
  ctx.fillStyle = grad;
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fill();

  ctx.shadowBlur = 0;

  ctx.strokeStyle = hexToRgba('#ffffff', 0.38);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 8, -h / 2 + 2.5);
  ctx.lineTo(w / 2 - 8, -h / 2 + 2.5);
  ctx.stroke();

  ctx.restore();
}

// Settled block (axis-aligned) — gradient + highlight, optional win glow
function drawSettledBlock(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number,
  size: number, clr: string, isWin: boolean,
) {
  const grad = ctx.createLinearGradient(bx + 4, by + 4, bx + 4, by + 4 + size);
  grad.addColorStop(0, brighten(clr, isWin ? 1.45 : 1.22));
  grad.addColorStop(1, brighten(clr, isWin ? 0.82 : 0.68));
  ctx.fillStyle = grad;
  roundRect(ctx, bx + 4, by + 4, size, size, 8);
  ctx.fill();

  ctx.strokeStyle = hexToRgba('#ffffff', 0.28);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx + 4 + 8, by + 4 + 2.5);
  ctx.lineTo(bx + 4 + size - 8, by + 4 + 2.5);
  ctx.stroke();

  if (isWin) {
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    roundRect(ctx, bx + 4, by + 4, size, size, 8);
    ctx.stroke();
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#fbbf24';
    ctx.strokeStyle = hexToRgba('#fbbf24', 0.45);
    ctx.lineWidth = 9;
    roundRect(ctx, bx + 2, by + 2, size + 4, size + 4, 10);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
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
  bombHud?: { remaining: number; active: boolean; visible: boolean },
) {
  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#0d1424';
  ctx.fillRect(0, 0, W, GRID_Y);

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, GRID_Y, W, ROWS * CELL);

  if (showGrid) {
    ctx.strokeStyle = '#273347';
    ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * CELL, GRID_Y); ctx.lineTo(c * CELL, H); ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, GRID_Y + r * CELL); ctx.lineTo(W, GRID_Y + r * CELL); ctx.stroke();
    }
  }

  const isHumanTurn =
    ui.status === 'playing' && !falling &&
    !(ui.mode === 'cpu' && ui.currentPlayer === 'p2') &&
    !(ui.mode === 'online' && myOnlineRole !== null && ui.currentPlayer !== myOnlineRole);

  if (isHumanTurn && !isBombMode) {
    const clr = COLOR[ui.currentPlayer];
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = hexToRgba(clr, 0.2);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(previewX, 0); ctx.lineTo(previewX, H); ctx.stroke();
    ctx.setLineDash([]);

    const grad = ctx.createLinearGradient(previewX - BLOCK / 2, 4, previewX - BLOCK / 2, 4 + BLOCK);
    grad.addColorStop(0, hexToRgba(clr, 0.55, 1.2));
    grad.addColorStop(1, hexToRgba(clr, 0.35, 0.8));
    ctx.fillStyle = grad;
    roundRect(ctx, previewX - BLOCK / 2, 4, BLOCK, BLOCK, 8);
    ctx.fill();
  }

  // Settled blocks (with optional explosion animation)
  const winSet = new Set((ui.winResult?.cells ?? []).map(([r, c]) => `${r}-${c}`));
  if (!explodeAnim) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = board[r][c];
        if (!cell) continue;
        drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, COLOR[cell], winSet.has(`${r}-${c}`));
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
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, COLOR[cell], winSet.has(key));
          } else if (frame < cd.removeAt) {
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, COLOR[cell], false);
          } else if (frame < cd.removeAt + FADE_DUR) {
            ctx.globalAlpha = 1 - (frame - cd.removeAt) / FADE_DUR;
            drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, COLOR[cell], false);
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
          drawSettledBlock(ctx, c * CELL, GRID_Y + r * CELL, BLOCK, COLOR[cell], winSet.has(`${r}-${c}`));
        }
      }
      for (const d of droppers) {
        const fromY = GRID_Y + d.row * CELL;
        const toY = GRID_Y + d.toRow * CELL;
        drawSettledBlock(ctx, d.col * CELL, fromY + (toY - fromY) * ease, BLOCK, COLOR[d.player], false);
      }
    }
  }

  // Bomb hover highlight
  if (bombHoverCell) {
    const bx = bombHoverCell.col * CELL;
    const by = GRID_Y + bombHoverCell.row * CELL;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    roundRect(ctx, bx + 3, by + 3, CELL - 6, CELL - 6, 7);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Bombs drawn on top of settled blocks
  for (const bomb of bombs) {
    const cx = bomb.col * CELL + CELL / 2;
    const cy = GRID_Y + bomb.row * CELL + CELL / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💣', cx, cy);
    ctx.fillStyle = bomb.turnsLeft === 1 ? '#ef4444' : '#f59e0b';
    ctx.beginPath(); ctx.arc(cx + 11, cy - 11, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(String(bomb.turnsLeft), cx + 11, cy - 11);
  }

  // Falling block
  if (falling) {
    const { x, y } = falling.body.position;
    drawRotatedBlock(ctx, x, y, falling.body.angle, BLOCK, falling.player, squash);
  }
  if (remoteFalling) {
    const { x, y } = remoteFalling.body.position;
    drawRotatedBlock(ctx, x, y, remoteFalling.body.angle, BLOCK, remoteFalling.player, 0);
  }

  // ── Bomb HUD button (bottom-right corner) ────────────────────────────────
  if (bombHud?.visible) {
    const { remaining, active } = bombHud;
    const btnSize = CELL;
    const btnX = W - btnSize - 8;
    const btnY = H - btnSize - 8;
    const hasAmmo = remaining > 0;

    ctx.save();
    ctx.globalAlpha = hasAmmo || active ? 1 : 0.32;

    if (active) { ctx.shadowBlur = 20; ctx.shadowColor = '#ef4444'; }
    roundRect(ctx, btnX, btnY, btnSize, btnSize, 12);
    ctx.fillStyle = active ? 'rgba(239,68,68,0.22)' : 'rgba(10,18,36,0.88)';
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = active ? '#ef4444' : (hasAmmo ? '#475569' : '#1e293b');
    ctx.lineWidth = active ? 2.5 : 1.5;
    roundRect(ctx, btnX, btnY, btnSize, btnSize, 12);
    ctx.stroke();

    ctx.font = '26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💣', btnX + btnSize / 2, btnY + btnSize / 2 - 5);

    ctx.fillStyle = active ? '#f87171' : (hasAmmo ? '#64748b' : '#334155');
    ctx.font = 'bold 8px "Inter", system-ui, sans-serif';
    ctx.fillText(active ? 'CANCEL' : 'BOMB', btnX + btnSize / 2, btnY + btnSize - 8);

    const bx = btnX + btnSize - 12, by = btnY + 12;
    ctx.fillStyle = active ? '#ef4444' : (hasAmmo ? '#10b981' : '#475569');
    ctx.beginPath(); ctx.arc(bx, by, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(remaining), bx, by);

    ctx.restore();
  }

  // ── Win / Draw overlay ───────────────────────────────────────────────────
  if (ui.status === 'won' || ui.status === 'draw') {
    ctx.fillStyle = 'rgba(6,12,26,0.62)';
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

      const winColor = ui.status === 'won' && ui.winner ? COLOR[ui.winner] : '#fbbf24';
      const winLabel = ui.status === 'draw'
        ? 'DRAW'
        : ui.winner === 'p1' ? 'PLAYER 1'
        : ui.winner === 'p2' ? (ui.mode === 'cpu' ? 'CPU' : 'PLAYER 2')
        : ui.winner === 'p3' ? 'PLAYER 3'
        : 'PLAYER 4';

      ctx.shadowBlur = 70;
      ctx.shadowColor = winColor;
      ctx.fillStyle = winColor;
      ctx.font = 'bold 68px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(winLabel, 0, 0);

      if (ui.status === 'won') {
        ctx.shadowBlur = 24;
        ctx.shadowColor = '#ffffff';
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 34px "Inter", system-ui, sans-serif';
        ctx.fillText('WINS!', 0, 64);
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

  // ── Online multiplayer state ───────────────────────────────────────────────
  const onlineRef = useRef<{
    roomCode: string;
    myRole: Player;
    unsubEvent: (() => void) | null;
    unsubAllConnected: (() => void) | null;
    unsubDisconnect: (() => void) | null;
  }>({ roomCode: '', myRole: 'p1', unsubEvent: null, unsubAllConnected: null, unsubDisconnect: null });

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
  const [showGrid, setShowGrid] = useState(false);
  const showGridRef = useRef(false);
  const [showSettingsScreen, setShowSettingsScreen] = useState(false);

  // ── Online UI state ────────────────────────────────────────────────────────
  const [selectedPlayerCount, setSelectedPlayerCount] = useState<PlayerCount>(2);
  const [connectedCount, setConnectedCount] = useState(1);
  const [waitingForStart, setWaitingForStart] = useState(false);
  const [canvasCols, setCanvasCols] = useState(CFG.cols);

  const [onlineScreen, setOnlineScreen] = useState<'menu' | 'join'>('menu');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [onlineError, setOnlineError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectMsg, setDisconnectMsg] = useState('');

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

  // ── Board resize ──────────────────────────────────────────────────────────
  const resetBoardWidth = useCallback((playerCount: PlayerCount) => {
    COLS = colsForPlayerCount(playerCount);
    W = COLS * CELL;
    playerCountRef.current = playerCount;
    previewXRef.current = W / 2;
    setCanvasCols(COLS);
    // Reposition physics walls for new board width
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
      setCountdown(null);
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
      patchUi({ currentPlayer: nextTurn(falling.player, playerCountRef.current) });
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

    const wr = checkWin(newBoard, CFG.winLength);
    if (wr) { clearTurnTimer(); patchUi({ status: 'won', winner: wr.winner, winResult: wr }); return; }
    if (isDraw(newBoard)) { clearTurnTimer(); patchUi({ status: 'draw' }); return; }

    // Timeout streak tracking (only in 2-player modes)
    if (isAuto && playerCountRef.current === 2) {
      timeoutStreakRef.current[falling.player]++;
      if (timeoutStreakRef.current[falling.player] >= MAX_TIMEOUT_STREAK) {
        clearTurnTimer();
        const opponent = nextTurn(falling.player, playerCountRef.current);
        patchUi({ status: 'won', winner: opponent, winResult: null });
        return;
      }
    } else if (!isAuto) {
      timeoutStreakRef.current[falling.player] = 0;
    }

    const next: Player = nextTurn(falling.player, playerCountRef.current);
    patchUi({ currentPlayer: next });

    // Online: emit settle event so remote clients can snap board
    if (uiRef.current.mode === 'online') {
      emitSettle(onlineRef.current.roomCode, falling.player, col, row, isAuto);
    }

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
            setTimeout(() => {
              const cpuCol = getCpuMove(boardRef.current, 'p2', 'p1', CFG.winLength);
              dropBlock(cpuCol * CELL + CELL / 2, 'p2');
            }, 700);
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
      setTimeout(() => {
        const cpuCol = getCpuMove(newBoard, 'p2', 'p1', CFG.winLength);
        dropBlock(cpuCol * CELL + CELL / 2, 'p2');
      }, 700);
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

      const curUi = uiRef.current;
      const isMyTurnNow = curUi.status === 'playing' &&
        !(curUi.mode === 'cpu' && curUi.currentPlayer === 'p2') &&
        !(curUi.mode === 'online' && onlineRef.current.myRole !== curUi.currentPlayer);
      drawFrame(ctx, curUi, fallingRef.current, boardRef.current, previewXRef.current, squashRef.current.value, confettiRef.current, winAnimRef.current.textScale, remoteBodyRef.current, onlineRef.current.myRole, bombsRef.current, bombHoverCellRef.current, actionModeRef.current === 'bomb', explodeAnimRef.current, showGridRef.current, {
        remaining: bombsRemainingRef.current[curUi.currentPlayer],
        active: actionModeRef.current === 'bomb',
        visible: isMyTurnNow,
      });
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
      // Don't highlight the HUD button area as a bomb target
      const btnX = W - CELL - 8, btnY = H - CELL - 8;
      if (rawX >= btnX && rawX <= btnX + CELL && rawY >= btnY && rawY <= btnY + CELL) {
        bombHoverCellRef.current = null;
        return;
      }
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

    // ── HUD bomb button click ─────────────────────────────────────────────
    {
      const isMyTurn = !(s.mode === 'cpu' && s.currentPlayer === 'p2') &&
        !(s.mode === 'online' && s.currentPlayer !== onlineRef.current.myRole);
      if (isMyTurn) {
        const btnX = W - CELL - 8, btnY = H - CELL - 8;
        if (rawX >= btnX && rawX <= btnX + CELL && rawY >= btnY && rawY <= btnY + CELL) {
          if (bombsRemainingRef.current[s.currentPlayer] > 0 || actionModeRef.current === 'bomb') {
            const next: 'drop' | 'bomb' = actionModeRef.current === 'bomb' ? 'drop' : 'bomb';
            actionModeRef.current = next;
            if (next === 'drop') bombHoverCellRef.current = null;
          }
          return;
        }
      }
    }

    if (actionModeRef.current === 'bomb') {
      if (s.mode === 'cpu' && s.currentPlayer === 'p2') return;
      if (s.mode === 'online' && s.currentPlayer !== onlineRef.current.myRole) return;
      const bCol = Math.floor(rawX / CELL);
      const bRow = Math.floor((rawY - GRID_Y) / CELL);
      if (rawY >= GRID_Y && bRow >= 0 && bRow < ROWS && bCol >= 0 && bCol < COLS) {
        const cell = boardRef.current[bRow]?.[bCol];
        if (cell !== null && cell !== undefined && cell !== s.currentPlayer && bombsRemainingRef.current[s.currentPlayer] > 0) {
          placeBombAt(bCol, bRow);
          return;
        }
      }
      // Clicked on invalid target — cancel bomb mode
      actionModeRef.current = 'drop';
      bombHoverCellRef.current = null;
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
  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
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
    const resetBombs = { p1: BOMBS_PER_PLAYER, p2: BOMBS_PER_PLAYER, p3: BOMBS_PER_PLAYER, p4: BOMBS_PER_PLAYER };
    bombsRemainingRef.current = resetBombs;
  };

  const startGame = (mode: GameMode) => {
    resetBoardWidth(2); // 2player/cpu always use 10 cols
    clearPhysics();
    timeoutStreakRef.current = { p1: 0, p2: 0, p3: 0, p4: 0 };
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
      if (wasAuto && playerCountRef.current === 2) {
        timeoutStreakRef.current[player]++;
        if (timeoutStreakRef.current[player] >= MAX_TIMEOUT_STREAK) {
          clearTurnTimer();
          const opponent = nextTurn(player, playerCountRef.current);
          patchUi({ status: 'won', winner: opponent, winResult: null });
          return;
        }
      } else if (!wasAuto) {
        timeoutStreakRef.current[player] = 0;
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
      bombsRemainingRef.current = { ...bombsRemainingRef.current, [ev.player]: bombsRemainingRef.current[ev.player] - 1 };
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
    bombsRemainingRef.current = { ...bombsRemainingRef.current, [player]: bombsRemainingRef.current[player] - 1 };
    actionModeRef.current = 'drop';
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
    onlineRef.current.unsubEvent = null;
    onlineRef.current.unsubAllConnected = null;
    onlineRef.current.unsubDisconnect = null;
    if (onlineRef.current.roomCode) {
      removeRoom(onlineRef.current.roomCode);
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
    leaveOnlineRoom();
    resetBoardWidth(2);
    clearPhysics();
    patchUi({ ...INIT_UI });
  };

  // ── UI helpers ────────────────────────────────────────────────────────────
  const playerLabel = (p: Player) => {
    if (p === 'p1') return 'Player 1';
    if (p === 'p2') return ui.mode === 'cpu' ? 'CPU' : 'Player 2';
    if (p === 'p3') return 'Player 3';
    return 'Player 4';
  };

  const statusColor = () => {
    if (ui.status === 'waiting') return '#60a5fa';
    if (ui.status === 'won' && ui.winner) return COLOR[ui.winner];
    if (ui.status === 'draw') return '#fbbf24';
    return COLOR[ui.currentPlayer];
  };

  const statusText = () => {
    if (ui.status === 'waiting') return waitingForStart ? 'ホストを待っています…' : 'Waiting for players…';
    if (ui.status === 'won' && ui.winner) return `${playerLabel(ui.winner)} WIN 🎉`;
    if (ui.status === 'draw') return 'DRAW';
    if (ui.mode === 'online') {
      return ui.currentPlayer === onlineRef.current.myRole ? 'Your Turn' : "Opponent's Turn";
    }
    return `${playerLabel(ui.currentPlayer)}'s Turn`;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#060c1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 16, fontFamily: '"Inter", system-ui, sans-serif' }}>

      {/* Player turn indicator */}
      {(ui.status === 'playing' || ui.status === 'won' || ui.status === 'draw' || ui.status === 'waiting') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(), boxShadow: `0 0 10px ${statusColor()}` }} />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2, color: statusColor(), textTransform: 'uppercase' }}>
            {statusText()}
          </span>
          {ui.status === 'playing' && countdown !== null && (
            <span style={{
              fontSize: 12, fontWeight: 700,
              color: countdown > 20 ? '#10b981' : countdown > 10 ? '#fbbf24' : '#ef4444',
              minWidth: 34, textAlign: 'right',
            }}>{countdown}s</span>
          )}
        </div>
      )}

      {/* Canvas — horizontally scrollable for wide boards */}
      <div style={{ position: 'relative', overflowX: 'auto', maxWidth: '100vw' }}>
        <canvas
          ref={canvasRef}
          width={canvasCols * CELL}
          height={H}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ borderRadius: 14, display: 'block', cursor: ui.status === 'playing' ? 'crosshair' : 'default', touchAction: 'none' }}
        />

        {/* ── Guest waiting for host overlay ──────────────────────────────── */}
        {waitingForStart && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            background: 'rgba(6,12,26,0.92)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 24,
          }}>
            <div style={{ fontSize: 48 }}>⏳</div>
            <div style={{ color: '#60a5fa', fontSize: 18, fontWeight: 700 }}>
              ホストがゲームを準備中…
            </div>
            <div style={{ color: '#475569', fontSize: 13 }}>
              全員が揃うまで待ちます
            </div>
            <button
              onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
              style={{ padding: '10px 28px', borderRadius: 10, border: 'none', background: '#334155', color: '#fff', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              キャンセル
            </button>
          </div>
        )}

        {/* ── Opponent disconnect overlay ──────────────────────────────────── */}
        {disconnectMsg && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            background: 'rgba(6,12,26,0.92)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 24,
          }}>
            <div style={{ fontSize: 48 }}>📡</div>
            <div style={{ color: '#f87171', fontSize: 20, fontWeight: 700 }}>{disconnectMsg}</div>
            <button
              onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
              style={{ padding: '12px 32px', borderRadius: 10, border: 'none', background: '#334155', color: '#fff', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              メニューへ
            </button>
          </div>
        )}

        {/* ── Title / Mode selection / Online / Waiting overlay ───────────── */}
        {(ui.status === 'idle' || ui.status === 'waiting') && !waitingForStart && (
          <div style={{
            position: 'absolute', inset: 0, borderRadius: 14,
            background: 'rgba(6,12,26,0.94)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 44,
          }}>

            {/* ── Normal mode select ── */}
            {!showSettingsScreen && ui.status === 'idle' && ui.mode !== 'online' && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  fontSize: 54, fontWeight: 900, letterSpacing: 10,
                  background: 'linear-gradient(135deg, #60a5fa 0%, #818cf8 55%, #c084fc 100%)',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', lineHeight: 1.1,
                }}>
                  BLOCK FIVE
                </div>
                <p style={{ color: '#334155', fontSize: 12, marginTop: 10, letterSpacing: 3, textTransform: 'uppercase' }}>
                  Physics · Strategy · 5-in-a-row
                </p>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
                {([
                  { mode: '2player' as GameMode, icon: '👥', label: '2 Player', sub: 'Same device' , color: COLOR.p1 },
                  { mode: 'online'  as GameMode, icon: '🌐', label: 'Online',   sub: 'Remote match', color: '#10b981' },
                  { mode: 'cpu'     as GameMode, icon: '🤖', label: 'vs CPU',   sub: 'Challenge AI', color: COLOR.p2 },
                ]).map(({ mode, icon, label, sub, color }) => (
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
                      width: 136, padding: '26px 14px', borderRadius: 16,
                      border: `1.5px solid ${hexToRgba(color, 0.45)}`,
                      background: `linear-gradient(150deg, ${hexToRgba(color, 0.14)} 0%, ${hexToRgba(color, 0.04)} 100%)`,
                      boxShadow: `0 0 32px ${hexToRgba(color, 0.1)}, inset 0 1px 0 ${hexToRgba('#ffffff', 0.07)}`,
                      cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                      fontFamily: 'inherit', transition: 'transform 0.15s, box-shadow 0.15s',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 0 48px ${hexToRgba(color, 0.22)}, inset 0 1px 0 ${hexToRgba('#ffffff', 0.1)}`;
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.transform = '';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 0 32px ${hexToRgba(color, 0.1)}, inset 0 1px 0 ${hexToRgba('#ffffff', 0.07)}`;
                    }}
                  >
                    <span style={{ fontSize: 38 }}>{icon}</span>
                    <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15, letterSpacing: 1 }}>{label}</span>
                    <span style={{ color: '#475569', fontSize: 11, letterSpacing: 0.5 }}>{sub}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowSettingsScreen(true)}
                style={{
                  padding: '6px 16px', borderRadius: 8,
                  border: '1px solid #1e293b', background: 'transparent',
                  color: '#334155', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 1,
                }}
              >⚙️ Settings</button>
            </>)}

            {/* ── Settings screen ── */}
            {showSettingsScreen && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 6 }}>⚙️</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#f1f5f9', letterSpacing: 4 }}>SETTINGS</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: 240, background: '#0f172a', borderRadius: 14, overflow: 'hidden', border: '1px solid #1e293b' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}>
                  <div>
                    <div style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600 }}>格子柄</div>
                    <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>グリッドラインの表示</div>
                  </div>
                  <div
                    onClick={() => { const n = !showGrid; setShowGrid(n); showGridRef.current = n; }}
                    style={{ width: 42, height: 24, borderRadius: 12, background: showGrid ? '#3b82f6' : '#334155', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
                  >
                    <div style={{ position: 'absolute', top: 3, left: showGrid ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowSettingsScreen(false)}
                style={{
                  padding: '8px 18px', borderRadius: 8,
                  border: '1px solid #1e293b', background: 'transparent',
                  color: '#334155', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 1,
                }}
              >← Back</button>
            </>)}

            {/* ── Online sub-menu ── */}
            {!showSettingsScreen && ui.status === 'idle' && ui.mode === 'online' && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 6 }}>🌐</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#f1f5f9', letterSpacing: 4 }}>ONLINE MATCH</div>
                <p style={{ color: '#475569', fontSize: 12, marginTop: 8, letterSpacing: 2 }}>
                  Create a room or join with a code
                </p>
              </div>

              {onlineScreen === 'menu' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>

                  {/* Player count selector */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                    <div style={{ color: '#64748b', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>プレイ人数</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {([2, 3, 4] as PlayerCount[]).map(n => (
                        <button
                          key={n}
                          onClick={() => setSelectedPlayerCount(n)}
                          style={{
                            width: 56, height: 40, borderRadius: 8,
                            border: `1.5px solid ${selectedPlayerCount === n ? '#10b981' : '#1e293b'}`,
                            background: selectedPlayerCount === n ? 'rgba(16,185,129,0.15)' : 'transparent',
                            color: selectedPlayerCount === n ? '#10b981' : '#475569',
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
                      border: '1.5px solid #10b981', background: 'rgba(16,185,129,0.12)',
                      color: '#10b981', fontSize: 14, fontWeight: 700, letterSpacing: 1,
                      cursor: isConnecting ? 'wait' : 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {isConnecting ? '作成中…' : '🏠 ルームを作る（P1）'}
                  </button>
                  <button
                    onClick={() => { setOnlineScreen('join'); setOnlineError(''); }}
                    style={{
                      width: 220, padding: '16px 20px', borderRadius: 12,
                      border: '1.5px solid #60a5fa', background: 'rgba(96,165,250,0.10)',
                      color: '#60a5fa', fontSize: 14, fontWeight: 700, letterSpacing: 1,
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    🔑 ルームに参加
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
                      border: '1.5px solid #334155', background: '#0f172a',
                      color: '#f1f5f9', fontSize: 24, fontWeight: 700, letterSpacing: 8,
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
                        border: '1.5px solid #60a5fa', background: 'rgba(96,165,250,0.12)',
                        color: '#60a5fa', fontSize: 13, fontWeight: 700,
                        cursor: isConnecting ? 'wait' : 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {isConnecting ? '接続中…' : '参加する'}
                    </button>
                    <button
                      onClick={() => { setOnlineScreen('menu'); setOnlineError(''); }}
                      style={{
                        padding: '12px 20px', borderRadius: 10,
                        border: '1.5px solid #334155', background: 'transparent',
                        color: '#475569', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >戻る</button>
                  </div>
                </div>
              )}

              {onlineError && (
                <p style={{ color: '#ef4444', fontSize: 12, marginTop: -20 }}>{onlineError}</p>
              )}

              <button
                onClick={() => patchUi({ status: 'idle', mode: '2player' })}
                style={{
                  padding: '8px 18px', borderRadius: 8,
                  border: '1px solid #1e293b', background: 'transparent',
                  color: '#334155', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 1,
                }}
              >← Back to menu</button>
            </>)}

            {/* ── Waiting for players (host) ── */}
            {!showSettingsScreen && ui.status === 'waiting' && (<>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', letterSpacing: 2 }}>
                  Waiting for players
                </div>
                <p style={{ color: '#10b981', fontSize: 16, fontWeight: 700, marginTop: 10 }}>
                  {connectedCount} / {selectedPlayerCount} 人参加済み
                </p>
                <p style={{ color: '#475569', fontSize: 12, marginTop: 4 }}>
                  Share this code with your friends
                </p>
              </div>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
              }}>
                <div style={{
                  fontSize: 52, fontWeight: 900, letterSpacing: 16,
                  color: '#10b981', fontFamily: 'monospace',
                  background: 'rgba(16,185,129,0.08)', padding: '16px 32px', borderRadius: 14,
                  border: '2px solid rgba(16,185,129,0.3)',
                }}>
                  {createdCode}
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(createdCode)}
                  style={{
                    padding: '8px 20px', borderRadius: 8,
                    border: '1px solid #334155', background: 'rgba(255,255,255,0.04)',
                    color: '#94a3b8', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >📋 Copy code</button>
              </div>
              <button
                onClick={() => setShowSettingsScreen(true)}
                style={{
                  padding: '6px 16px', borderRadius: 8,
                  border: '1px solid #1e293b', background: 'transparent',
                  color: '#334155', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 1,
                }}
              >⚙️ Settings</button>

              <button
                onClick={() => { leaveOnlineRoom(); patchUi({ status: 'idle', mode: 'online' }); }}
                style={{
                  padding: '8px 18px', borderRadius: 8,
                  border: '1px solid #1e293b', background: 'transparent',
                  color: '#334155', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 1,
                }}
              >Cancel</button>
            </>)}
          </div>
        )}
      </div>

      {/* Action buttons — shown after game ends */}
      {(ui.status === 'won' || ui.status === 'draw') && (
        <div style={{ display: 'flex', gap: 12 }}>
          {ui.mode !== 'online' && (
            <button onClick={() => startGame(ui.mode)} style={actionBtn('#16a34a')}>Play Again</button>
          )}
          <button onClick={resetGame} style={actionBtn('#334155')}>Main Menu</button>
        </div>
      )}
    </div>
  );
}

function actionBtn(color: string): React.CSSProperties {
  return {
    padding: '11px 24px', borderRadius: 10,
    border: `1.5px solid ${color}`,
    background: 'transparent', color,
    fontSize: 13, fontWeight: 700, letterSpacing: 1,
    cursor: 'pointer', textTransform: 'uppercase',
  } as React.CSSProperties;
}
