import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api';
import type { GenStatus } from '../lib/types';
import { colors, radius, space, type } from './theme';

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const inner = <View style={[{ flex: 1 }, padded && { paddingHorizontal: space(2) }]}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {scroll ? (
        <ScrollView contentContainerStyle={[padded && { paddingHorizontal: space(2) }, { paddingBottom: space(6), paddingTop: space(1) }]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  title,
  onPress,
  kind = 'primary',
  loading,
  disabled,
  cost,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: BtnKind;
  loading?: boolean;
  disabled?: boolean;
  cost?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || loading;
  const bg = { primary: colors.accent, secondary: colors.surfaceRaised, ghost: 'transparent', danger: colors.dangerSoft }[kind];
  const fg = { primary: colors.accentInk, secondary: colors.text, ghost: colors.accent, danger: colors.danger }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cost ? `${title}, ${cost} credits` : title}
      disabled={off}
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        kind === 'secondary' && { borderWidth: 1, borderColor: colors.border },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={s.btnRow}>
          <Text style={[s.btnText, { color: fg }]}>{title}</Text>
          {cost !== undefined && cost > 0 && (
            <View style={[s.costTag, kind === 'primary' ? { backgroundColor: 'rgba(0,0,0,0.15)' } : { backgroundColor: colors.accentSoft }]}>
              <Text style={[s.costText, { color: kind === 'primary' ? colors.accentInk : colors.accent }]}>{cost} cr</Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [s.card, pressed && { backgroundColor: colors.surfaceRaised }, style]}>
        {children}
      </Pressable>
    );
  return <View style={[s.card, style]}>{children}</View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[s.chip, selected && { backgroundColor: colors.accentSoft, borderColor: colors.accent }]}
    >
      <Text style={[s.chipText, selected && { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: space(2) }}>
      <Text style={[type.label, { marginBottom: 6 }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textFaint}
        {...props}
        style={[s.input, props.multiline && { minHeight: 110, textAlignVertical: 'top' }, props.style]}
      />
      {hint ? <Text style={[type.small, { marginTop: 4 }]}>{hint}</Text> : null}
    </View>
  );
}

export function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={s.sectionRow}>
      <Text style={type.label}>{children}</Text>
      {right}
    </View>
  );
}

const STATUS: Record<GenStatus, { label: string; fg: string; bg: string } | null> = {
  none: null,
  queued: { label: 'Queued', fg: colors.textMuted, bg: colors.surfaceRaised },
  running: { label: 'Working…', fg: colors.accent, bg: colors.accentSoft },
  done: { label: 'Ready', fg: colors.good, bg: colors.goodSoft },
  failed: { label: 'Failed · refunded', fg: colors.danger, bg: colors.dangerSoft },
};
export function StatusPill({ status, label }: { status: GenStatus; label?: string }) {
  const st = STATUS[status];
  if (!st) return null;
  return (
    <View style={[s.pill, { backgroundColor: st.bg }]}>
      {(status === 'queued' || status === 'running') && <ActivityIndicator size="small" color={st.fg} style={{ transform: [{ scale: 0.6 }], marginRight: 2 }} />}
      <Text style={[s.pillText, { color: st.fg }]}>{label ?? st.label}</Text>
    </View>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: space(6), paddingHorizontal: space(3) }}>
      <Text style={[type.heading, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[type.small, { textAlign: 'center', marginTop: space(1), marginBottom: space(2) }]}>{body}</Text>
      {action}
    </View>
  );
}

/** Asks before any action that spends credits; sends the user to the wallet if they are short. */
export function confirmSpend(opts: { action: string; credits: number; balance: number | null; detail?: string }): Promise<boolean> {
  const { action, credits, balance, detail } = opts;
  return new Promise((resolve) => {
    if (balance !== null && balance < credits) {
      Alert.alert('Not enough credits', `${action} needs ${credits} credits. You have ${balance}.`, [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Buy credits',
          onPress: () => {
            resolve(false);
            router.push('/wallet');
          },
        },
      ]);
      return;
    }
    Alert.alert(action, `${detail ? detail + '\n\n' : ''}This uses ${credits} credits${balance !== null ? ` (you have ${balance})` : ''}. If it fails, the credits come back automatically.`, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: `Use ${credits} credits`, onPress: () => resolve(true) },
    ]);
  });
}

export function showError(e: unknown) {
  if (e instanceof ApiError && e.code === 'insufficient_credits') {
    Alert.alert('Not enough credits', e.message, [
      { text: 'Later', style: 'cancel' },
      { text: 'Buy credits', onPress: () => router.push('/wallet') },
    ]);
    return;
  }
  Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Please try again.');
}

const s = StyleSheet.create({
  btn: { minHeight: 52, borderRadius: radius.md, paddingHorizontal: space(2.5), alignItems: 'center', justifyContent: 'center' },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: space(1) },
  btnText: { fontSize: 16, fontWeight: '700' },
  costTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  costText: { fontSize: 12, fontWeight: '800' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space(2), borderWidth: 1, borderColor: colors.border },
  chip: {
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { color: colors.textMuted, fontWeight: '600', fontSize: 14 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space(1.75),
    paddingVertical: space(1.5),
    color: colors.text,
    fontSize: 16,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space(3), marginBottom: space(1.25) },
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  pillText: { fontSize: 12, fontWeight: '700' },
});
