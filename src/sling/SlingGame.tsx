// "Pull everything" play screen for two people on one device (DESIGN.md §4–5).
import { useEffect, useRef, useState } from 'react';
import { COLORS as THEME, FONTS } from '../theme';
import { H, SlingEngine, W, type SlingUi } from './engine';
import { starPath } from './draw';
import { BOMB_EVERY, NAME, other, type SPlayer } from './rules';


const TONE = { p1: THEME.p1, p2: THEME.p2 };
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

function BombBall() {
  return (
    <span style={{ position: 'relative', width: 26, height: 26, display: 'inline-block' }}>
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

  useEffect(() => {
    const eng = new SlingEngine(cvRef.current!, fxRef.current!, setUi, { cpu });
    engRef.current = eng;
    const dbg = window as unknown as { __sling?: SlingEngine };
    if (new URLSearchParams(location.search).has('debug')) dbg.__sling = eng;
    return () => { eng.destroy(); engRef.current = null; delete dbg.__sling; };
  }, [cpu]);

  // the "もういっかい" button can't be hit for 1s, so a tap meant for the board doesn't restart instantly
  const gameOver = !!ui?.gameOver;
  useEffect(() => {
    if (!gameOver) return;
    const t = setTimeout(() => setAgainReady(true), 1000);
    return () => clearTimeout(t);
  }, [gameOver]);

  const names: Record<SPlayer, string> = { p1: NAME.p1, p2: cpu ? 'CPU' : NAME.p2 };
  const width = `min(${W}px, calc(100vw - 32px), calc((100dvh - 214px) * ${W} / ${H}))`;
  const markP: SPlayer | null = ui ? (ui.isDraw ? null : ui.winner || ui.current) : null;
  const tone = markP ? TONE[markP].base : '#FFFFFF';
  const bandText = !ui ? '' : ui.isDraw ? 'ひきわけ！' : ui.winner ? `${names[ui.winner]}の かち！` : `${names[ui.current]}の ばん`;
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', minHeight: '100dvh', background: `radial-gradient(120% 70% at 50% 0%, ${THEME.bgTop} 0%, ${THEME.bg} 60%)`, color: THEME.text, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 10, padding: 16, fontFamily: FONTS.body }}>
      {/* Turn band — always the same height; the 34px slot on the right stays empty when playing on one device */}
      <div style={{
        width, minHeight: 54, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 16,
        background: ui?.isDraw ? 'rgba(255,255,255,0.08)' : `linear-gradient(90deg, ${hexA(tone, 0.35)}, ${hexA(tone, 0.08)})`,
        boxShadow: ui?.isDraw ? 'inset 0 0 0 2px rgba(255,255,255,0.3)' : `inset 0 0 0 2px ${hexA(tone, 0.6)}`,
        transition: 'background 0.25s ease-out, box-shadow 0.25s ease-out',
      }}>
        {markP && <PlayerChip player={markP} size={22} />}
        <span style={{ fontFamily: FONTS.heading, fontSize: 15 }}>{bandText}</span>
        <button
          onClick={() => { if (askQuit) onMenu(); else { setAskQuit(true); setTimeout(() => setAskQuit(false), 3000); } }}
          aria-label="やめて メニューへ"
          style={{
            marginLeft: 'auto', minWidth: 34, height: 34, flexShrink: 0, borderRadius: 999, border: 0, cursor: 'pointer', padding: askQuit ? '0 12px' : 0,
            background: askQuit ? THEME.accent : 'rgba(255,255,255,0.10)', color: askQuit ? THEME.bgTop : THEME.muted,
            fontFamily: FONTS.heading, fontSize: askQuit ? 12 : 15,
          }}
        >{askQuit ? 'やめる？' : '✕'}</button>
        {ui?.endNote && <span style={{ flexBasis: '100%', marginLeft: 32, fontSize: 13, fontWeight: 800, color: THEME.accent }}>{ui.endNote}</span>}
      </div>

      <canvas ref={cvRef} style={{ display: 'block', width, height: 'auto', aspectRatio: `${W} / ${H}`, borderRadius: 14, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }} aria-label="びん と はっしゃだい。したの グミを ひっぱって なげる" role="img" />

      {/* Bottom bar while playing, result card once the game is decided (same place) */}
      {ui && !ui.gameOver && (
        <div style={{ width, height: 52, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button
              onClick={() => engRef.current?.toggleBomb()}
              disabled={btnDisabled}
              aria-label={holdingBomb ? 'グミに もどす' : 'ばくだんに もちかえる'}
              className={ready ? 'bomb-ready' : undefined}
              style={{
                position: 'relative', width: 52, height: 52, borderRadius: 16, flexShrink: 0, padding: 0, display: 'grid', placeItems: 'center',
                border: `2px solid ${holdingBomb ? THEME.fuse : THEME.glass}`,
                background: holdingBomb ? 'rgba(255,59,92,0.18)' : 'rgba(255,255,255,0.06)',
                boxShadow: holdingBomb ? '0 0 14px rgba(255,59,92,0.6)' : 'none',
                opacity: btnDisabled && !holdingBomb ? 0.35 : 1, cursor: btnDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              <BombBall />
              <span style={{ position: 'absolute', bottom: -6, right: -6, padding: '2px 6px', borderRadius: 999, background: have > 0 ? '#D9244A' : '#5A4A6E', color: '#fff', fontSize: 11, fontWeight: 900 }}>×{have}</span>
            </button>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }} aria-label={`ばくだんまで ${ui.charge[ui.current]}/${BOMB_EVERY}`}>
              {Array.from({ length: BOMB_EVERY }, (_, i) => (
                <i key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: ui.bombUsed[ui.current] ? 'rgba(255,255,255,0.08)' : i < ui.charge[ui.current] ? THEME.accent : 'rgba(255,255,255,0.2)' }} />
              ))}
            </div>
          </div>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: THEME.muted, lineHeight: 1.4, lineBreak: 'strict', wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>{hint}</span>
          <span style={{ fontSize: 12, color: THEME.muted, whiteSpace: 'nowrap' }}>あいて ×{ui.bombs[other(ui.current)]}</span>
        </div>
      )}
      {ui?.gameOver && (
        <div className="result-rise" style={{ width, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 16, background: 'rgba(255,255,255,0.08)', boxShadow: `inset 0 0 0 2px ${THEME.glass}` }}>
          {ui.winner && <PlayerChip player={ui.winner} size={28} />}
          <div style={{ flex: '1 1 120px', minWidth: 0 }}>
            <div style={{ fontFamily: FONTS.heading, fontSize: 16, whiteSpace: 'nowrap' }}>{ui.winner ? `${names[ui.winner]}の かち！` : 'ひきわけ！'}</div>
            <div style={{ fontSize: 13, color: THEME.muted, fontWeight: 800, marginTop: 2, whiteSpace: 'nowrap' }}>
              ソーダ <b style={{ fontFamily: FONTS.logo, fontWeight: 400, color: THEME.text, fontSize: 16 }}>{ui.wins.p1}</b> − <b style={{ fontFamily: FONTS.logo, fontWeight: 400, color: THEME.text, fontSize: 16 }}>{ui.wins.p2}</b> {names.p2}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button id="againBtn" disabled={!againReady} onClick={() => { setAgainReady(false); engRef.current?.newGame(); }} style={{
              fontFamily: FONTS.heading, fontSize: 14, border: 0, borderRadius: 14, padding: '10px 14px', background: THEME.accent, color: THEME.bgTop,
              boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.18)', opacity: againReady ? 1 : 0.4, cursor: againReady ? 'pointer' : 'default',
            }}>もういっかい</button>
            <button onClick={onMenu} style={{ fontFamily: FONTS.heading, fontSize: 12, border: 0, borderRadius: 12, padding: '6px 10px', background: 'transparent', color: THEME.muted, boxShadow: `inset 0 0 0 2px ${THEME.glass}`, cursor: 'pointer' }}>メニュー</button>
          </div>
        </div>
      )}

      {/* Overlay so the held gummy/bomb and the rubber band draw on top of everything and never get clipped */}
      <canvas ref={fxRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 50 }} />
    </div>
  );
}
