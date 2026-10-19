import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { useOrder, useProject } from '../../lib/hooks';
import type { OrderStatus } from '../../lib/types';
import { Button, Card, Chip, Field, Screen, SectionLabel, showError, StatusPill } from '../../ui/kit';
import { Player, shareImage, shareVideo } from '../../ui/media';
import { colors, radius, space, type } from '../../ui/theme';
import { ORDER_STATUS } from '../../lib/orders';

const FLOW: OrderStatus[] = ['new', 'producing', 'ready', 'delivered', 'paid'];

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { order } = useOrder(id);
  const { project, shots } = useProject(order?.project_id ?? undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);

  if (!order) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }
  const setStatus = (status: OrderStatus) => run(status, () => api.updateOrder(order.id, { status }));

  const filmed = shots.filter((s) => s.video_url).length;
  const videoReady = Boolean(project?.final_video_url);
  const posterReady = Boolean(project?.poster_url);

  async function sendWhatsApp() {
    const { link } = await api.orderWhatsapp(order!.id);
    await Linking.openURL(link);
    if (order!.status !== 'delivered' && order!.status !== 'paid') {
      Alert.alert('Mark as delivered?', 'Did you send the Reel and poster to the customer?', [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Yes, delivered', onPress: () => setStatus('delivered') },
      ]);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: order.business_name }} />
      <Card>
        <Text style={[type.small, { color: ORDER_STATUS[order.status].color, fontWeight: '700' }]}>{ORDER_STATUS[order.status].label}</Text>
        <Text style={[type.title, { marginTop: 4 }]}>{order.business_name}</Text>
        <Text style={type.small}>
          {order.business_type}
          {order.area ? ` · ${order.area}` : ''}
          {order.occasion ? ` · ${order.occasion}` : ''} · {order.language}
        </Text>
        <Text style={[type.body, { marginTop: space(1), color: colors.accent }]}>{order.offer}</Text>
        <Text style={[type.small, { marginTop: space(1) }]}>
          {order.customer_name} · {order.customer_phone} · ₹{order.price_inr}
        </Text>
      </Card>

      <SectionLabel>Status</SectionLabel>
      <View style={st.wrap}>
        {FLOW.map((s) => (
          <Chip key={s} label={ORDER_STATUS[s].label} selected={order.status === s} onPress={() => setStatus(s)} />
        ))}
        <Chip label="Cancelled" selected={order.status === 'cancelled'} onPress={() => setStatus('cancelled')} />
      </View>

      <SectionLabel>Production</SectionLabel>
      <Card>
        {project ? (
          <>
            <Text style={type.body}>
              {project.status === 'planning'
                ? 'Writing the ad script…'
                : shots.length
                  ? `${filmed}/${shots.length} shots filmed · ${videoReady ? 'final cut ready' : 'final cut not made yet'} · ${posterReady ? 'poster ready' : 'no poster yet'}`
                  : 'Script not written yet'}
            </Text>
            <Button
              title="Open in studio"
              style={{ marginTop: space(1.5) }}
              onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
            />
            <Text style={[type.small, { marginTop: space(1) }]}>In the studio: create looks → draw and approve frames → film → music → final cut → poster (Film step).</Text>
          </>
        ) : (
          <Text style={type.small}>The film for this order was deleted.</Text>
        )}
      </Card>

      {project?.final_video_url ? (
        <>
          <SectionLabel>Reel</SectionLabel>
          <Player uri={project.final_video_url} ratio={project.aspect_ratio} />
          <Button title="Send video file" kind="secondary" style={{ marginTop: space(1.5) }} loading={busy === 'sv'} onPress={() => run('sv', () => shareVideo(project.final_video_url!, order.business_name))} />
        </>
      ) : null}

      {project?.poster_url ? (
        <>
          <SectionLabel right={<StatusPill status={project.poster_status} />}>Poster</SectionLabel>
          <View style={st.poster}>
            <Image source={{ uri: project.poster_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
          </View>
          <Text style={[type.small, { marginTop: 6, color: colors.warn }]}>Check the spelling of the shop name, offer and phone number before sending.</Text>
          <Button title="Send poster file" kind="secondary" style={{ marginTop: space(1) }} loading={busy === 'sp'} onPress={() => run('sp', () => shareImage(project.poster_url!, `${order.business_name} poster`))} />
        </>
      ) : null}

      <SectionLabel>Deliver</SectionLabel>
      <Button title="Message customer on WhatsApp" disabled={!videoReady && !posterReady} loading={busy === 'wa'} onPress={() => run('wa', sendWhatsApp)} />
      <Text style={[type.small, { marginTop: 6 }]}>Opens their chat with the Reel and poster links and the amount due. Send the files too for the best quality on Status.</Text>
      {order.status !== 'paid' ? (
        <Button title={`Mark ₹${order.price_inr} as paid`} kind="secondary" style={{ marginTop: space(1.5) }} loading={busy === 'paid'} onPress={() => setStatus('paid')} />
      ) : (
        <Text style={[type.small, { marginTop: space(1.5), color: colors.good }]}>Paid {order.paid_at ? new Date(order.paid_at).toLocaleDateString('en-IN') : ''}</Text>
      )}

      <SectionLabel>Notes</SectionLabel>
      <Field
        label="Private notes"
        value={notes ?? order.notes ?? ''}
        onChangeText={setNotes}
        multiline
        placeholder="Wants a second version for Bhau-beej…"
        onEndEditing={() => notes !== null && notes !== order.notes && api.updateOrder(order.id, { notes }).catch(showError)}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  poster: { width: '60%', aspectRatio: 9 / 16, alignSelf: 'center', borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surfaceRaised },
});
