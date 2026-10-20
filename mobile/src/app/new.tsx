import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from '../lib/api';
import { filmEstimate, planCost } from '../lib/cost';
import { useCatalog, useWallet } from '../lib/hooks';
import type { Tier } from '../lib/types';
import { Button, Card, Chip, confirmSpend, Field, Screen, SectionLabel, showError } from '../ui/kit';
import { colors, space, type } from '../ui/theme';

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Romance', 'Sci-fi', 'Fantasy', 'Horror', 'Documentary', 'Ad / promo', 'Kids'];
const LANGUAGES = ['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Gujarati', 'Kannada', 'Malayalam', 'Punjabi'];
const LENGTHS = [15, 30, 60, 120, 180, 300];
const STYLES = ['Cinematic live action', 'Bollywood glossy', 'Gritty handheld', 'Pixar-style 3D animation', 'Anime', 'Watercolour', 'Vintage 70s film'];
const TIERS: { id: Tier; name: string; note: string }[] = [
  { id: 'budget', name: 'Draft', note: '720p · cheapest' },
  { id: 'standard', name: 'Standard', note: '1080p · best value' },
  { id: 'premium', name: 'Premium', note: '1080p · top quality' },
];

export default function NewFilm() {
  const cat = useCatalog();
  const { balance } = useWallet();
  const [idea, setIdea] = useState('');
  const [genre, setGenre] = useState('Drama');
  const [language, setLanguage] = useState('Hindi');
  const [length, setLength] = useState(30);
  const [style, setStyle] = useState(STYLES[0]);
  const [aspect, setAspect] = useState<'16:9' | '9:16'>('9:16');
  const [tier, setTier] = useState<Tier>('standard');
  const [busy, setBusy] = useState(false);

  const storyCost = cat ? planCost(cat, length) : 0;
  const estimate = cat ? filmEstimate(cat, { tier, target_duration_sec: length }) : 0;

  async function create() {
    if (!(await confirmSpend({ action: 'Write the story', credits: storyCost, balance, detail: 'Maya writes the title, characters, scenes and shot list. You can edit everything afterwards.' })))
      return;
    setBusy(true);
    try {
      const p = await api.createProject({ idea: idea.trim(), genre, language, style, aspect_ratio: aspect, target_duration_sec: length, tier });
      await api.plan(p.id);
      router.replace({ pathname: '/project/[id]', params: { id: p.id } });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Field
        label="Your idea"
        value={idea}
        onChangeText={setIdea}
        multiline
        maxLength={4000}
        placeholder="A chaiwala in Pune finds a phone that shows tomorrow's news…"
        hint="One line is enough. Add characters, a twist or a mood if you have them."
      />

      <SectionLabel>Genre</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {GENRES.map((g) => (
          <Chip key={g} label={g} selected={genre === g} onPress={() => setGenre(g)} />
        ))}
      </View>

      <SectionLabel>Dialogue language</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {LANGUAGES.map((l) => (
          <Chip key={l} label={l} selected={language === l} onPress={() => setLanguage(l)} />
        ))}
      </View>

      <SectionLabel>Look</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {STYLES.map((x) => (
          <Chip key={x} label={x} selected={style === x} onPress={() => setStyle(x)} />
        ))}
      </View>

      <SectionLabel>Length</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {LENGTHS.map((l) => (
          <Chip key={l} label={l < 60 ? `${l} sec` : `${l / 60} min`} selected={length === l} onPress={() => setLength(l)} />
        ))}
      </View>

      <SectionLabel>Format</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="Vertical 9:16 · Reels" selected={aspect === '9:16'} onPress={() => setAspect('9:16')} />
        <Chip label="Wide 16:9 · YouTube" selected={aspect === '16:9'} onPress={() => setAspect('16:9')} />
      </View>

      <SectionLabel>Video quality</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {TIERS.map((t) => (
          <Card key={t.id} onPress={() => setTier(t.id)} style={[{ flex: 1, padding: space(1.5) }, tier === t.id && { borderColor: colors.accent, backgroundColor: colors.accentSoft }]}>
            <Text style={[type.heading, { fontSize: 15 }, tier === t.id && { color: colors.accent }]}>{t.name}</Text>
            <Text style={[type.small, { fontSize: 12 }]}>{t.note}</Text>
            {cat ? <Text style={[type.small, { fontSize: 12, marginTop: 4 }]}>{cat.tiers[t.id].videoPerShot['6']} cr / 6s shot</Text> : null}
          </Card>
        ))}
      </View>

      <Card style={{ marginTop: space(3) }}>
        <Text style={type.small}>Writing the story now costs</Text>
        <Text style={[type.title, { color: colors.accent }]}>{storyCost || '…'} credits</Text>
        <Text style={[type.small, { marginTop: space(1) }]}>
          {length >= 180 ? 'Long films have more shots, so faces and clothes can drift between scenes — create character looks first and check every frame. ' : ''}The whole film usually takes about {estimate ? estimate.toLocaleString('en-IN') : '…'} credits (₹1 each), including a few re-takes. You approve and pay step by step — nothing is filmed until you say so.
        </Text>
      </Card>

      <Button title="Write my story" cost={storyCost} onPress={create} loading={busy} disabled={idea.trim().length < 10 || !cat} style={{ marginTop: space(2) }} />
    </Screen>
  );
}
