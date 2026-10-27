// Sounds for the pull-everything game, synthesised with Web Audio (no audio files — DESIGN.md §10).
// Browsers only allow sound after the first touch, so call unlock() from a pointer/click handler.
// Spec: docs/requirements/2026-10-27_音と消音ボタン.md

const MUTE_KEY = 'blockFiveMuted';
const MASTER_VOL = 0.45;
let ac: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();
const listeners = new Set<(m: boolean) => void>();

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* storage blocked */ }
  if (m) stretchStop();
  // also silence sounds that are already scheduled (a long explosion keeps ringing otherwise)
  try { if (ac && master) master.gain.setTargetAtTime(m ? 0 : MASTER_VOL, ac.currentTime, 0.01); } catch { /* ignore */ }
  listeners.forEach(f => f(m));
}
export function onMutedChange(f: (m: boolean) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

export function unlock() {
  try {
    if (!ac) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      master = ac.createGain(); master.gain.value = muted ? 0 : MASTER_VOL; master.connect(ac.destination);
      // older iOS only wakes audio after a sound is started inside the touch: play one silent sample
      const b = ac.createBufferSource(); b.buffer = ac.createBuffer(1, 1, 22050); b.connect(ac.destination); b.start(0);
    }
    // 'suspended', or iOS's own 'interrupted' after a call / coming back from the background
    if (ac.state !== 'running') ac.resume().catch(() => { /* needs another touch */ });
  } catch { /* no audio on this device */ }
}

// Leaving the page: stop the rubber band; coming back: wake audio again
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stretchStop();
    else if (ac && ac.state !== 'running') ac.resume().catch(() => { /* needs a touch */ });
  });
  window.addEventListener('blur', () => stretchStop());
}

// Ready only after unlock() and when not muted
function ready(): AudioContext | null { return !muted && ac && master && ac.state === 'running' ? ac : null; }

// One oscillator note with a pitch slide and a quick attack / decay
function tone(freq: number, freqEnd: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
  const c = ready(); if (!c) return;
  const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master!); o.start(t); o.stop(t + dur + 0.02);
}

// Filtered noise burst (explosions, "poof")
function noise(dur: number, vol: number, from: number, to: number, delay = 0) {
  const c = ready(); if (!c) return;
  const t = c.currentTime + delay, len = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master!); src.start(t); src.stop(t + dur + 0.02);
}

function vibrate(ms: number | number[]) { try { if (!muted) navigator.vibrate?.(ms); } catch { /* not supported (iPhone) */ } }

// ── Rubber band: a soft tone that rises while you pull ───────────────
let band: { o: OscillatorNode; g: GainNode } | null = null;
let lastAmount = -1;
export function stretch(amount: number) {
  const c = ready();
  if (!c) { stretchStop(); return; }
  if (!band) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; g.gain.value = 0.0001; o.connect(g); g.connect(master!); o.start();
    band = { o, g };
  }
  const t = c.currentTime, a = Math.max(0, Math.min(1, amount));
  if (Math.abs(a - lastAmount) < 0.01) return;   // don't pile up automation every frame
  lastAmount = a;
  band.o.frequency.setTargetAtTime(180 + a * 420, t, 0.03);
  band.g.gain.setTargetAtTime(a > 0.02 ? 0.05 + a * 0.05 : 0.0001, t, 0.04);
}
export function stretchStop() {
  if (!band) return;
  const b = band; band = null; lastAmount = -1;
  try {
    const t = ac!.currentTime;
    b.g.gain.setTargetAtTime(0.0001, t, 0.02); b.o.stop(t + 0.1);
  } catch { /* already stopped */ }
}

// ── One-shots ────────────────────────────────────────────────────────
export const sound = {
  // 離す「ぽんっ」 — a harder pull is a little stronger
  pop(strength: number) { tone(520 + strength * 260, 160, 0.12, 0.35 + strength * 0.2, 'sine'); noise(0.05, 0.12, 3000, 800); },
  // 狙いどおり「ぽよん」 — slightly different pitch every time
  boing() { const b = 300 + Math.random() * 90; tone(b * 1.6, b, 0.09, 0.32); tone(b * 1.25, b * 1.05, 0.16, 0.22, 'sine', 0.07); },
  // ずれた「むにゅ〜ん」 — falls, longer for bigger slips
  squish(cols: number) { const d = 0.35 + Math.min(3, cols) * 0.12; tone(420, 110, d, 0.32, 'triangle'); tone(436, 116, d, 0.12, 'sine'); vibrate(30); },
  // 金帯「きらん」
  kiran() { tone(1320, 1760, 0.12, 0.18, 'sine'); tone(1980, 2640, 0.18, 0.12, 'sine', 0.06); },
  // 爆発: 1 ぽふ / 2–3 ドン / 4 ドッカーン
  boom(level: 1 | 2 | 3 | 4) {
    if (level === 1) { noise(0.18, 0.35, 1800, 300); return; }
    if (level < 4) { noise(0.35, 0.6, 1400, 120); tone(150, 55, 0.3, 0.5, 'sine'); vibrate(40); return; }
    noise(0.8, 0.85, 1200, 60); tone(110, 35, 0.7, 0.7, 'sine'); tone(220, 60, 0.35, 0.25, 'square', 0.02); vibrate([60, 40, 90]);
  },
  // ばくだん ゲット「ちゃりん」
  coin(delay = 0) { tone(988, 988, 0.08, 0.2, 'square', delay); tone(1319, 1319, 0.22, 0.18, 'square', delay + 0.08); },
  // 5つそろう「ぽぽぽぽぽん」
  win() { [523, 659, 784, 988, 1319].forEach((f, i) => tone(f, f * 0.98, i === 4 ? 0.35 : 0.12, 0.28, 'sine', i * 0.11)); },
  // 手番交代「ぴこ」
  pico(delay = 0) { tone(880, 1175, 0.07, 0.12, 'sine', delay); },
  // CPUの番に触った「ぶぶっ」
  buzz() { tone(140, 120, 0.08, 0.2, 'square'); tone(140, 120, 0.08, 0.2, 'square', 0.11); },
};
