// "Pull everything" play screen for two people on one device (DESIGN.md §4–5).
import { useEffect, useRef, useState } from 'react';
import { COLORS as THEME, FONTS } from '../theme';
import { H, SlingEngine, W, type SlingUi } from './engine';
import { starPath } from './draw';
import MuteButton from './MuteButton';
import { unlock } from './sound';
import { BOMB_EVERY, NAME, other, type SPlayer } from './rules';


const TONE = { p1: THEME.p1, p2: THEME.p2 };
const SOFT = THEME.soft;
const hexA = (hex: string, a: number) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

export function PlayerChip({ player, size }: { player: SPlayer; size: number }) {
  const t = TONE[player];
  return (
    <span style={{
      width: size, height: size, borderRadius: '30%', flexShrink: 0, display: 'inline-grid', placeItems: 'center',
      background: `linear-gradient(160deg, ${t.light}, ${t.base} 55%, ${t.deep})`,
      boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.22), inset 0 2px 0 rgba(255,255,255,0.35)',
    }}>
      {player === 'p1'
        ? <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: '50%', border: `${Math.max(2, size * 0.09)}px solid rgba(255,255,255,0.85)` }} />
        : <svg width={size * 0.6} height={size * 0.6} viewBox="-1 -1 2 2" aria-hidden>
            <path d={starPath(0.95, 0.42)} fill="none" stroke="rgba(120,30,10,0.6)" strokeWidth={0.24} strokeLinejoin="round" />
          </svg>}
    </span>
  );
}

// Board width in CSS px: as wide as the screen allows, up to 560. The space left for the band and the bottom
// bar/result card grows with the board (≈60 + 200·k px), which gives the 0.49 factor on the height.
function boardWidth() {
  const vw = window.innerWidth, vh = window.innerHeight;
  return Math.max(200, Math.floor(Math.min(560, vw - 32, (vh - 60) * 0.49)));
}

function BombBall({ size = 26 }: { size?: number }) {
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-block' }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: `radial-gradient(circle at 35% 30%, #5a5a5a, ${THEME.bomb} 60%, #111)` }} />
      <span style={{ position: 'absolute', right: '4%', top: '-14%', width: '34%', height: '34%', borderTop: `2.5px solid ${THEME.fuse}`, borderRight: `2.5px solid ${THEME.fuse}`, borderRadius: '0 60% 0 0' }} />
    </span>
  );
}

export default function SlingGame({ onMenu, cpu = false }: { onMenu: () => void; cpu?: boolean }) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const engRef = useRef<SlingEngine | null>(null);
  const [ui, setUi] = useState<SlingUi | null>(null);
  const [againReady, setAgainReady] = useState(false);
  const [askQuit, setAskQuit] = useState(false);   // first tap on ✕ asks, second tap leaves
  const [boardW, setBoardW] = useState(() => boardWidth());
  const [vh, setVh] = useState(() => window.innerHeight);

  useEffect(() => {
    const eng = new SlingEngine(cvRef.current!, fxRef.current!, setUi, { cpu });
    engRef.current = eng;
    const dbg = window as unknown as { __sling?: SlingEngine };
    if (new URLSearchParams(location.search).has('debug')) dbg.__sling = eng;
    return () => { eng.destroy(); engRef.current = null; delete dbg.__sling; };
  }, [cpu]);

  // The board grows with the screen up to 560px (cells 24–56px, DESIGN.md §8); the band and bars scale with it
  useEffect(() => {
    const onResize = () => { setBoardW(boardWidth()); setVh(window.innerHeight); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, []);
  useEffect(() => { engRef.current?.setDisplayWidth(boardW); }, [boardW, cpu]);

  // the "もういっかい" button can't be hit for 1s, so a tap meant for the board doesn't restart instantly
  const gameOver = !!ui?.gameOver;
  useEffect(() => {
    if (!gameOver) return;
    const t = setTimeout(() => setAgainReady(true), 1000);
    return () => clearTimeout(t);
  }, [gameOver]);

  const names: Record<SPlayer, string> = { p1: NAME.p1, p2: cpu ? 'CPU' : NAME.p2 };
  const width = boardW, k = boardW / W, sz = (px: number, min = 0) => Math.max(min, Math.round(px * k));
  const markP: SPlayer | null = ui ? (ui.isDraw ? null : ui.winner || ui.current) : null;
  const tone = markP ? TONE[markP].base : '#FFFFFF';
  // after a win the band says what happened; the winner's name is only on the result card (not twice)
  const bandText = !ui ? '' : ui.isDraw ? 'ひきわけ！' : ui.winner ? (ui.endNote || '5つ そろった！') : `${names[ui.current]}の ばん`;
  // The band and the jar never move: their top is fixed from the playing layout, and the result card just grows downward
  // (the space below is sized for the taller result card; on narrow boards its buttons wrap onto a second row)
  const bandH = Math.max(sz(54, 54), sz(40, 44) + 12), barH = sz(56, 56);
  const resultH = boardW < 330 ? Math.max(120, sz(125)) : Math.max(84, sz(84));
  const topPad = Math.max(16, Math.floor((vh - (bandH + 10 + boardW * H / W + 10 + Math.max(barH, resultH))) / 2));
  const have = ui ? ui.bombs[ui.current] : 0;
  const holdingBomb = ui?.holding === 'bomb';
  const btnDisabled = !ui || ui.gameOver || ui.busy || ui.cpuTurn || (!holdingBomb && have === 0);
  const ready = !!ui && !ui.gameOver && !ui.cpuTurn && !holdingBomb && have > 0;
  const hint = !ui || ui.gameOver ? ''
    : ui.cpuTurn ? 'CPUが かんがえ中…'
    : ui.busy ? ''
    : holdingBomb ? 'よこで ねらう・すこし ひくほど うえ。きんいろで はなすと つよい'
    : ui.bombUsed[ui.current] ? 'ばくだんは もう つかったよ（1しあい 1かい）'
    : have === 0 ? `ばくだんまで あと${BOMB_EVERY - ui.charge[ui.current]}かい` : 'ばくだんボタンを おすと つかえるよ！';

  return (
    <div onPointerDown={unlock} onPointerUp={unlock} style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', minHeight: '100dvh', background: `radial-gradient(120% 70% at 50% 0%, ${THEME.bgTop} 0%, ${THEME.bg} 60%)`, color: THEME.text, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: 10, padding: `${topPad}px 16px max(16px, env(safe-area-inset-bottom))`, fontFamily: FONTS.body }}>
      {/* Turn band — always the same height; the 34px slot on the right stays empty when playing on one device */}
      <div style={{
        width, minHeight: bandH, boxSizing: 'border-box', display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 6, padding: '6px 10px 6px 14px', borderRadius: 16,
        background: ui?.isDraw ? 'rgba(255,255,255,0.08)' : `linear-gradient(90deg, ${hexA(tone, 0.35)}, ${hexA(tone, 0.08)})`,
        boxShadow: ui?.isDraw ? 'inset 0 0 0 2px rgba(255,255,255,0.3)' : `inset 0 0 0 2px ${hexA(tone, 0.6)}`,
        transition: 'background 0.25s ease-out, box-shadow 0.25s ease-out',
      }}>
        {markP && <PlayerChip player={markP} size={sz(22, 22)} />}
        <span style={{ fontFamily: FONTS.heading, fontSize: sz(15, 15), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto' }}>{bandText}</span>
        <span style={{ marginLeft: 'auto', display: 'flex' }}><MuteButton size={sz(40, 44)} /></span>
        <button
          onClick={() => { if (askQuit) onMenu(); else { setAskQuit(true); setTimeout(() => setAskQuit(false), 3000); } }}
          aria-label="やめて メニューへ"
          style={{
            minWidth: sz(40, 44), height: sz(40, 44), flexShrink: 0, borderRadius: 999, border: 0, cursor: 'pointer', padding: askQuit ? '0 12px' : 0,
            background: askQuit ? THEME.accent : 'rgba(255,255,255,0.10)', color: askQuit ? THEME.bgTop : THEME.muted,
            fontFamily: FONTS.heading, fontSize: askQuit ? sz(13, 13) : sz(16, 16),
          }}
        >{askQuit ? 'やめる？' : '✕'}</button>
      </div>

      <canvas ref={cvRef} style={{ display: 'block', width, height: 'auto', aspectRatio: `${W} / ${H}`, borderRadius: 14, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }} aria-label="びん と はっしゃだい。したの グミを ひっぱって なげる" role="img" />

      {/* Bottom bar while playing, result card once the game is decided (same place) */}
      {ui && !ui.gameOver && (
        <div style={{ width, height: barH, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button
              onClick={() => engRef.current?.toggleBomb()}
              disabled={btnDisabled}
              aria-label={holdingBomb ? 'グミに もどす' : 'ばくだんに もちかえる'}
              className={ready ? 'bomb-ready' : undefined}
              style={{
                position: 'relative', width: sz(52, 48), height: sz(52, 48), borderRadius: 16, flexShrink: 0, padding: 0, display: 'grid', placeItems: 'center',
                border: `2px solid ${holdingBomb ? THEME.fuse : THEME.glass}`,
                background: holdingBomb ? 'rgba(255,59,92,0.18)' : 'rgba(255,255,255,0.06)',
                boxShadow: holdingBomb ? '0 0 14px rgba(255,59,92,0.6)' : 'none',
                opacity: btnDisabled && !holdingBomb ? 0.35 : 1, cursor: btnDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              <BombBall size={sz(26, 24)} />
              <span style={{ position: 'absolute', bottom: -6, right: -6, padding: '2px 6px', borderRadius: 999, background: have > 0 ? '#D9244A' : '#5A4A6E', color: '#fff', fontSize: sz(11, 11), fontWeight: 900 }}>×{have}</span>
            </button>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }} aria-label={`ばくだんまで ${ui.charge[ui.current]}/${BOMB_EVERY}`}>
              {Array.from({ length: BOMB_EVERY }, (_, i) => (
                <i key={i} style={{ width: sz(6, 6), height: sz(6, 6), borderRadius: '50%', background: ui.bombUsed[ui.current] ? 'rgba(255,255,255,0.08)' : i < ui.charge[ui.current] ? THEME.accent : 'rgba(255,255,255,0.2)' }} />
              ))}
            </div>
          </div>
          <span style={{ flex: 1, minWidth: 0, fontSize: sz(14, 14), fontWeight: 800, color: SOFT, lineHeight: 1.4, lineBreak: 'strict', wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>{hint}</span>
          <span style={{ fontSize: sz(13, 13), fontWeight: 800, color: SOFT, whiteSpace: 'nowrap' }}>あいて ×{ui.bombs[other(ui.current)]}</span>
        </div>
      )}
      {ui?.gameOver && (
        <div className="result-rise" style={{ width, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 16, background: 'rgba(255,255,255,0.08)', boxShadow: `inset 0 0 0 2px ${THEME.glass}` }}>
          {ui.winner && <PlayerChip player={ui.winner} size={sz(28, 26)} />}
          <div style={{ flex: '1 1 auto', minWidth: 'max-content' }}>
            <div style={{ fontFamily: FONTS.heading, fontSize: sz(16, 15), whiteSpace: 'nowrap' }}>{ui.winner ? `${names[ui.winner]}の かち！` : 'ひきわけ！'}</div>
            <div style={{ fontSize: sz(14, 13), color: SOFT, fontWeight: 800, marginTop: 2, whiteSpace: 'nowrap' }}>
              ソーダ <b style={{ fontFamily: FONTS.logo, fontWeight: 400, color: THEME.text, fontSize: sz(16, 15) }}>{ui.wins.p1}</b> − <b style={{ fontFamily: FONTS.logo, fontWeight: 400, color: THEME.text, fontSize: sz(16, 15) }}>{ui.wins.p2}</b> {names.p2}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button id="againBtn" disabled={!againReady} onClick={() => { setAgainReady(false); engRef.current?.newGame(); }} style={{
              fontFamily: FONTS.heading, fontSize: sz(14, 14), border: 0, borderRadius: 14, minHeight: 44, padding: '0 14px', background: THEME.accent, color: THEME.bgTop,
              boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.18)', opacity: againReady ? 1 : 0.4, cursor: againReady ? 'pointer' : 'default',
            }}>もういっかい</button>
            <button onClick={onMenu} style={{ fontFamily: FONTS.heading, fontSize: sz(12, 12), border: 0, borderRadius: 12, minHeight: 44, padding: '0 12px', background: 'transparent', color: THEME.muted, boxShadow: `inset 0 0 0 2px ${THEME.glass}`, cursor: 'pointer' }}>メニュー</button>
          </div>
        </div>
      )}

      {/* Overlay so the held gummy/bomb and the rubber band draw on top of everything and never get clipped */}
      <canvas ref={fxRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 50 }} />
    </div>
  );
}
