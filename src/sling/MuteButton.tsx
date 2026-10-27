// Speaker button that turns every sound on/off; remembered on this device (DESIGN.md §4).
import { useSyncExternalStore } from 'react';
import { COLORS as THEME } from '../theme';
import { isMuted, onMutedChange, setMuted, unlock } from './sound';

export default function MuteButton({ size = 44 }: { size?: number }) {
  const muted = useSyncExternalStore(onMutedChange, isMuted);
  const s = Math.round(size * 0.45);
  return (
    <button
      onClick={() => { unlock(); setMuted(!muted); }}
      aria-label={muted ? 'おとを だす' : 'おとを けす'}
      aria-pressed={muted}
      style={{
        width: size, height: size, flexShrink: 0, borderRadius: 999, border: 0, cursor: 'pointer', padding: 0,
        display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,0.10)', color: muted ? THEME.muted : THEME.text,
      }}
    >
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
        {muted
          ? <path d="M17 9l5 6M22 9l-5 6" />
          : <><path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" /><path d="M19 7a7 7 0 0 1 0 10" /></>}
      </svg>
    </button>
  );
}
