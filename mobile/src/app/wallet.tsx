import { isUserCancelledError, useIAP, type Purchase } from 'expo-iap';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useCatalog, useSession, useWallet } from '../lib/hooks';
import { Button, Card, Screen, SectionLabel, showError } from '../ui/kit';
import { colors, space, type } from '../ui/theme';

const KIND_LABEL: Record<string, string> = {
  purchase: 'Bought',
  charge: 'Used',
  refund: 'Refund',
  grant: 'Bonus',
  expire: 'Expired',
  adjust: 'Adjustment',
};

export default function Wallet() {
  const { session } = useSession();
  const { balance, ledger, reload } = useWallet();
  const cat = useCatalog();
  const [buying, setBuying] = useState<string | null>(null);
  const handled = useRef(new Set<string>());

  // Credits are granted only after our server verifies the purchase with Google Play,
  // then the purchase is consumed so the pack can be bought again.
  async function deliver(purchase: Purchase) {
    const token = purchase.purchaseToken;
    if (!token || handled.current.has(token)) return;
    handled.current.add(token);
    try {
      const res = await api.verifyPlayPurchase(purchase.productId, token);
      await finishTransaction({ purchase, isConsumable: true });
      reload();
      Alert.alert('Credits added', `${res.credits.toLocaleString('en-IN')} credits are in your account.`);
    } catch (e) {
      handled.current.delete(token);
      showError(e);
    } finally {
      setBuying(null);
    }
  }

  const { connected, products, fetchProducts, requestPurchase, finishTransaction, getAvailablePurchases, availablePurchases } = useIAP({
    onPurchaseSuccess: (p) => deliver(p),
    onPurchaseError: (e) => {
      setBuying(null);
      if (!isUserCancelledError(e)) Alert.alert('Purchase failed', e.message);
    },
  });

  useEffect(() => {
    if (connected && cat) {
      fetchProducts({ skus: cat.packs.map((p) => p.productId), type: 'in-app' }).catch(() => undefined);
      getAvailablePurchases().catch(() => undefined); // finish any purchase interrupted earlier
    }
  }, [connected, cat, fetchProducts, getAvailablePurchases]);

  useEffect(() => {
    for (const p of availablePurchases) deliver(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availablePurchases]);

  async function buy(productId: string) {
    if (!session) return;
    setBuying(productId);
    try {
      await requestPurchase({ request: { google: { skus: [productId], obfuscatedAccountId: session.user.id } }, type: 'in-app' });
    } catch (e) {
      setBuying(null);
      if (!isUserCancelledError(e)) showError(e);
    }
  }

  return (
    <Screen>
      <Card style={{ alignItems: 'center', paddingVertical: space(3) }}>
        <Text style={type.small}>Your balance</Text>
        <Text style={[type.display, { color: colors.accent, fontSize: 40 }]}>{balance === null ? '…' : balance.toLocaleString('en-IN')}</Text>
        <Text style={type.small}>credits · 1 credit ≈ ₹1</Text>
      </Card>

      <SectionLabel>Buy credits</SectionLabel>
      {!cat ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        cat.packs.map((pack) => {
          const storeProduct = products.find((p) => p.id === pack.productId);
          const price = storeProduct?.displayPrice ?? `₹${pack.priceInr.toLocaleString('en-IN')}`;
          const bonus = pack.credits > pack.priceInr ? `+${Math.round((pack.credits / pack.priceInr - 1) * 100)}% bonus` : null;
          return (
            <Card key={pack.productId} style={{ marginBottom: space(1.5), flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={type.heading}>
                  {pack.credits.toLocaleString('en-IN')} credits {bonus ? <Text style={{ color: colors.good, fontSize: 13 }}> {bonus}</Text> : null}
                </Text>
                <Text style={type.small}>
                  {pack.label} · valid {Math.round(pack.validDays / 30)} months
                </Text>
              </View>
              <Button title={price} onPress={() => buy(pack.productId)} loading={buying === pack.productId} disabled={!connected || !storeProduct || buying !== null} style={{ minWidth: 104 }} />
            </Card>
          );
        })
      )}
      {!connected ? <Text style={type.small}>Connecting to Google Play… Purchases need the Play Store version of the app.</Text> : null}
      {cat ? (
        <Text style={[type.small, { marginTop: space(1) }]}>
          What credits buy: a story {cat.planPerDuration['30']} cr · a storyboard frame {cat.image} cr · a 6-second standard shot {cat.tiers.standard.videoPerShot['6']} cr · a music score {cat.music} cr. Failed steps are refunded automatically.
        </Text>
      ) : null}

      <SectionLabel>History</SectionLabel>
      {ledger.length === 0 ? <Text style={type.small}>No activity yet.</Text> : null}
      {ledger.map((row) => (
        <View key={row.id} style={{ flexDirection: 'row', paddingVertical: space(1.25), borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flex: 1 }}>
            <Text style={type.body}>{KIND_LABEL[row.kind] ?? row.kind}</Text>
            <Text style={type.small} numberOfLines={1}>
              {row.note ?? ''} · {new Date(row.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </Text>
          </View>
          <Text style={[type.heading, { color: row.delta > 0 ? colors.good : colors.textMuted }]}>
            {row.delta > 0 ? '+' : ''}
            {row.delta.toLocaleString('en-IN')}
          </Text>
        </View>
      ))}
    </Screen>
  );
}
