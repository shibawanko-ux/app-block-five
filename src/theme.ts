// Visual tokens for the "puni-puni gummy" theme. Values mirror DESIGN.md §2–3.

export const COLORS = {
  bg: '#2B1B3D',
  bgTop: '#3A2652',
  jar: '#3D2A55',
  jarLine: 'rgba(255,255,255,0.07)',
  glass: 'rgba(255,255,255,0.20)',
  p1: { base: '#36C2F0', light: '#6FD8FA', deep: '#1B8FBF' },
  p2: { base: '#FF7A59', light: '#FFA184', deep: '#D9532F' },
  bomb: '#2A2A2A',
  fuse: '#FF3B5C',
  accent: '#FFE14D',
  sub: '#EAD9FF',
  text: '#FFF6EC',
  muted: '#BFAED6',
} as const;

export const FONTS = {
  logo: '"Bagel Fat One", "Mochiy Pop One", system-ui, sans-serif',
  heading: '"Mochiy Pop One", system-ui, sans-serif',
  body: '"M PLUS Rounded 1c", system-ui, sans-serif',
} as const;
