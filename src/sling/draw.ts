// Canvas drawing helpers shared by the board and the overlay (DESIGN.md §4).
import { COLORS } from '../theme';
import type { SPlayer } from './rules';

export const TONE: Record<SPlayer, { light: string; base: string; deep: string }> = { p1: COLORS.p1, p2: COLORS.p2 };

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function starPoints(R: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, d = i % 2 ? r : R; pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
  return pts;
}

// SVG path of the ☆ mark for DOM chips (viewBox -1..1)
export function starPath(R: number, r: number) {
  return 'M' + starPoints(R, r).map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z';
}

// Gummy block: gradient + dark lower rim + white upper rim + gloss, and the player's mark (○ / ☆)
export function gummy(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, p: SPlayer, a = 1) {
  const t = TONE[p]; ctx.save(); ctx.globalAlpha = a;
  const g = ctx.createLinearGradient(x, y, x + s * 0.35, y + s); g.addColorStop(0, t.light); g.addColorStop(0.55, t.base); g.addColorStop(1, t.deep);
  ctx.fillStyle = g; rr(ctx, x, y, s, s, s * 0.3); ctx.fill();
  ctx.save(); rr(ctx, x, y, s, s, s * 0.3); ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x, y + s * 0.88, s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x, y, s, s * 0.08); ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; rr(ctx, x + s * 0.18, y + s * 0.12, s * 0.34, s * 0.18, s * 0.09); ctx.fill();
  const cx = x + s / 2, cy = y + s / 2; ctx.lineCap = 'round';
  if (p === 'p1') { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(2, s * 0.08); ctx.beginPath(); ctx.arc(cx, cy, s * 0.19, 0, 7); ctx.stroke(); }
  else {
    ctx.strokeStyle = 'rgba(120,30,10,0.55)'; ctx.lineWidth = Math.max(2, s * 0.075); ctx.lineJoin = 'round';
    ctx.beginPath();
    starPoints(s * 0.24, s * 0.105).forEach(([px, py], i) => (i ? ctx.lineTo(cx + px, cy + py + s * 0.02) : ctx.moveTo(cx + px, cy + py + s * 0.02)));
    ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

export function bombShape(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, '#5a5a5a'); g.addColorStop(0.6, COLORS.bomb); g.addColorStop(1, '#111');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.strokeStyle = COLORS.fuse; ctx.lineWidth = Math.max(2, r * 0.16); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x + r * 0.5, y - r * 0.75); ctx.quadraticCurveTo(x + r * 0.9, y - r * 1.3, x + r * 1.2, y - r * 1.05); ctx.stroke();
}

export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
export const easeIn = (t: number) => t * t;
