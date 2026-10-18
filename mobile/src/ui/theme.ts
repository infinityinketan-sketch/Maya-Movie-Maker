// "Night shoot" palette: deep aubergine black, warm saffron key light, cool teal for "done".
export const colors = {
  bg: '#0D0A12',
  surface: '#17121F',
  surfaceRaised: '#211A2C',
  border: '#2E2539',
  text: '#F4EFF8',
  textMuted: '#A99DB8',
  textFaint: '#6F6380',
  accent: '#F5A524',
  accentInk: '#1A1206',
  accentSoft: 'rgba(245,165,36,0.14)',
  good: '#3CCFB4',
  goodSoft: 'rgba(60,207,180,0.14)',
  warn: '#FFB86B',
  danger: '#FF6B81',
  dangerSoft: 'rgba(255,107,129,0.14)',
};

export const space = (n: number) => n * 8;
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const type = {
  display: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.5, color: colors.text },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.text },
  heading: { fontSize: 17, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, lineHeight: 22, color: colors.text },
  small: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  label: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 1, textTransform: 'uppercase' as const, color: colors.textFaint },
};
