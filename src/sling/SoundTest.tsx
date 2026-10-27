// Page for listening to every sound one by one: open the app with ?sounds (not linked from the menu).
import { COLORS as THEME, FONTS } from '../theme';
import MuteButton from './MuteButton';
import { sound, unlock } from './sound';

const LIST: { label: string; play: () => void }[] = [
  { label: '離す「ぽんっ」（弱）', play: () => sound.pop(0.2) },
  { label: '離す「ぽんっ」（強）', play: () => sound.pop(1) },
  { label: '狙いどおり「ぽよん」', play: () => sound.boing() },
  { label: 'ずれ「むにゅ〜ん」（1列）', play: () => sound.squish(1) },
  { label: 'ずれ「むにゅ〜ん」（3列）', play: () => sound.squish(3) },
  { label: '金帯「きらん」', play: () => sound.kiran() },
  { label: '爆発「ぽふ」', play: () => sound.boom(1) },
  { label: '爆発「ドン」', play: () => sound.boom(2) },
  { label: '爆発「ドッカーン」', play: () => sound.boom(4) },
  { label: 'ばくだん ゲット「ちゃりん」', play: () => sound.coin() },
  { label: '5つそろう「ぽぽぽぽぽん」', play: () => sound.win() },
  { label: '手番交代「ぴこ」', play: () => sound.pico() },
  { label: 'CPUの番に触った「ぶぶっ」', play: () => sound.buzz() },
];

export default function SoundTest() {
  const btn: React.CSSProperties = { fontFamily: FONTS.heading, fontSize: 15, padding: '12px 14px', borderRadius: 14, border: 0, background: THEME.sub, color: THEME.bg, cursor: 'pointer', textAlign: 'left' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, overflowY: 'auto', background: THEME.bg, color: THEME.text, padding: 16, fontFamily: FONTS.body }}>
      <div style={{ maxWidth: 420, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 20, flex: 1 }}>おとの ためしページ</h1>
          <MuteButton />
        </div>
        <p style={{ color: THEME.muted, fontSize: 13 }}>ボタンを押すと、その音が鳴ります。スマホはマナーモードを切って聴いてください。</p>
        {LIST.map(it => <button key={it.label} style={btn} onClick={() => { unlock(); setTimeout(it.play, 30); }}>{it.label}</button>)}
      </div>
    </div>
  );
}
