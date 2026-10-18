import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useCameraLibrary } from '../lib/hooks';
import type { CameraGroup, CameraGroupId, DirectorOption, FilmReview, ReviewNote } from '../lib/types';
import { Button, Card, Chip } from './kit';
import { colors, radius, space, type } from './theme';

/** Shown instead of the Director tools until the user buys their first credit pack. */
export function DirectorLocked() {
  return (
    <Card style={{ borderColor: colors.accent, backgroundColor: colors.accentSoft }}>
      <Text style={[type.label, { color: colors.accent }]}>Director tools · paid members</Text>
      <Text style={[type.heading, { marginTop: 6 }]}>Shoot like a real director</Text>
      <Text style={[type.small, { marginTop: 6 }]}>
        • Camera library: 40+ shot sizes, angles, moves, lenses and lighting, each explained in plain words{'\n'}• Ask the Director: three ways to shoot any shot{'\n'}•
        Director&apos;s review: notes on your whole shot list, applied in one tap
      </Text>
      <Button title="Unlock with any credit pack" style={{ marginTop: space(2) }} onPress={() => router.push('/wallet')} />
    </Card>
  );
}

type Picks = Partial<Record<CameraGroupId, string>>;

/** Finds which library options a camera line already contains, so the picker opens on them. */
export function picksFrom(camera: string, groups: CameraGroup[]): Picks {
  const low = camera.toLowerCase();
  const picks: Picks = {};
  for (const g of groups) {
    const hit = g.options.find((o) => low.includes(o.prompt.toLowerCase()));
    if (hit) picks[g.id] = hit.id;
  }
  return picks;
}

export function composeFrom(picks: Picks, groups: CameraGroup[]): string {
  return groups
    .map((g) => g.options.find((o) => o.id === picks[g.id])?.prompt)
    .filter(Boolean)
    .join(', ');
}

/** Tap-to-build camera line: one choice per group, with what each choice makes the audience feel. */
export function CameraPicker({ camera, onChange }: { camera: string; onChange: (camera: string) => void }) {
  const groups = useCameraLibrary();
  const initial = useMemo(() => (groups ? picksFrom(camera, groups) : {}), [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picks, setPicks] = useState<Picks | null>(null);
  const current = picks ?? initial;
  const [focus, setFocus] = useState<{ group: CameraGroupId; id: string } | null>(null);

  if (!groups) return <ActivityIndicator color={colors.accent} style={{ marginVertical: space(2) }} />;

  function toggle(g: CameraGroup, id: string) {
    const next = { ...current, [g.id]: current[g.id] === id ? undefined : id };
    setPicks(next);
    setFocus({ group: g.id, id });
    onChange(composeFrom(next, groups!));
  }

  const focused = focus ? groups.find((g) => g.id === focus.group)?.options.find((o) => o.id === focus.id) : null;

  return (
    <View>
      {groups.map((g) => (
        <View key={g.id} style={{ marginBottom: space(1.5) }}>
          <Text style={[type.label, { marginBottom: 6 }]}>{g.title}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: space(2) }}>
            {g.options.map((o) => (
              <Chip key={o.id} label={o.label} selected={current[g.id] === o.id} onPress={() => toggle(g, o.id)} />
            ))}
          </ScrollView>
        </View>
      ))}
      {focused ? (
        <View style={st.tip}>
          <Text style={[type.small, { color: colors.text }]}>
            <Text style={{ fontWeight: '700' }}>{focused.label}: </Text>
            {focused.says}
          </Text>
          <Text style={[type.small, { marginTop: 2 }]}>Good for: {focused.useFor}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function DirectorOptions({ options, onUse, busyIndex }: { options: DirectorOption[]; onUse: (o: DirectorOption, i: number) => void; busyIndex: number | null }) {
  return (
    <View style={{ gap: space(1.5) }}>
      {options.map((o, i) => (
        <Card key={i}>
          <Text style={[type.heading, { color: colors.accent }]}>{o.title || `Option ${i + 1}`}</Text>
          <Text style={[type.small, { color: colors.text, marginTop: 4 }]}>🎥 {o.camera}</Text>
          <Text style={[type.small, { marginTop: 6 }]}>{o.why}</Text>
          <Text style={[type.small, { marginTop: 6, color: colors.textFaint }]} numberOfLines={4}>
            {o.action}
          </Text>
          <Button title="Use this" kind="secondary" style={{ marginTop: space(1.5) }} loading={busyIndex === i} onPress={() => onUse(o, i)} />
        </Card>
      ))}
    </View>
  );
}

export function ReviewView({
  review,
  applied,
  busy,
  onApply,
  onApplyAll,
}: {
  review: FilmReview;
  applied: Set<number>;
  busy: number | 'all' | null;
  onApply: (n: ReviewNote, i: number) => void;
  onApplyAll: () => void;
}) {
  const fixable = review.notes.map((n, i) => ({ n, i })).filter(({ n, i }) => (n.camera || n.action) && !applied.has(i));
  return (
    <View>
      <Card style={{ borderColor: colors.accent }}>
        <Text style={[type.label, { color: colors.accent }]}>Director&apos;s review</Text>
        <Text style={[type.body, { marginTop: 6 }]}>{review.summary}</Text>
        {review.strengths.map((s, i) => (
          <Text key={i} style={[type.small, { marginTop: 4, color: colors.good }]}>
            ✓ {s}
          </Text>
        ))}
      </Card>
      {review.notes.length === 0 ? <Text style={[type.small, { marginTop: space(1.5) }]}>No changes needed — this shot list is ready to film.</Text> : null}
      {fixable.length > 1 ? <Button title={`Apply all ${fixable.length} fixes`} style={{ marginTop: space(1.5) }} loading={busy === 'all'} onPress={onApplyAll} /> : null}
      {review.notes.map((n, i) => (
        <Card key={i} style={{ marginTop: space(1.5) }}>
          <Text style={[type.small, { color: colors.textFaint }]}>Shot {n.shot}</Text>
          <Text style={[type.body, { marginTop: 2 }]}>{n.issue}</Text>
          <Text style={[type.small, { marginTop: 4, color: colors.text }]}>→ {n.suggestion}</Text>
          {n.camera ? <Text style={[type.small, { marginTop: 4 }]}>🎥 {n.camera}</Text> : null}
          {n.camera || n.action ? (
            applied.has(i) ? (
              <Text style={[type.small, { color: colors.good, marginTop: space(1) }]}>✓ Applied</Text>
            ) : (
              <Button title="Apply to shot" kind="secondary" style={{ marginTop: space(1.5) }} loading={busy === i} onPress={() => onApply(n, i)} />
            )
          ) : null}
        </Card>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  tip: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: space(1.5), borderWidth: 1, borderColor: colors.border },
});
