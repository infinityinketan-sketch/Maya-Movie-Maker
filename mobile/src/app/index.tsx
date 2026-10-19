import { Image } from 'expo-image';
import { Link, router, Stack } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useProjects, useRole, useWallet } from '../lib/hooks';
import type { Project } from '../lib/types';
import { Button, Empty } from '../ui/kit';
import { colors, radius, space, type } from '../ui/theme';

const STAGE: Record<Project['status'], string> = {
  draft: 'Idea',
  planning: 'Writing story…',
  planned: 'Story ready',
  producing: 'In production',
  rendering: 'Final cut…',
  done: 'Finished',
  failed: 'Needs attention',
};

function CreditChip() {
  const { balance } = useWallet();
  return (
    <Link href="/wallet" asChild>
      <Pressable accessibilityLabel={`${balance ?? 0} credits. Open credits`} style={st.credit}>
        <Text style={st.creditText}>{balance === null ? '…' : balance.toLocaleString('en-IN')} cr</Text>
      </Pressable>
    </Link>
  );
}

export default function Home() {
  const { projects, reload } = useProjects();
  const role = useRole();
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(1) }}>
              <CreditChip />
              <Link href="/settings" asChild>
                <Pressable accessibilityLabel="Settings" hitSlop={12} style={{ padding: 4 }}>
                  <Text style={{ color: colors.textMuted, fontSize: 20 }}>⚙︎</Text>
                </Pressable>
              </Link>
            </View>
          ),
        }}
      />
      <FlatList
        data={projects ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: space(2), paddingBottom: space(14) }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { reload(); }} tintColor={colors.accent} />}
        ListHeaderComponent={
          <View style={{ marginBottom: space(2) }}>
            {role === 'operator' ? (
              <Pressable onPress={() => router.push('/orders')} style={st.orders} accessibilityRole="button">
                <Text style={[type.label, { color: colors.accent }]}>Studio</Text>
                <Text style={type.heading}>Shop-ad orders →</Text>
                <Text style={type.small}>Take orders, make Reels and posters, deliver on WhatsApp, track payments.</Text>
              </Pressable>
            ) : null}
            <Text style={type.display}>Your films</Text>
          </View>
        }
        ListEmptyComponent={
          projects ? (
            <Empty
              title="No films yet"
              body="Start with one line — a feeling, a place, a twist. Maya turns it into a script, storyboard and finished film."
              action={<Button title="Make your first film" onPress={() => router.push('/new')} />}
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push({ pathname: '/project/[id]', params: { id: item.id } })} style={({ pressed }) => [st.row, pressed && { opacity: 0.8 }]}>
            <View style={st.thumb}>
              {item.thumbnail_url ? (
                <Image source={{ uri: item.thumbnail_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : (
                <Text style={{ color: colors.textFaint, fontSize: 22 }}>🎬</Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={type.heading} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[type.small, { marginTop: 2 }]} numberOfLines={2}>
                {item.logline || item.idea}
              </Text>
              <Text style={[type.small, { marginTop: 6, color: item.status === 'done' ? colors.good : item.status === 'failed' ? colors.danger : colors.accent }]}>
                {STAGE[item.status]} · {item.target_duration_sec}s · {item.aspect_ratio}
              </Text>
            </View>
          </Pressable>
        )}
      />
      {projects && projects.length > 0 && (
        <View style={st.fab}>
          <Button title="＋  New film" onPress={() => router.push('/new')} />
        </View>
      )}
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  credit: { backgroundColor: colors.accentSoft, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill },
  creditText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  row: {
    flexDirection: 'row',
    gap: space(1.5),
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space(1.5),
    marginBottom: space(1.5),
  },
  thumb: {
    width: 96,
    height: 72,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: { position: 'absolute', left: space(2), right: space(2), bottom: space(3) },
  orders: { backgroundColor: colors.accentSoft, borderColor: colors.accent, borderWidth: 1, borderRadius: radius.lg, padding: space(2), marginBottom: space(2.5), gap: 4 },
});
