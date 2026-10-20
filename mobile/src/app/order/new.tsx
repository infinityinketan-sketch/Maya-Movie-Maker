import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { filmEstimate, planCost } from '../../lib/cost';
import { useCatalog, useWallet } from '../../lib/hooks';
import type { Tier } from '../../lib/types';
import { Button, Card, Chip, confirmSpend, Field, Screen, SectionLabel, showError } from '../../ui/kit';
import { colors, radius, space, type } from '../../ui/theme';

const FALLBACK_TYPES = ['Sweet shop', 'Restaurant / cafe', 'Salon / beauty parlour', 'Gym / fitness', 'Clinic / doctor', 'Clothing / boutique', 'Jewellery', 'Mobile / electronics', 'Coaching class', 'Real estate', 'Grocery / kirana', 'Other'];
const FALLBACK_OCCASIONS = ['Diwali', 'Navratri / Dussehra', 'Ganpati', 'Gudi Padwa', 'Holi', 'Eid', 'Christmas', 'New year', 'Grand opening', 'Sale', 'Wedding season'];

export default function NewOrder() {
  const cat = useCatalog();
  const { balance } = useWallet();
  const [types, setTypes] = useState(FALLBACK_TYPES);
  const [occasions, setOccasions] = useState(FALLBACK_OCCASIONS);
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [business, setBusiness] = useState('');
  const [bizType, setBizType] = useState('Sweet shop');
  const [area, setArea] = useState('');
  const [offer, setOffer] = useState('');
  const [occasion, setOccasion] = useState<string | null>('Diwali');
  const [language, setLanguage] = useState('Marathi');
  const [contact, setContact] = useState('');
  const [length, setLength] = useState(20);
  const [tier, setTier] = useState<Tier>('budget');
  const [price, setPrice] = useState('499');
  const [advance, setAdvance] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ uri: string; mimeType: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .orderOptions()
      .then((o) => {
        setTypes(o.businessTypes);
        setOccasions(o.occasions);
      })
      .catch(() => undefined);
  }, []);

  async function pickPhoto() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false });
    if (!res.canceled && res.assets[0]) setPhoto({ uri: res.assets[0].uri, mimeType: res.assets[0].mimeType ?? 'image/jpeg' });
  }

  const credits = cat ? filmEstimate(cat, { tier, target_duration_sec: length }) + cat.image * 2 : 0;
  const apiCostInr = cat ? Math.round(credits / cat.markup) : 0;
  const priceNum = Math.max(0, Math.round(Number(price) || 0));
  const advanceNum = advance === null ? Math.ceil(priceNum / 2) : Math.min(priceNum, Math.max(0, Math.round(Number(advance) || 0)));
  const advanced = priceNum > 0 && advanceNum >= Math.ceil(priceNum / 2);
  const profit = priceNum - apiCostInr;
  const storyCost = cat ? planCost(cat, length) : 0;
  const valid = customer.trim().length >= 2 && phone.replace(/\D/g, '').length >= 10 && business.trim().length >= 2 && offer.trim().length >= 3;

  async function create() {
    if (advanced && !(await confirmSpend({ action: 'Start this ad', credits: storyCost, balance, detail: 'Maya writes the ad script and shot list now. You approve frames and pay for video step by step.' }))) return;
    setBusy(true);
    try {
      const photoUrl = photo ? (await api.uploadPhoto(photo.uri, photo.mimeType)).url : undefined;
      const { order, project } = await api.createOrder({
        customer_name: customer.trim(),
        customer_phone: phone.trim(),
        business_name: business.trim(),
        business_type: bizType,
        area: area.trim() || undefined,
        offer: offer.trim(),
        occasion: occasion ?? undefined,
        language,
        contact_line: contact.trim() || undefined,
        photo_url: photoUrl,
        price_inr: priceNum,
        advance_inr: advanceNum,
        target_duration_sec: length,
        tier,
      });
      if (advanced) {
        await api.plan(project.id);
        await api.updateOrder(order.id, { status: 'producing' });
      }
      router.replace({ pathname: '/order/[id]', params: { id: order.id } });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <SectionLabel>Customer</SectionLabel>
      <Field label="Name" value={customer} onChangeText={setCustomer} placeholder="Sunil Patil" />
      <Field label="WhatsApp number" value={phone} onChangeText={setPhone} placeholder="98765 43210" keyboardType="phone-pad" />

      <SectionLabel>Business</SectionLabel>
      <Field label="Shop name" value={business} onChangeText={setBusiness} placeholder="Sunil Sweets" />
      <View style={st.wrap}>
        {types.map((t) => (
          <Chip key={t} label={t} selected={bizType === t} onPress={() => setBizType(t)} />
        ))}
      </View>
      <Field label="Area" value={area} onChangeText={setArea} placeholder="Pimple Saudagar, Pune" style={{ marginTop: space(2) }} />
      <Field label="Offer" value={offer} onChangeText={setOffer} placeholder="20% off on all Diwali gift boxes" multiline />
      <Field label="Contact on poster" value={contact} onChangeText={setContact} placeholder="98765 43210 · Kunal Icon Road" />

      <Text style={[type.label, { marginBottom: 6 }]}>Shop or product photo</Text>
      <Pressable onPress={pickPhoto} style={st.photo} accessibilityRole="button" accessibilityLabel="Choose photo">
        {photo ? <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Text style={type.small}>Tap to add a photo — Maya matches the real shop in every shot</Text>}
      </Pressable>

      <SectionLabel>Occasion</SectionLabel>
      <View style={st.wrap}>
        <Chip label="None" selected={occasion === null} onPress={() => setOccasion(null)} />
        {occasions.map((o) => (
          <Chip key={o} label={o} selected={occasion === o} onPress={() => setOccasion(o)} />
        ))}
      </View>

      <SectionLabel>Language</SectionLabel>
      <View style={st.wrap}>
        {['Marathi', 'Hindi', 'English'].map((l) => (
          <Chip key={l} label={l} selected={language === l} onPress={() => setLanguage(l)} />
        ))}
      </View>

      <SectionLabel>Length and quality</SectionLabel>
      <View style={st.wrap}>
        {[15, 20, 30].map((l) => (
          <Chip key={l} label={`${l} sec`} selected={length === l} onPress={() => setLength(l)} />
        ))}
      </View>
      <View style={[st.wrap, { marginTop: space(1) }]}>
        <Chip label="Draft 720p" selected={tier === 'budget'} onPress={() => setTier('budget')} />
        <Chip label="Standard 1080p" selected={tier === 'standard'} onPress={() => setTier('standard')} />
        <Chip label="Premium" selected={tier === 'premium'} onPress={() => setTier('premium')} />
      </View>

      <SectionLabel>Price to customer</SectionLabel>
      <Field label="Price ₹" value={price} onChangeText={(t) => setPrice(t.replace(/\D/g, ''))} keyboardType="number-pad" />
      <Field
        label="Advance received ₹"
        value={String(advanceNum)}
        onChangeText={(t) => setAdvance(t.replace(/\D/g, ''))}
        keyboardType="number-pad"
        hint={`At least ₹${Math.ceil(priceNum / 2)} (50%) before work starts. Enter 0 if not received yet — the order waits.`}
      />
      <Card>
        <Text style={type.small}>Your API cost, including a few re-takes and the poster</Text>
        <Text style={[type.title, { color: colors.text }]}>≈ ₹{apiCostInr.toLocaleString('en-IN')}</Text>
        <Text style={[type.small, { marginTop: 4, color: profit > 0 ? colors.good : colors.danger }]}>
          {profit > 0 ? `Profit ≈ ₹${profit.toLocaleString('en-IN')} on this order` : 'Price is below cost — raise the price or use Draft quality'}
        </Text>
        <Text style={[type.small, { marginTop: 4 }]}>Uses about {credits.toLocaleString('en-IN')} of your credits.</Text>
      </Card>

      <Button
        title={advanced ? 'Start the ad' : 'Save order · wait for advance'}
        kind={advanced ? 'primary' : 'secondary'}
        cost={advanced ? storyCost : undefined}
        onPress={create}
        loading={busy}
        disabled={!valid || !cat || priceNum < 1}
        style={{ marginTop: space(2) }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: {
    height: 160,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: space(2),
    marginBottom: space(1),
  },
});
