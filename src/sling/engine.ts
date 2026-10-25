// "Pull everything" game engine: physics, finger input, turn flow and canvas drawing.
// Ported from wireframes/sling-play-mock.html (the agreed reference). Keep numbers in sync with
// docs/requirements/2026-10-26_引っぱる操作の本体移行.md.
import Matter from 'matter-js';
import { COLORS } from '../theme';
import {
  ARM_LEN, BOMB_EVERY, COLS, LEVEL_NAME, NAME, ROWS, WIN_LEN, blastCells, compact, emptyGrid, judge, levelFromImpact, other, topEmpty,
  type BlastLevel, type SGrid, type SPlayer,
} from './rules';
import { TONE, bombShape, easeIn, easeOut, gummy, rr } from './draw';
import { getCpuMove } from '../cpuPlayer';

const { Engine, Bodies, Body, Composite, Events } = Matter;

// ── Layout (canvas units; the canvas is scaled by CSS) ──────────────
export const CELL = 34;
const TOP = 30;
export const W = COLS * CELL;
const GY = TOP, BOARD_H = ROWS * CELL, PAD_Y = GY + BOARD_H, PAD_H = 100;
export const H = PAD_Y + PAD_H;
const HOME = { x: W / 2, y: PAD_Y + 42 };
const MAX_PULL = 110, BOMB_R_NEAR = CELL * 0.75, BOMB_R_FAR = CELL * 0.34, BLOCK = CELL - 8;

// ── Feel (agreed in the mock) ───────────────────────────────────────
const SENS = 22;          // px of pull per column
const WOBBLE = 0.1;       // aim wobble, in cells
const DRIFT = 0.05;       // sideways flow when released off the column centre
const ARM = 14;           // a gummy needs this much pull DOWN before it can be thrown
const CHARGE_SEC = 0.9;   // power bar: empty → full
const FUSE_MS = 500;
const DEMO_KEY = 'slingDemoSeen';

export type Holding = 'gummy' | 'bomb';
type State = 'idle' | 'drawing' | 'flying' | 'falling' | 'rolling' | 'stuck' | 'exploding';
type Pt = { x: number; y: number };
type CellBody = Matter.Body & { cell?: { c: number; r: number } };

interface GummyShot { kind: 'gummy'; aimX: number; col: number; t0: number; player: SPlayer; sx: number; sy: number }
interface BombShot { kind: 'bomb'; target: { c: number; r: number }; power: number; core: boolean; t0: number; player: SPlayer; sx: number; sy: number }
type Shot = GummyShot | BombShot;
interface Fuse { c: number; r: number; at: number; level: BlastLevel }
interface Explosion { c: number; r: number; level: BlastLevel; frame: number; hitCount: number; cells: { rr: number; cc: number; p: SPlayer | null }[] }
interface Shard { x: number; y: number; vx: number; vy: number; rot: number; vr: number; s: number; p: SPlayer; t0: number; life: number }

export interface SlingUi {
  current: SPlayer; winner: SPlayer | null; isDraw: boolean; endNote: string; holding: Holding;
  bombs: Record<SPlayer, number>; charge: Record<SPlayer, number>; bombUsed: Record<SPlayer, boolean>; wins: Record<SPlayer, number>;
  gameOver: boolean; busy: boolean; cpuTurn: boolean;
}

// The CPU (always p2) shows the same pull as a person: grab, pull, hold, let go
interface CpuPlan { start: number; pullEnd: number; releaseAt: number; dx: number; dy: number }

const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class SlingEngine {
  private cv: HTMLCanvasElement; private fx: HTMLCanvasElement;
  private mainCtx: CanvasRenderingContext2D; private fxCtx: CanvasRenderingContext2D; private ctx: CanvasRenderingContext2D;
  private onUi: (ui: SlingUi) => void;
  private dpr = Math.min(window.devicePixelRatio || 1, 3);
  private engine = Engine.create();
  private statics: Matter.Body[] = [];
  private raf = 0; private lastT = 0; private acc = 0;
  private cleanups: (() => void)[] = [];

  // game
  grid: SGrid = emptyGrid();
  current: SPlayer = 'p1'; winner: SPlayer | null = null; isDraw = false; endNote = ''; gameOver = false;
  holding: Holding = 'gummy';
  bombs: Record<SPlayer, number> = { p1: 0, p2: 0 };
  charge: Record<SPlayer, number> = { p1: 0, p2: 0 };
  bombUsed: Record<SPlayer, boolean> = { p1: false, p2: false };   // one bomb per game
  wins: Record<SPlayer, number> = { p1: 0, p2: 0 };
  private nextStarter: SPlayer = 'p1';
  private winCells: [number, number][] | null = null;

  // throw
  state: State = 'idle';
  private pointer: Pt = { x: 0, y: 0 }; private grab: Pt = { x: 0, y: 0 }; private pointerId: number | null = null;
  private drawStart = 0; private coreLo = 0.5; private coreW = 0.07;
  private shot: Shot | null = null; private body: Matter.Body | null = null;
  private still = 0; private fallStart = 0; private firstTouch = false;
  private rollStart = 0; private maxImpact = 0; private impactCap = Infinity; private shownLvl = 0;
  private stickTo: { c: number; r: number; impact: number } | null = null;
  private fuse: Fuse | null = null; private explosion: Explosion | null = null;

  // effects
  private flash: { text: string; x: number; y: number; at: number } | null = null; private flashDur = 900;
  private slip: { from: number; fromRow: number; to: number; row: number; at: number } | null = null;
  private hits: { text: string; x: number; y: number; at: number; lvl: number }[] = [];
  private ripple: { x: number; y: number; at: number } | null = null;
  private settleAnim: { at: number; from: Record<string, number> } | null = null;
  private shards: Shard[] = [];
  private bombGotFor: SPlayer | null = null; private bombGotAt = 0;
  private padHintAt = -Infinity;
  private cpuNudgeAt = -Infinity;   // the person tried to pull during the CPU's turn
  private seen: Record<Holding, boolean> = { gummy: false, bomb: false };

  private cpu: boolean;
  private cpuPlan: CpuPlan | null = null;
  private cpuWaitFrom = 0;
  readonly names: Record<SPlayer, string>;

  constructor(cv: HTMLCanvasElement, fx: HTMLCanvasElement, onUi: (ui: SlingUi) => void, opts: { cpu?: boolean } = {}) {
    this.cv = cv; this.fx = fx; this.onUi = onUi;
    this.cpu = !!opts.cpu;
    this.names = { p1: NAME.p1, p2: this.cpu ? 'CPU' : NAME.p2 };
    this.mainCtx = cv.getContext('2d')!; this.fxCtx = fx.getContext('2d')!; this.ctx = this.mainCtx;
    cv.width = W * this.dpr; cv.height = H * this.dpr;
    try { Object.assign(this.seen, JSON.parse(localStorage.getItem(DEMO_KEY) || '{}')); } catch { /* storage blocked */ }
    Events.on(this.engine, 'collisionStart', this.onCollision);
    this.attachInput();
    this.newGame();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach(f => f());
    Events.off(this.engine, 'collisionStart', this.onCollision);
    Composite.clear(this.engine.world, false);
    Engine.clear(this.engine);
  }

  // ── Public actions ─────────────────────────────────────────────────
  newGame() {
    this.grid = emptyGrid();
    this.current = this.nextStarter; this.winner = null; this.isDraw = false; this.endNote = ''; this.gameOver = false;
    this.bombs = { p1: 0, p2: 0 }; this.charge = { p1: 0, p2: 0 }; this.bombUsed = { p1: false, p2: false }; this.holding = 'gummy'; this.winCells = null;
    this.flash = null; this.slip = null; this.hits = []; this.bombGotFor = null; this.ripple = null; this.settleAnim = null; this.shards = [];
    this.clearFlying(); this.rebuildStatics(); this.sync();
  }
  isCpuTurn() { return this.cpu && this.current === 'p2' && !this.gameOver; }
  resetWins() { this.wins = { p1: 0, p2: 0 }; this.newGame(); }
  toggleBomb() {
    if (this.state !== 'idle' || this.gameOver || this.isCpuTurn()) return;
    if (this.holding === 'bomb') this.holding = 'gummy';
    else if (this.bombs[this.current] > 0) this.holding = 'bomb';
    this.sync();
  }

  private sync() {
    if (this.holding === 'bomb' && this.bombs[this.current] === 0 && this.state === 'idle') this.holding = 'gummy';
    this.onUi({
      current: this.current, winner: this.winner, isDraw: this.isDraw, endNote: this.endNote, holding: this.holding,
      bombs: { ...this.bombs }, charge: { ...this.charge }, bombUsed: { ...this.bombUsed }, wins: { ...this.wins }, gameOver: this.gameOver, busy: this.state !== 'idle', cpuTurn: this.isCpuTurn(),
    });
  }

  // ── Physics helpers ────────────────────────────────────────────────
  private rebuildStatics() {
    this.statics.forEach(b => Composite.remove(this.engine.world, b));
    this.statics = [
      Bodies.rectangle(W / 2, PAD_Y + 25, W + 100, 50, { isStatic: true }),
      Bodies.rectangle(-25, GY + BOARD_H / 2, 50, BOARD_H * 3, { isStatic: true }),
      Bodies.rectangle(W + 25, GY + BOARD_H / 2, 50, BOARD_H * 3, { isStatic: true }),
    ];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.grid[r][c]) {
      const g: CellBody = Bodies.rectangle(c * CELL + CELL / 2, GY + r * CELL + CELL / 2, BLOCK, BLOCK, { isStatic: true, chamfer: { radius: 8 }, friction: 0.1 });
      g.cell = { c, r }; this.statics.push(g);
    }
    Composite.add(this.engine.world, this.statics);
  }
  private clearFlying() {
    if (this.body) Composite.remove(this.engine.world, this.body);
    this.body = null; this.shot = null; this.fuse = null; this.explosion = null; this.stickTo = null; this.cpuPlan = null; this.state = 'idle';
  }
  private colOf = (x: number) => Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
  private topEmpty = (c: number) => topEmpty(this.grid, c);

  // ── Aiming ─────────────────────────────────────────────────────────
  private chargePower(now: number) { const p = ((now - this.drawStart) / 1000 / CHARGE_SEC) % 2; return p <= 1 ? p : 2 - p; }
  private isCore = (pw: number) => pw >= this.coreLo && pw <= this.coreLo + this.coreW;
  // Pull is measured from where the finger went down; x and y clamped separately
  private pullVec() {
    const dx = Math.max(-MAX_PULL, Math.min(MAX_PULL, this.pointer.x - this.grab.x));
    const dy = Math.max(0, Math.min(MAX_PULL, this.pointer.y - this.grab.y));
    return { dx, dy, len: Math.hypot(dx, dy) };
  }
  // Gummy: a small pull down arms it. Bomb: a short hold arms it; moving back above the press point cancels.
  private isArmed() {
    if (this.holding === 'gummy') return this.pullVec().dy >= ARM;
    return performance.now() - this.drawStart >= 300 && this.pointer.y >= this.grab.y - 16;
  }
  // Pull sideways → the opposite column. Bomb: half of the max pull reaches the top row.
  private aimPoint(now: number) {
    const { dx, dy } = this.pullVec(), t = now / 1000;
    if (this.holding === 'gummy') {
      const amp = WOBBLE * CELL;
      const x = W / 2 - dx * (CELL / SENS) + amp * (Math.sin(t * 2.3) * 0.6 + Math.sin(t * 5.1 + 1) * 0.4);
      return { x: Math.max(4, Math.min(W - 4, x)), y: GY + BOARD_H / 2 };
    }
    const amp = Math.min(6, 2 + Math.max(0, (now - this.drawStart) / 1000 - 1.5) * 2);
    return {
      x: Math.max(2, Math.min(W - 2, W / 2 - dx * (W / 2) / MAX_PULL + amp * (Math.sin(t * 2.1) * 0.6 + Math.sin(t * 5.3 + 1) * 0.4))),
      y: GY + BOARD_H - 4 - Math.min(1, dy / (MAX_PULL * 0.5)) * (BOARD_H + 18) + amp * (Math.sin(t * 1.7 + 2) * 0.6 + Math.sin(t * 4.1) * 0.4),
    };
  }

  // ── Input ──────────────────────────────────────────────────────────
  private local(e: PointerEvent): Pt {
    const r = this.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }
  private attachInput() {
    const cv = this.cv, mine = (e: PointerEvent) => e.pointerId === this.pointerId;
    const cancel = () => { if (this.state === 'drawing' && !this.cpuPlan) { this.state = 'idle'; this.sync(); } };
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void) => {
      t.addEventListener(type, fn as EventListener); this.cleanups.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(cv, 'pointerdown', (e: PointerEvent) => {
      if (this.gameOver || e.button !== 0) return;   // the result card starts the next game
      const p = this.local(e);
      if (this.isCpuTurn()) { if (p.y >= PAD_Y - 10) this.cpuNudgeAt = performance.now(); return; }
      if (this.state !== 'idle') return;
      if (p.y < PAD_Y - 10) { this.padHintAt = performance.now(); return; }   // tapped the jar: point at the launcher
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this.state = 'drawing'; this.pointer = p; this.grab = p; this.pointerId = e.pointerId; this.drawStart = performance.now();
      if (!this.seen[this.holding]) this.markSeen(this.holding);
      this.slip = null; this.flash = null; this.hits = [];
      this.coreW = 0.04 + Math.random() * 0.06; this.coreLo = 0.3 + Math.random() * (0.9 - this.coreW - 0.3);   // differs every throw
      this.sync();
    });
    on(cv, 'pointermove', (e: PointerEvent) => { if (this.state === 'drawing' && mine(e)) this.pointer = this.local(e); });
    on(cv, 'pointerup', (e: PointerEvent) => { if (this.state === 'drawing' && mine(e)) this.release(); });
    on(cv, 'pointercancel', (e: PointerEvent) => { if (mine(e)) cancel(); });
    on(cv, 'lostpointercapture', (e: PointerEvent) => { if (mine(e)) cancel(); });
    // a touch long-press (holding a bomb for the gold band) can fire contextmenu: swallow it, only a mouse right-click cancels
    on(cv, 'contextmenu', (e: PointerEvent) => { e.preventDefault(); if (e.pointerType !== 'touch') cancel(); });
    on(window, 'blur', cancel);
    on(document, 'visibilitychange', () => { if (document.hidden) cancel(); });
  }
  private markSeen(kind: Holding) {
    this.seen[kind] = true;
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.seen)); } catch { /* storage blocked */ }
  }

  private release() {
    const now = performance.now(), a = this.aimPoint(now);
    this.cpuPlan = null;
    if (!this.isArmed()) { this.state = 'idle'; this.flashText('やめました'); this.sync(); return; }
    const { dx, dy } = this.pullVec(), sx = HOME.x + dx * 0.55, sy = HOME.y + dy * 0.55;
    if (this.holding === 'gummy') {
      const col = this.colOf(a.x);
      if (this.topEmpty(col) < 0) { this.state = 'idle'; this.flashText('そこは いっぱい'); this.sync(); return; }
      this.shot = { kind: 'gummy', aimX: a.x, col, t0: now, player: this.current, sx, sy };
    } else {
      const pw = this.chargePower(now);
      this.shot = {
        kind: 'bomb', target: { c: this.colOf(a.x), r: Math.max(-1, Math.min(ROWS - 1, Math.floor((a.y - GY) / CELL))) },
        power: pw, core: this.isCore(pw), t0: now, player: this.current, sx, sy,
      };
      this.bombs[this.current] = 0; this.bombUsed[this.current] = true;   // used up the moment it is thrown, hit or miss — and no more this game
    }
    this.state = 'flying';
    this.sync();
  }

  // ── Arrivals ───────────────────────────────────────────────────────
  private gummyArrive(s: GummyShot) {
    const entryY = GY - CELL * 0.5;
    const body = Bodies.rectangle(s.aimX, entryY, BLOCK, BLOCK, { chamfer: { radius: 8 }, restitution: 0.15, friction: 0.4, frictionAir: 0.01 });
    // Sideways speed grows with how far from the column centre it was released (scaled to the fall height)
    const fall = Math.max(CELL, GY + this.topEmpty(s.col) * CELL - entryY);
    const drift = (s.aimX - (s.col * CELL + CELL / 2)) * DRIFT * 0.25 * Math.min(2.0, Math.sqrt(BOARD_H / fall)) / Math.sqrt(BOARD_H / (BOARD_H - CELL));
    Body.setInertia(body, Infinity);
    Body.setVelocity(body, { x: drift, y: 4 });
    Composite.add(this.engine.world, body);
    this.body = body; this.still = 0; this.firstTouch = false; this.fallStart = performance.now(); this.state = 'falling';
  }
  private gummySettle(s: GummyShot) {
    const x = this.body!.position.x;
    Composite.remove(this.engine.world, this.body!); this.body = null;
    let col = this.colOf(x);
    const aimRow = this.topEmpty(s.col);   // where it would have landed in the aimed column
    if (this.topEmpty(col) < 0) {
      for (let d = 1; d < COLS; d++) {
        if (col - d >= 0 && this.topEmpty(col - d) >= 0) { col -= d; break; }
        if (col + d < COLS && this.topEmpty(col + d) >= 0) { col += d; break; }
      }
    }
    const row = this.topEmpty(col);
    this.grid[row][col] = s.player;
    if (col !== s.col) {
      this.slip = { from: s.col, fromRow: aimRow, to: col, row, at: performance.now() };
      const n = Math.abs(col - s.col);
      this.flashText(n === 1 ? 'おっと！ となりへ' : `おっと！ ${n}れつ ずれた`, col * CELL + CELL / 2, GY + row * CELL - 6);
    }
    this.rebuildStatics();
    if (this.bombs[s.player] === 0 && !this.bombUsed[s.player]) {
      this.charge[s.player] = Math.min(BOMB_EVERY, this.charge[s.player] + 1);
      if (this.charge[s.player] === BOMB_EVERY) { this.bombs[s.player] = 1; this.bombGotFor = s.player; this.bombGotAt = performance.now() + (this.flash ? 900 : 0); }
    }
    this.endTurn();
  }
  private blastLevel(s: BombShot, lv: BlastLevel): BlastLevel { return s.core ? 4 : lv; }
  private bombArrive(s: BombShot) {
    const { target } = s, cx = target.c * CELL + CELL / 2, speed = 3 + s.power * 10;
    if (target.r < 0) { this.startRoll(cx, GY - CELL * 0.4, speed); return; }
    if (this.grid[target.r][target.c]) {
      const impact = speed * (0.75 + Math.random() * 0.3);
      this.hitText(impact, cx, GY + target.r * CELL);
      this.fuse = { c: target.c, r: target.r, at: performance.now(), level: this.blastLevel(s, levelFromImpact(impact)) };
      this.state = 'stuck'; return;
    }
    this.startRoll(cx, GY + target.r * CELL + CELL / 2, speed);
  }
  private startRoll(x: number, y: number, speed: number) {
    const body = Bodies.circle(x, y, BOMB_R_FAR, { restitution: 0.35, friction: 0.1, frictionAir: 0.01, density: 0.004 });
    Body.setVelocity(body, { x: (Math.random() - 0.5) * speed * 0.24, y: speed * 0.45 });
    Composite.add(this.engine.world, body);
    this.body = body; this.maxImpact = speed * 0.3; this.impactCap = speed * (0.75 + Math.random() * 0.3);
    this.shownLvl = 0; this.still = 0; this.stickTo = null; this.rollStart = performance.now(); this.state = 'rolling';
  }
  private onCollision = (ev: Matter.IEventCollision<Matter.Engine>) => {
    const body = this.body; if (!body) return;
    const mineP = ev.pairs.filter(pr => pr.bodyA === body || pr.bodyB === body);
    if (!mineP.length) return;
    if (this.state === 'falling' && !this.firstTouch) {
      // landing soaks up most of the sideways drift, so only edge releases / corners make it slip
      this.firstTouch = true;
      Body.setVelocity(body, { x: body.velocity.x * 0.2, y: body.velocity.y });
    }
    if (this.state !== 'rolling') return;
    for (const pr of mineP) {
      const v = body.velocity, impact = Math.hypot(v.x, v.y);
      const hit = (pr.bodyA === body ? pr.bodyB : pr.bodyA) as CellBody;
      // a bomb aimed at an empty cell sticks to the first gummy it touches (floor/walls only make it roll)
      if (hit.cell && !this.stickTo) this.stickTo = { ...hit.cell, impact: Math.min(Math.max(impact, this.maxImpact), this.impactCap) };
      const lv = levelFromImpact(Math.min(impact, this.impactCap));
      if (impact > 1.5 && lv > this.shownLvl) { this.shownLvl = lv; this.hitText(Math.min(impact, this.impactCap), body.position.x, body.position.y - 14); }
      this.maxImpact = Math.max(this.maxImpact, impact);
    }
  };
  private hitText(impact: number, x: number, y: number) {
    const lvl = levelFromImpact(impact);
    this.hits.push({ text: LEVEL_NAME[lvl], x: Math.max(30, Math.min(W - 30, x)), y, at: performance.now(), lvl });
  }
  private bombSettle(s: BombShot, now: number) {
    const { x, y } = this.body!.position;
    Composite.remove(this.engine.world, this.body!); this.body = null;
    // falling can't make it stronger than the throw
    this.fuse = { c: this.colOf(x), r: Math.max(0, Math.min(ROWS - 1, Math.floor((y - GY) / CELL))), at: now, level: this.blastLevel(s, levelFromImpact(Math.min(this.maxImpact, this.impactCap))) };
    this.state = 'stuck';
  }
  private bombStick(s: BombShot, now: number) {
    Composite.remove(this.engine.world, this.body!); this.body = null;
    const { c, r, impact } = this.stickTo!; this.stickTo = null;
    this.ripple = { x: c * CELL + CELL / 2, y: GY + r * CELL + CELL / 2, at: now };
    this.fuse = { c, r, at: now, level: this.blastLevel(s, levelFromImpact(impact)) };
    this.state = 'stuck';
  }
  private explode(s: BombShot) {
    const { c, r, level } = this.fuse!;
    const cells = blastCells(level, c, r).map(([rr, cc]) => ({ rr, cc, p: this.grid[rr][cc] }));
    const hitCount = cells.filter(x => x.p).length;
    this.explosion = { c, r, level, frame: 0, hitCount, cells };
    if (!RM) cells.forEach(({ rr, cc, p }) => { if (p) this.burst(cc * CELL + CELL / 2, GY + rr * CELL + CELL / 2, p, (Math.abs(rr - r) + Math.abs(cc - c)) * 42, level); });
    cells.forEach(({ rr, cc }) => { this.grid[rr][cc] = null; });
    this.flashText(hitCount ? (s.core ? 'コア！' : '') + LEVEL_NAME[level] : 'はずれ！', c * CELL + CELL / 2, Math.max(GY + 18, GY + r * CELL - 8));
    this.fuse = null; this.state = 'exploding';
  }
  private afterExplosion() {
    const from = compact(this.grid);
    this.settleAnim = RM || !Object.keys(from).length ? null : { at: performance.now(), from };
    this.rebuildStatics();
    this.holding = 'gummy';
    this.endTurn();
  }
  private burst(x: number, y: number, p: SPlayer, delay: number, level: BlastLevel) {
    const t0 = performance.now() + delay, n = level === 4 ? 9 : 7;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6, sp = 2.2 + Math.random() * (level === 4 ? 4.5 : 3);
      this.shards.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.5, s: 5 + Math.random() * 6, p, t0, life: 650 + Math.random() * 300 });
    }
  }

  private endTurn() {
    const thrower = this.shot!.player;
    this.shot = null; this.state = 'idle';
    const res = judge(this.grid, thrower);
    if (res.winner) { this.winner = res.winner; this.winCells = res.cells; this.endNote = res.note; }
    else if (res.draw) this.isDraw = true;
    else { this.current = other(thrower); this.winCells = null; }
    if (this.winner || this.isDraw) {
      this.gameOver = true; this.holding = 'gummy';
      if (this.winner) this.wins[this.winner]++;
      this.nextStarter = this.isDraw ? other(this.nextStarter) : other(this.winner!);   // loser starts next
    }
    this.sync();
  }

  // ── CPU ────────────────────────────────────────────────────────────
  private cpuStep(now: number) {
    if (!this.isCpuTurn()) { this.cpuWaitFrom = 0; return; }
    if (this.state === 'idle' && !this.cpuPlan) {
      if (!this.cpuWaitFrom) { this.cpuWaitFrom = now; return; }
      if (now - this.cpuWaitFrom < 300) return;   // a short "thinking" pause after the person's throw
      this.cpuWaitFrom = 0;
      this.planCpu(now);
      return;
    }
    const p = this.cpuPlan;
    if (this.state !== 'drawing' || !p) return;
    const k = easeOut(Math.min(1, (now - p.start) / (p.pullEnd - p.start)));
    this.pointer = { x: this.grab.x + p.dx * k, y: this.grab.y + p.dy * k };
    if (now >= p.releaseAt) this.release();
  }
  private planCpu(now: number) {
    const bomb = this.bombs.p2 > 0 ? this.bombTarget() : null;
    this.holding = bomb ? 'bomb' : 'gummy';
    let dx: number, dy: number;
    if (bomb) {
      // invert aimPoint: column from the sideways pull, row from the downward pull (half the max reaches the top)
      const tx = bomb.c * CELL + CELL / 2, ty = GY + bomb.r * CELL + CELL / 2;
      dx = (W / 2 - tx) * MAX_PULL / (W / 2);
      dy = Math.max(0, Math.min(1, (GY + BOARD_H - 4 - ty) / (BOARD_H + 18))) * MAX_PULL * 0.5;
    } else {
      const col = getCpuMove(this.grid, 'p2', 'p1', WIN_LEN);
      const tx = col * CELL + CELL / 2 + (Math.random() - 0.5) * CELL * 0.5;   // not always dead centre: the CPU can slip too
      dx = (W / 2 - tx) * SENS / CELL;
      dy = 24 + Math.random() * 16;
    }
    const pullMs = 300 + Math.random() * 150;
    const holdMs = bomb ? 300 + Math.random() * 900 : 100 + Math.random() * 150;   // the bomb's power depends on when it lets go
    this.grab = { ...HOME }; this.pointer = { ...HOME }; this.pointerId = null;
    this.drawStart = now; this.state = 'drawing';
    this.coreW = 0.04 + Math.random() * 0.06; this.coreLo = 0.3 + Math.random() * (0.9 - this.coreW - 0.3);
    this.slip = null; this.flash = null; this.hits = [];
    this.cpuPlan = { start: now, pullEnd: now + pullMs, releaseAt: now + pullMs + holdMs, dx, dy };
    this.sync();
  }
  // Bomb the person's gummy whose blast (one cell up/down/left/right) removes the most of their gummies
  private bombTarget(): { c: number; r: number } | null {
    let best: { c: number; r: number } | null = null, bestN = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (this.grid[r][c] !== 'p1') continue;
      const n = blastCells(2, c, r).reduce((t, [rr, cc]) => t + (this.grid[rr][cc] === 'p1' ? 1 : this.grid[rr][cc] === 'p2' ? -1 : 0), 0);
      if (n > bestN) { bestN = n; best = { c, r }; }
    }
    return bestN >= 2 ? best : null;
  }

  private flashText(text: string, x = W / 2, y = GY + 40) {
    this.flashDur = Math.min(2600, 900 + text.length * 70);
    const half = Math.min(W / 2 - 4, text.length * 11);
    this.flash = { text, x: Math.max(half, Math.min(W - half, x)), y, at: performance.now() };
  }

  // ── Loop ───────────────────────────────────────────────────────────
  private loop = (now: number) => {
    // schedule first, so one bad frame can't freeze the game
    this.raf = requestAnimationFrame(this.loop);
    // fixed 60Hz physics so 120Hz screens don't run the game twice as fast
    this.acc += Math.min(100, now - (this.lastT || now)); this.lastT = now;
    while (this.acc >= 1000 / 60) {
      Engine.update(this.engine, 1000 / 60); this.acc -= 1000 / 60;
      if (this.explosion && this.state === 'exploding') this.explosion.frame++;
    }
    this.cpuStep(now);
    const s = this.shot;
    if (this.state === 'falling' && this.body && s?.kind === 'gummy') {
      const v = this.body.velocity;
      if (Math.hypot(v.x, v.y) < 0.5 && Math.abs(this.body.angularVelocity) < 0.06) this.still++; else this.still = 0;
      if (this.still >= 10 || this.body.position.y > PAD_Y + 20 || now - this.fallStart > 3000) this.gummySettle(s);
    }
    if (this.state === 'rolling' && this.body && s?.kind === 'bomb') {
      const v = this.body.velocity;
      if (Math.hypot(v.x, v.y) < 0.25) this.still++; else this.still = 0;
      if (this.stickTo) this.bombStick(s, now);
      else if (this.still >= 18 || now - this.rollStart > 3000) this.bombSettle(s, now);
    }
    if (this.state === 'stuck' && this.fuse && s?.kind === 'bomb' && now - this.fuse.at > FUSE_MS) this.explode(s);
    if (this.state === 'exploding' && this.explosion && this.explosion.frame > 24) { this.afterExplosion(); this.explosion = null; }
    this.draw(now);
    this.drawOverlay(now);
  };

  // ── Drawing ────────────────────────────────────────────────────────
  private draw(now: number) {
    const ctx = this.ctx, dpr = this.dpr, ex = this.explosion;
    const shake = !RM && ex && ex.level === 4 && ex.frame < 16 ? Math.sin(ex.frame * 2.2) * 5 * (1 - ex.frame / 16) : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.setTransform(dpr, 0, 0, dpr, dpr * shake, 0);
    ctx.fillStyle = COLORS.bgTop; ctx.fillRect(0, 0, W, GY);
    ctx.fillStyle = COLORS.jar; ctx.fillRect(0, GY, W, BOARD_H);
    ctx.strokeStyle = COLORS.jarLine; ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, GY); ctx.lineTo(c * CELL, PAD_Y); ctx.stroke(); }
    ctx.strokeStyle = COLORS.glass; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(1, GY); ctx.lineTo(1, PAD_Y); ctx.lineTo(W - 1, PAD_Y); ctx.lineTo(W - 1, GY); ctx.stroke();
    const winSet = new Set((this.winCells || []).map(([r, c]) => `${r}-${c}`));
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const p = this.grid[r][c]; if (!p) continue;
      if (winSet.has(`${r}-${c}`)) {
        ctx.save(); ctx.shadowBlur = 14; ctx.shadowColor = COLORS.accent; ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 3;
        rr(ctx, c * CELL + 1, GY + r * CELL + 1, CELL - 2, CELL - 2, 10); ctx.stroke(); ctx.restore();
      }
      let gy = GY + r * CELL + 4;
      const from = this.settleAnim ? this.settleAnim.from[`${r}-${c}`] : undefined;
      if (from !== undefined) { const t = Math.min(1, (now - this.settleAnim!.at) / 260); gy = GY + (from + (r - from) * easeIn(t)) * CELL + 4; }
      gummy(ctx, c * CELL + 4, gy, BLOCK, p);
    }
    if (this.state !== 'drawing' && !this.gameOver) {
      ctx.fillStyle = 'rgba(255,246,236,0.7)'; ctx.font = `12px ${HEAD}`; ctx.textAlign = 'center';
      ctx.fillText('たて・よこ・ななめに 5つ ならべたら かち', W / 2, 20);
    }
    this.drawPad(now);
    if (this.state === 'drawing') this.drawAim(now);
    this.drawFlight(now);
    this.drawEffects(now);
  }

  private drawPad(now: number) {
    const ctx = this.ctx;
    const pg = ctx.createLinearGradient(0, PAD_Y, 0, H); pg.addColorStop(0, '#24163A'); pg.addColorStop(1, '#1A1028');
    ctx.fillStyle = pg; ctx.fillRect(0, PAD_Y, W, PAD_H);
    // the launcher ring takes the colour of whoever's turn it is
    ctx.strokeStyle = this.gameOver ? 'rgba(234,217,255,0.35)' : TONE[this.current].base; ctx.lineWidth = 2;
    ctx.globalAlpha = this.gameOver ? 1 : 0.7;
    ctx.beginPath(); ctx.ellipse(HOME.x, HOME.y + 26, 70, 16, 0, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(234,217,255,0.35)';
    ctx.beginPath(); ctx.moveTo(HOME.x - 60, HOME.y); ctx.quadraticCurveTo(HOME.x, HOME.y + 18, HOME.x + 60, HOME.y); ctx.stroke();   // slack band
    ctx.fillStyle = 'rgba(234,217,255,0.5)';
    rr(ctx, HOME.x - 63, HOME.y - 2, 6, 24, 3); ctx.fill(); rr(ctx, HOME.x + 57, HOME.y - 2, 6, 24, 3); ctx.fill();
    if (now - this.padHintAt < 1200) {
      const k = (now - this.padHintAt) / 1200; ctx.strokeStyle = `rgba(255,225,77,${0.8 * (1 - k)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(HOME.x, HOME.y + 10, 80 + k * 20, 34 + k * 8, 0, 0, 7); ctx.stroke();
    }
    // whose turn it is, right where the eyes and finger are (the band at the top is out of sight)
    if (!this.gameOver) {
      const label = `${this.names[this.current]}の ばん`, t = TONE[this.current];
      ctx.font = `11px ${HEAD}`; const tw = ctx.measureText(label).width;
      ctx.fillStyle = t.base; rr(ctx, 8, PAD_Y + 30, tw + 16, 22, 11); ctx.fill();
      ctx.fillStyle = this.current === 'p1' ? '#0E3A4F' : '#4A1608'; ctx.textAlign = 'left'; ctx.fillText(label, 16, PAD_Y + 45);
    }
    const nudge = now - this.cpuNudgeAt < 1200;
    if (nudge) {
      const k = (now - this.cpuNudgeAt) / 1200; ctx.strokeStyle = `rgba(255,59,92,${0.8 * (1 - k)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(HOME.x, HOME.y + 10, 80 + k * 20, 34 + k * 8, 0, 0, 7); ctx.stroke();
    }
    if (!this.gameOver && (this.state === 'idle' || this.isCpuTurn())) {
      ctx.fillStyle = nudge ? COLORS.fuse : COLORS.accent; ctx.font = `13px ${HEAD}`; ctx.textAlign = 'center';
      const msg = nudge ? 'いまは CPUの ばん だよ'
        : this.isCpuTurn() ? 'CPUが なげるよ…'
        : now - this.padHintAt < 1500 ? 'したの グミを ひっぱってね'
        : this.holding === 'bomb' ? 'ひっぱって、きんいろで はなす' : 'したに ひいて、よこで ねらって はなす';
      if (this.state === 'idle' || nudge) ctx.fillText(msg, W / 2, PAD_Y + 96);
    }
  }

  private drawAim(now: number) {
    const ctx = this.ctx, a = this.aimPoint(now);
    if (this.holding === 'gummy') {
      const col = this.colOf(a.x), full = this.topEmpty(col) < 0;
      ctx.fillStyle = full ? 'rgba(255,59,92,0.15)' : TONE[this.current].base + '2E';
      ctx.fillRect(col * CELL, GY, CELL, BOARD_H);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(col * CELL + CELL / 2 - 1, GY, 2, 10);   // column centre tick
      ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      const landY = full ? GY + 30 : GY + this.topEmpty(col) * CELL;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(a.x, GY - 8); ctx.lineTo(a.x, landY); ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.font = `12px ${HEAD}`; ctx.textAlign = 'center'; ctx.fillStyle = COLORS.accent; ctx.fillText('はなす！', Math.max(30, Math.min(W - 30, a.x)), 12);
      ctx.beginPath(); ctx.moveTo(a.x - 6, GY - 14); ctx.lineTo(a.x + 6, GY - 14); ctx.lineTo(a.x, GY - 4); ctx.fill();
      if (!full) {
        const lr = this.topEmpty(col); ctx.strokeStyle = TONE[this.current].base; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        rr(ctx, col * CELL + 4, GY + lr * CELL + 4, BLOCK, BLOCK, 8); ctx.stroke(); ctx.setLineDash([]);
      } else { ctx.fillStyle = COLORS.fuse; ctx.font = `13px ${HEAD}`; ctx.fillText('×', col * CELL + CELL / 2, GY + 20); }
    } else {
      const c = this.colOf(a.x), r = Math.floor((a.y - GY) / CELL);
      ctx.fillStyle = 'rgba(255,225,77,0.10)'; ctx.fillRect(c * CELL, GY, CELL, BOARD_H); if (r >= 0 && r < ROWS) ctx.fillRect(0, GY + r * CELL, W, CELL);
      const hitsGummy = r >= 0 && r < ROWS && !!this.grid[r][c];
      ctx.strokeStyle = hitsGummy ? COLORS.fuse : 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(a.x, a.y, 10, 0, 7); ctx.stroke();
      if (!hitsGummy) { ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `11px ${HEAD}`; ctx.textAlign = 'left'; ctx.fillText('↓ おちる', Math.min(W - 52, a.x + 14), a.y + 4); }
      ctx.beginPath(); ctx.moveTo(a.x - 16, a.y); ctx.lineTo(a.x - 6, a.y); ctx.moveTo(a.x + 6, a.y); ctx.lineTo(a.x + 16, a.y);
      ctx.moveTo(a.x, a.y - 16); ctx.lineTo(a.x, a.y - 6); ctx.moveTo(a.x, a.y + 6); ctx.lineTo(a.x, a.y + 16); ctx.stroke();
      // one power bar with the gold band inside
      const pw = this.chargePower(now), bx = W / 2 - 100, by = PAD_Y + 6, bh = 12;
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; rr(ctx, bx, by, 200, bh, 6); ctx.fill();
      const g2 = ctx.createLinearGradient(bx, 0, bx + 200, 0); g2.addColorStop(0, '#FF9A6B'); g2.addColorStop(1, COLORS.fuse);
      ctx.fillStyle = g2; rr(ctx, bx, by, 200 * pw, bh, 6); ctx.fill();
      const inCore = this.isCore(pw);
      ctx.fillStyle = inCore ? '#FFF6B0' : 'rgba(255,225,77,0.95)'; rr(ctx, bx + 200 * this.coreLo, by - 3, 200 * this.coreW, bh + 6, 4); ctx.fill();
      if (inCore) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = '#fff'; ctx.fillRect(bx + 200 * pw - 2, by - 5, 4, bh + 10);
      ctx.fillStyle = COLORS.text; ctx.font = `12px ${HEAD}`; ctx.textAlign = 'right'; ctx.fillText('いきおい', W / 2 - 106, PAD_Y + 17);
    }
    if (!this.isArmed()) {
      ctx.fillStyle = COLORS.accent; ctx.font = `13px ${HEAD}`; ctx.textAlign = 'center';
      ctx.fillText(this.holding === 'gummy' ? 'すこし したに ひいてから はなす' : 'うえに もどして はなすと やめる', W / 2, PAD_Y + 96);
    }
  }

  private drawFlight(now: number) {
    const ctx = this.ctx, s = this.shot;
    if (this.state === 'flying' && s) {
      const T = s.kind === 'gummy' ? 300 : 520, t = Math.min(1, (now - s.t0) / T);
      if (s.kind === 'gummy') {
        const tx = s.aimX, ty = GY - CELL * 0.5;
        const x = s.sx + (tx - s.sx) * easeOut(t), y = s.sy + (ty - s.sy) * easeOut(t), size = CELL * 1.35 + (BLOCK - CELL * 1.35) * t;
        gummy(ctx, x - size / 2, y - size / 2, size, s.player);
        if (t >= 1) this.gummyArrive(s);
      } else {
        const tgt = { x: s.target.c * CELL + CELL / 2, y: GY + Math.max(-1, s.target.r) * CELL + CELL / 2 };
        const sr = BOMB_R_FAR * (2.6 - 1.6 * t);
        ctx.fillStyle = `rgba(0,0,0,${0.12 + 0.3 * t})`; ctx.beginPath(); ctx.ellipse(tgt.x, tgt.y + 2, sr, sr * 0.8, 0, 0, 7); ctx.fill();
        const peak = Math.min(tgt.y - CELL * 1.2, s.sy - 40);
        const x = s.sx + (tgt.x - s.sx) * easeOut(t);
        const y = t < 0.6 ? s.sy + (peak - s.sy) * easeOut(t / 0.6) : peak + (tgt.y - peak) * easeIn((t - 0.6) / 0.4);
        bombShape(ctx, x, y, BOMB_R_NEAR + (BOMB_R_FAR - BOMB_R_NEAR) * t);
        if (t >= 1) { this.ripple = { x: tgt.x, y: tgt.y, at: now }; if (s.core) this.flashText('コア！', tgt.x, Math.max(GY + 16, tgt.y - 24)); this.bombArrive(s); }
      }
    }
    const b = this.body;
    if (b && this.state === 'falling' && s) { ctx.save(); ctx.translate(b.position.x, b.position.y); ctx.rotate(b.angle); gummy(ctx, -BLOCK / 2, -BLOCK / 2, BLOCK, s.player); ctx.restore(); }
    if (b && this.state === 'rolling') { ctx.save(); ctx.translate(b.position.x, b.position.y); ctx.rotate(b.angle); bombShape(ctx, 0, 0, BOMB_R_FAR); ctx.restore(); }
    const f = this.fuse;
    if (this.state === 'stuck' && f) {
      if (Math.floor((now - f.at) / 125) % 2 === 0) {   // blink the cells that will go
        ctx.strokeStyle = COLORS.fuse; ctx.lineWidth = 2;
        blastCells(f.level, f.c, f.r).forEach(([r0, c0]) => { rr(ctx, c0 * CELL + 2, GY + r0 * CELL + 2, CELL - 4, CELL - 4, 8); ctx.stroke(); });
      }
      const k = 1 + Math.sin((now - f.at) / 35) * 0.1;
      ctx.save(); ctx.translate(f.c * CELL + CELL / 2, GY + f.r * CELL + CELL / 2); ctx.scale(k, 2 - k); bombShape(ctx, 0, 0, BOMB_R_FAR); ctx.restore();
    }
  }

  private drawEffects(now: number) {
    const ctx = this.ctx;
    if (this.ripple && now - this.ripple.at < 300) {
      const k = (now - this.ripple.at) / 300; ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - k)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.ripple.x, this.ripple.y, 8 + k * 26, 0, 7); ctx.stroke();
    }
    const sl = this.slip;
    if (sl && now - sl.at < 1200) {
      ctx.save(); ctx.globalAlpha = 1 - (now - sl.at) / 1200; ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2;
      const fx = sl.from * CELL + CELL / 2, tx = sl.to * CELL + CELL / 2, ty = GY + sl.row * CELL + CELL / 2;
      const fy = sl.fromRow >= 0 ? GY + sl.fromRow * CELL + CELL / 2 : ty;
      if (sl.fromRow >= 0) { ctx.setLineDash([3, 3]); rr(ctx, sl.from * CELL + 4, GY + sl.fromRow * CELL + 4, BLOCK, BLOCK, 8); ctx.stroke(); ctx.setLineDash([]); }
      // arrow from the intended cell to where it landed (may be diagonal)
      const ang = Math.atan2(ty - fy, tx - fx), ex = tx - Math.cos(ang) * 12, ey = ty - Math.sin(ang) * 12;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex - Math.cos(ang - 0.5) * 7, ey - Math.sin(ang - 0.5) * 7); ctx.lineTo(ex, ey); ctx.lineTo(ex - Math.cos(ang + 0.5) * 7, ey - Math.sin(ang + 0.5) * 7); ctx.stroke();
      ctx.restore();
    }
    const exn = this.explosion;
    if (exn) {
      const f = exn.frame;
      // each gummy pops when the light reaches it
      exn.cells.forEach(({ rr: r0, cc, p }) => {
        if (!p) return;
        const d = Math.abs(r0 - exn.r) + Math.abs(cc - exn.c), k = (f - d * 2.5) / 8;
        if (k >= 1) return;
        const s2 = BLOCK * (k <= 0 ? 1 : 1 + k * 0.35);
        gummy(ctx, cc * CELL + CELL / 2 - s2 / 2, GY + r0 * CELL + CELL / 2 - s2 / 2, s2, p, k <= 0 ? 1 : 1 - k);
      });
      // light runs out from the centre along the cross, cell by cell
      const cx = exn.c * CELL + CELL / 2, cy = GY + exn.r * CELL + CELL / 2, fade = Math.max(0, 1 - f / 22);
      const reach = Math.min(ARM_LEN[exn.level], f / 2.5) * CELL + CELL * 0.5, thick = CELL * (exn.level === 4 ? 0.7 : 0.55);
      ctx.save(); ctx.globalAlpha = fade;
      const beam = (x1: number, y1: number) => {
        const g = ctx.createLinearGradient(cx, cy, x1, y1);
        g.addColorStop(0, 'rgba(255,246,176,1)'); g.addColorStop(0.5, 'rgba(255,225,77,0.9)'); g.addColorStop(1, 'rgba(255,59,92,0)'); ctx.fillStyle = g;
      };
      beam(cx + reach, cy); ctx.fillRect(cx, cy - thick / 2, reach, thick);
      beam(cx - reach, cy); ctx.fillRect(cx - reach, cy - thick / 2, reach, thick);
      beam(cx, cy + reach); ctx.fillRect(cx - thick / 2, cy, thick, reach);
      beam(cx, cy - reach); ctx.fillRect(cx - thick / 2, cy - reach, thick, reach);
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, CELL * 0.45 * (1 - f / 24)), 0, 7); ctx.fill();
      ctx.restore();
    }
    this.drawShards(now);
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i], k = (now - h.at) / 600;
      if (k >= 1) { this.hits.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = 1 - k; ctx.fillStyle = h.lvl === 3 ? COLORS.fuse : h.lvl === 2 ? COLORS.accent : COLORS.muted;
      ctx.font = `${12 + h.lvl * 3}px ${HEAD}`; ctx.textAlign = 'center'; ctx.fillText(h.text, h.x, h.y - k * 14); ctx.restore();
    }
    if (this.bombGotFor && now >= this.bombGotAt && now - this.bombGotAt < 1400) {
      const k = (now - this.bombGotAt) / 1400, text = `${this.names[this.bombGotFor]}、ばくだん ゲット！`;
      ctx.save(); ctx.globalAlpha = 1 - Math.max(0, k - 0.6) / 0.4; ctx.fillStyle = COLORS.accent; ctx.font = `18px ${HEAD}`; ctx.textAlign = 'center';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(43,27,61,0.95)'; ctx.strokeText(text, W / 2, GY + 80 - k * 8); ctx.fillText(text, W / 2, GY + 80 - k * 8); ctx.restore();
    }
    const fl = this.flash;
    if (fl && now - fl.at < this.flashDur) {
      const k = Math.max(0, (now - fl.at - (this.flashDur - 500)) / 500);   // hold, then fade over the last 0.5s
      ctx.save(); ctx.globalAlpha = 1 - k; ctx.fillStyle = COLORS.accent; ctx.font = `${18 + (1 - k) * 4}px ${HEAD}`; ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(43,27,61,0.8)'; ctx.strokeText(fl.text, fl.x, fl.y); ctx.fillText(fl.text, fl.x, fl.y); ctx.restore();
    }
  }

  private drawShards(now: number) {
    const ctx = this.ctx;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const d = this.shards[i], t = now - d.t0;
      if (t < 0) continue;
      if (t > d.life) { this.shards.splice(i, 1); continue; }
      const f = t / 16.67, x = d.x + d.vx * f, y = d.y + d.vy * f + 0.09 * f * f;
      ctx.save(); ctx.globalAlpha = 1 - Math.max(0, t / d.life - 0.6) / 0.4; ctx.translate(x, y); ctx.rotate(d.rot + d.vr * f);
      ctx.fillStyle = TONE[d.p].base; rr(ctx, -d.s / 2, -d.s / 2, d.s, d.s, d.s * 0.3); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; rr(ctx, -d.s / 2 + 1, -d.s / 2 + 1, d.s * 0.45, d.s * 0.25, 1); ctx.fill();
      ctx.restore();
    }
  }

  // Held object + rubber band on the full-screen overlay (top layer, never clipped by the board)
  private drawOverlay(now: number) {
    const fx = this.fx, fxCtx = this.fxCtx, dpr = this.dpr;
    const box = fx.getBoundingClientRect(), w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (fx.width !== w || fx.height !== h) { fx.width = w; fx.height = h; }
    fxCtx.setTransform(1, 0, 0, 1, 0, 0); fxCtx.clearRect(0, 0, w, h);
    if (!((this.state === 'idle' && !this.gameOver) || this.state === 'drawing')) return;
    const r = this.cv.getBoundingClientRect(), k = r.width / W;
    fxCtx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (r.left - box.left), dpr * (r.top - box.top));
    this.ctx = fxCtx;
    try {
      const ctx = fxCtx, bomb = this.holding === 'bomb';
      const nearSize = bomb ? BOMB_R_NEAR : CELL * 1.35;
      const drawHeld = (x: number, y: number, a = 1) => (bomb ? bombShape(ctx, x, y, BOMB_R_NEAR) : gummy(ctx, x - nearSize / 2, y - nearSize / 2, nearSize, this.current, a));
      ctx.strokeStyle = bomb ? 'rgba(255,59,92,0.85)' : TONE[this.current].light; ctx.lineCap = 'round';
      const pulled = (bx: number, by: number, len: number) => {
        ctx.lineWidth = 3 - Math.min(1, len / MAX_PULL);
        ctx.beginPath(); ctx.moveTo(HOME.x - 60, HOME.y); ctx.lineTo(bx, by); ctx.lineTo(HOME.x + 60, HOME.y); ctx.stroke();
        drawHeld(bx, by);
      };
      if (this.state === 'drawing') {
        const { dx, dy, len } = this.pullVec();
        pulled(HOME.x + dx * 0.55, HOME.y + dy * 0.55, len);
      } else {
        const demo = this.seen[this.holding] || this.isCpuTurn() ? null : this.demoPose(now);
        if (demo && demo.press) {   // the ghost finger drags the gummy/bomb so the motion reads as "pull"
          pulled(HOME.x + (demo.x - HOME.x) * 0.55, HOME.y + (demo.y - HOME.y) * 0.55, 0);
        } else {
          // during the CPU's turn its gummy waits faded (not yours to grab) and shakes "no" if you touch it
          const cpuTurn = this.isCpuTurn(), nk = (now - this.cpuNudgeAt) / 400;
          const shakeX = cpuTurn && nk < 1 && !RM ? Math.sin(nk * Math.PI * 6) * 5 * (1 - nk) : 0;
          ctx.globalAlpha = cpuTurn ? 0.45 : 1;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(HOME.x - 60, HOME.y); ctx.quadraticCurveTo(HOME.x, HOME.y + 18, HOME.x + 60, HOME.y); ctx.stroke();
          drawHeld(HOME.x + shakeX, HOME.y + (RM || cpuTurn ? 0 : Math.sin(now / 260) * 2), cpuTurn ? 0.45 : 1);
          ctx.globalAlpha = 1;
        }
        if (demo) this.drawFinger(demo);
      }
    } finally { this.ctx = this.mainCtx; }
  }

  // Ghost finger for the first throw: press, pull down, slide sideways, let go
  private demoPose(now: number) {
    const T = 2400, t = (now % T) / T;
    const path = this.holding === 'gummy' ? [[0, 0], [0, 34], [-48, 38]] : [[0, 0], [-30, 40], [-30, 40]];
    let x = HOME.x, y = HOME.y, a: number, press = false;
    if (t < 0.12) a = t / 0.12;
    else if (t < 0.3) { a = 1; press = true; const k = easeOut((t - 0.12) / 0.18); x += path[1][0] * k; y += path[1][1] * k; }
    else if (t < 0.62) { a = 1; press = true; const k = easeOut((t - 0.3) / 0.32); x += path[1][0] + (path[2][0] - path[1][0]) * k; y += path[1][1] + (path[2][1] - path[1][1]) * k; }
    else if (t < 0.8) { a = 1 - (t - 0.62) / 0.18; x += path[2][0]; y += path[2][1] - (t - 0.62) * 60; }
    else return null;
    return { x, y, a, press, t };
  }
  private drawFinger({ x, y, a, press, t }: { x: number; y: number; a: number; press: boolean; t: number }) {
    const ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = press ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.3)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, press ? 13 : 16, 0, 7); ctx.fill(); ctx.stroke();
    if (t >= 0.62 && t < 0.8) { ctx.font = `13px ${HEAD}`; ctx.textAlign = 'center'; ctx.fillStyle = COLORS.accent; ctx.fillText('はなす！', x, y - 22); }
    ctx.restore();
  }
}

const HEAD = '"Mochiy Pop One", sans-serif';
