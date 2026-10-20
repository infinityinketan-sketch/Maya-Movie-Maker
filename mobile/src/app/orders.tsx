import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOrders } from '../lib/hooks';
import { balance, ORDER_STATUS, received } from '../lib/orders';
import type { AdOrder } from '../lib/types';
import { Button, Empty } from '../ui/kit';
import { colors, radius, space, type } from '../ui/theme';

function totals(orders: AdOrder[]) {
  const paid = orders.reduce((s, o) => s + received(o), 0);
  const due = orders.reduce((s, o) => s + balance(o), 0);
  const open = orders.filter((o) => ['awaiting_advance', 'new', 'producing', 'ready'].includes(o.status)).length;
  return { paid, due, open };
}

export default function Orders() {
  const { orders, reload } = useOrders();
  const t = totals(orders ?? []);
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={orders ?? []}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: space(2), paddingBottom: space(14) }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { reload(); }} tintColor={colors.accent} />}
        ListHeaderComponent={
          orders && orders.length ? (
            <View style={st.stats}>
              <Stat label="Received" value={`₹${t.paid.toLocaleString('en-IN')}`} color={colors.good} />
              <Stat label="To collect" value={`₹${t.due.toLocaleString('en-IN')}`} color={colors.warn} />
              <Stat label="In progress" value={String(t.open)} color={colors.accent} />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          orders ? (
            <Empty
              title="No orders yet"
              body="When a shop owner sends you their offer on WhatsApp, add it here. Maya writes, films and cuts the Reel and makes a poster."
              action={<Button title="Add first order" onPress={() => router.push('/order/new')} />}
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push({ pathname: '/order/[id]', params: { id: item.id } })} style={({ pressed }) => [st.row, pressed && { opacity: 0.85 }]}>
            <View style={{ flex: 1 }}>
              <Text style={type.heading} numberOfLines={1}>
                {item.business_name}
              </Text>
              <Text style={type.small} numberOfLines={1}>
                {item.offer}
              </Text>
              <Text style={[type.small, { marginTop: 4, color: ORDER_STATUS[item.status].color, fontWeight: '700' }]}>{ORDER_STATUS[item.status].label}</Text>
            </View>
            <Text style={[type.heading, { color: colors.text }]}>₹{item.price_inr}</Text>
          </Pressable>
        )}
      />
      {orders && orders.length > 0 && (
        <View style={st.fab}>
          <Button title="＋  New order" onPress={() => router.push('/order/new')} />
        </View>
      )}
    </SafeAreaView>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={st.stat}>
      <Text style={[type.title, { color }]}>{value}</Text>
      <Text style={type.small}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  stats: { flexDirection: 'row', gap: space(1), marginBottom: space(2) },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.lg, padding: space(1.5), borderWidth: 1, borderColor: colors.border },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space(2),
    marginBottom: space(1.5),
  },
  fab: { position: 'absolute', left: space(2), right: space(2), bottom: space(3) },
});
