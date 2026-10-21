import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import {
  addAudio,
  addClip,
  audioPlays,
  clipStarts,
  duplicateClip,
  filmLength,
  isSimpleEdit,
  moveClip,
  removeAudio,
  removeClip,
  secs,
  sourceLength,
  trimAudio,
  trimClip,
  updateAudio,
  updateClip,
  VOLUME_STEPS,
  volumeLabel,
} from '../../lib/edit';
import { useCatalog, useEditorOptions, useEditState, useProject, useWallet } from '../../lib/hooks';
import type { Catalog, Edit, EditorOptions, EditState, MediaItem, Project, Shot } from '../../lib/types';
import { Button, Card, Chip, confirmSpend, Field, Screen, SectionLabel, showError, StatusPill } from '../../ui/kit';
import { aspectOf, Player } from '../../ui/media';
import { colors, radius, space, type } from '../../ui/theme';

export default function EditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { project, shots } = useProject(id);
  const { state, error, setState } = useEditState(id);
  const opts = useEditorOptions();
  const cat = useCatalog();
  const { balance } = useWallet();

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { marginTop: space(4), textAlign: 'center' }]}>{error instanceof Error ? error.message : 'Could not open the editor.'}</Text>
      </Screen>
    );
  }
  if (!project || !state || !cat || !opts) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return <Editor project={project} shots={shots} state={state} setState={setState} opts={opts} cat={cat} balance={balance} />;
}

type Sel = { type: 'clip' | 'audio'; i: number } | null;
type Panel = null | 'clips' | 'sounds' | 'sfx' | 'voice';

function Editor({
  project,
  shots,
  state,
  setState,
  opts,
  cat,
  balance,
}: {
  project: Project;
  shots: Shot[];
  state: EditState;
  setState: (s: EditState) => void;
  opts: EditorOptions;
  cat: Catalog;
  balance: number | null;
}) {
  const [edit, setEdit] = useState<Edit>(state.edit);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const media = state.media;
  const total = filmLength(edit);
  const starts = clipStarts(edit);
  const frameOf = new Map(shots.map((s) => [s.id, s.keyframe_url]));
  const needsMixer = !state.mixer && !isSimpleEdit(edit, media);
  const renderCost = cat.renderPerMinute * Math.max(1, Math.ceil(total / 60));
  const rendering = project.render_status === 'queued' || project.render_status === 'running';
  const selStart = sel?.type === 'clip' ? starts[sel.i] ?? 0 : 0;

  const change = (e: Edit, keep: Sel = sel) => {
    setEdit(e);
    setDirty(true);
    setSel(keep);
  };

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<EditState> {
    const res = await api.saveEdit(project.id, edit);
    setState(res);
    setEdit(res.edit);
    setDirty(false);
    return res;
  }

  const clip = sel?.type === 'clip' ? edit.clips[sel.i] : null;
  const sound = sel?.type === 'audio' ? edit.audio[sel.i] : null;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Edit & mix' }} />

      <View style={st.summary}>
        <View>
          <Text style={type.heading}>{secs(total)}</Text>
          <Text style={type.small}>
            {edit.clips.length} clip{edit.clips.length === 1 ? '' : 's'} · {edit.audio.length} sound{edit.audio.length === 1 ? '' : 's'}
          </Text>
        </View>
        {dirty ? <Text style={[type.small, { color: colors.warn }]}>Not saved</Text> : <Text style={[type.small, { color: colors.good }]}>Saved</Text>}
      </View>

      {/* ------------------------------------------------ picture */}
      <SectionLabel right={<Text style={type.small}>tap a clip to trim it</Text>}>Picture</SectionLabel>
      {edit.clips.length === 0 ? <Text style={[type.small, { marginBottom: space(1) }]}>No clips yet. Add one below.</Text> : null}
      {edit.clips.map((c, i) => {
        const on = sel?.type === 'clip' && sel.i === i;
        const frame = c.shotId ? frameOf.get(c.shotId) : null;
        return (
          <Pressable key={c.id} onPress={() => setSel(on ? null : { type: 'clip', i })} style={[st.row, on && st.rowOn]}>
            <View style={[st.thumb, { aspectRatio: aspectOf(project.aspect_ratio) }]}>
              {frame ? <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Text style={{ fontSize: 16 }}>🎞</Text>}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>
                {c.label}
              </Text>
              <Text style={type.small}>
                at {secs(starts[i])} · {secs(c.out - c.in)}
                {c.in > 0 || c.out < sourceLength(media, c.url, c.out) ? ' · trimmed' : ''}
                {c.volume !== 1 ? ` · ${volumeLabel(c.volume)}` : ''}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {clip && sel ? (
        <Card style={st.panel}>
          <Player key={clip.url} uri={clip.url} ratio={project.aspect_ratio} />
          <Text style={[type.small, { marginTop: space(1) }]}>
            Uses {secs(clip.in)} → {secs(clip.out)} of this {secs(sourceLength(media, clip.url, clip.out))} clip.
          </Text>
          <Stepper label="Start" value={secs(clip.in)} onMinus={() => change(trimClip(edit, sel.i, 'in', -0.5, sourceLength(media, clip.url, clip.out)))} onPlus={() => change(trimClip(edit, sel.i, 'in', 0.5, sourceLength(media, clip.url, clip.out)))} />
          <Stepper label="End" value={secs(clip.out)} onMinus={() => change(trimClip(edit, sel.i, 'out', -0.5, sourceLength(media, clip.url, clip.out)))} onPlus={() => change(trimClip(edit, sel.i, 'out', 0.5, sourceLength(media, clip.url, clip.out)))} />
          <Text style={[type.label, { marginTop: space(1.5), marginBottom: 6 }]}>Clip sound (dialogue, effects)</Text>
          <Chips values={[...VOLUME_STEPS, 2]} selected={clip.volume} label={volumeLabel} onPick={(v) => change(updateClip(edit, sel.i, { volume: v }))} />
          <View style={st.tools}>
            <Tool label="▲ Earlier" disabled={sel.i === 0} onPress={() => change(moveClip(edit, sel.i, -1), { type: 'clip', i: sel.i - 1 })} />
            <Tool label="▼ Later" disabled={sel.i === edit.clips.length - 1} onPress={() => change(moveClip(edit, sel.i, 1), { type: 'clip', i: sel.i + 1 })} />
            <Tool label="Copy" onPress={() => change(duplicateClip(edit, sel.i), { type: 'clip', i: sel.i + 1 })} />
            <Tool label="Delete" danger onPress={() => change(removeClip(edit, sel.i), null)} />
          </View>
        </Card>
      ) : null}

      <Button title="+ Add clip" kind="secondary" style={{ marginTop: space(1) }} onPress={() => setPanel(panel === 'clips' ? null : 'clips')} />
      {panel === 'clips' ? (
        <Card style={st.panel}>
          <Text style={[type.small, { marginBottom: space(1) }]}>{sel?.type === 'clip' ? 'Adds after the selected clip.' : 'Adds at the end.'}</Text>
          {media
            .filter((m) => m.type === 'video')
            .map((m) => (
              <LibraryRow
                key={m.url}
                m={m}
                onAdd={() => {
                  const at = sel?.type === 'clip' ? sel.i + 1 : edit.clips.length;
                  change(addClip(edit, m, at), { type: 'clip', i: at });
                  setPanel(null);
                }}
                onDelete={m.assetId ? () => removeAsset(m) : undefined}
              />
            ))}
          <Button
            title="Upload a clip from phone"
            kind="ghost"
            loading={busy === 'upclip'}
            onPress={() =>
              act('upclip', async () => {
                const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
                const a = res.canceled ? null : res.assets[0];
                if (!a) return;
                await api.uploadAsset(project.id, a.uri, a.mimeType ?? 'video/mp4', a.fileName ?? 'My clip');
              })
            }
          />
        </Card>
      ) : null}

      {/* ------------------------------------------------ sound */}
      <SectionLabel right={<Text style={type.small}>music · voice · effects</Text>}>Sound</SectionLabel>
      {edit.audio.length === 0 ? <Text style={[type.small, { marginBottom: space(1) }]}>Only the clips’ own sound. Add music, a voice-over or effects below.</Text> : null}
      {edit.audio.map((a, i) => {
        const on = sel?.type === 'audio' && sel.i === i;
        const plays = audioPlays(edit, a);
        return (
          <Pressable key={a.id} onPress={() => setSel(on ? null : { type: 'audio', i })} style={[st.row, on && st.rowOn]}>
            <View style={st.badge}>
              <Text style={{ fontSize: 16 }}>{a.kind === 'music' ? '♫' : a.kind === 'voice' ? '🎙' : a.kind === 'sfx' ? '💥' : '🔊'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>
                {a.label}
              </Text>
              <Text style={[type.small, plays === 0 && { color: colors.warn }]}>
                {plays === 0 ? `starts at ${secs(a.start)}, after the film ends` : `at ${secs(a.start)} · plays ${secs(plays)}${a.loop ? ' · loops' : ''} · ${volumeLabel(a.volume)}`}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {sound && sel ? (
        <Card style={st.panel}>
          <Stepper
            label="Starts at"
            value={secs(sound.start)}
            onMinus={() => change(updateAudio(edit, sel.i, { start: Math.max(0, Math.round((sound.start - 0.5) * 100) / 100) }))}
            onPlus={() => change(updateAudio(edit, sel.i, { start: Math.min(600, Math.round((sound.start + 0.5) * 100) / 100) }))}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space(1) }}>
            <Chip label="Film start" onPress={() => change(updateAudio(edit, sel.i, { start: 0 }))} />
            {edit.clips.map((c, k) => (
              <Chip key={c.id} label={`Clip ${k + 1}`} selected={Math.abs(sound.start - starts[k]) < 0.01} onPress={() => change(updateAudio(edit, sel.i, { start: starts[k] }))} />
            ))}
          </View>
          <Stepper label="Trim start" value={secs(sound.in)} onMinus={() => change(trimAudio(edit, sel.i, 'in', -0.5, sourceLength(media, sound.url, sound.out)))} onPlus={() => change(trimAudio(edit, sel.i, 'in', 0.5, sourceLength(media, sound.url, sound.out)))} />
          <Stepper label="Trim end" value={secs(sound.out)} onMinus={() => change(trimAudio(edit, sel.i, 'out', -0.5, sourceLength(media, sound.url, sound.out)))} onPlus={() => change(trimAudio(edit, sel.i, 'out', 0.5, sourceLength(media, sound.url, sound.out)))} />
          <Text style={[type.label, { marginTop: space(1.5), marginBottom: 6 }]}>Volume</Text>
          <Chips values={[0.1, 0.25, 0.35, 0.5, 1, 1.5]} selected={sound.volume} label={volumeLabel} onPick={(v) => change(updateAudio(edit, sel.i, { volume: v }))} />
          <Text style={[type.label, { marginTop: space(1.5), marginBottom: 6 }]}>Fade in</Text>
          <Chips values={[0, 0.5, 1, 2]} selected={sound.fadeIn} label={(v) => (v ? `${v} s` : 'None')} onPick={(v) => change(updateAudio(edit, sel.i, { fadeIn: v }))} />
          <Text style={[type.label, { marginTop: space(1.5), marginBottom: 6 }]}>Fade out</Text>
          <Chips values={[0, 0.5, 1, 2, 3]} selected={sound.fadeOut} label={(v) => (v ? `${v} s` : 'None')} onPick={(v) => change(updateAudio(edit, sel.i, { fadeOut: v }))} />
          <View style={{ flexDirection: 'row', gap: 6, marginTop: space(1.5) }}>
            <Chip label="Play once" selected={!sound.loop} onPress={() => change(updateAudio(edit, sel.i, { loop: false }))} />
            <Chip label="Loop to the end" selected={sound.loop} onPress={() => change(updateAudio(edit, sel.i, { loop: true }))} />
          </View>
          <View style={st.tools}>
            <Tool label="Delete sound" danger onPress={() => change(removeAudio(edit, sel.i), null)} />
          </View>
        </Card>
      ) : null}

      <Button title="+ Add sound" kind="secondary" style={{ marginTop: space(1) }} onPress={() => setPanel(panel === 'sounds' ? null : 'sounds')} />
      {panel === 'sounds' || panel === 'sfx' || panel === 'voice' ? (
        <Card style={st.panel}>
          <Text style={[type.small, { marginBottom: space(1) }]}>
            {sel?.type === 'clip' ? `Adds at ${secs(selStart)} (start of the selected clip).` : 'Adds at the start; set the time after adding. Music always starts at 0 and loops.'}
          </Text>
          {media
            .filter((m) => m.type === 'audio')
            .map((m) => (
              <LibraryRow
                key={m.url}
                m={m}
                onAdd={() => {
                  change(addAudio(edit, m, selStart), { type: 'audio', i: edit.audio.length });
                  setPanel(null);
                }}
                onDelete={m.assetId ? () => removeAsset(m) : undefined}
              />
            ))}
          {state.assets
            .filter((a) => a.status !== 'done')
            .map((a) => (
              <View key={a.id} style={st.libRow}>
                <Text style={[type.small, { flex: 1 }]} numberOfLines={1}>
                  {a.label}
                  {a.status === 'failed' && a.error ? ` — ${a.error}` : ''}
                </Text>
                <StatusPill status={a.status} />
                {a.status === 'failed' ? <Tool label="✕" onPress={() => act('del', () => api.deleteAsset(a.id))} /> : null}
              </View>
            ))}
          <View style={st.tools}>
            <Tool label="💥 AI sound effect" onPress={() => setPanel(panel === 'sfx' ? 'sounds' : 'sfx')} />
            <Tool label="🎙 AI voice-over" onPress={() => setPanel(panel === 'voice' ? 'sounds' : 'voice')} />
            <Tool
              label={busy === 'upsound' ? 'Uploading…' : '🔊 Upload sound'}
              disabled={busy === 'upsound'}
              onPress={() =>
                act('upsound', async () => {
                  const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], copyToCacheDirectory: true });
                  const a = res.canceled ? null : res.assets[0];
                  if (!a) return;
                  await api.uploadAsset(project.id, a.uri, a.mimeType ?? 'audio/mpeg', a.name.replace(/\.[^.]+$/, ''));
                })
              }
            />
          </View>
          {panel === 'sfx' ? <SfxForm projectId={project.id} opts={opts} balance={balance} /> : null}
          {panel === 'voice' ? <VoiceForm projectId={project.id} opts={opts} balance={balance} language={project.language} /> : null}
        </Card>
      ) : null}

      {/* ------------------------------------------------ save + cut */}
      <SectionLabel right={<StatusPill status={project.render_status} />}>Final cut</SectionLabel>
      {needsMixer ? (
        <Card style={{ borderColor: colors.warn, marginBottom: space(1) }}>
          <Text style={[type.small, { color: colors.warn }]}>
            Trims, volume changes and extra sounds need the mixing server, which isn’t set up yet. Until then only whole clips with the looped score can be cut.
          </Text>
        </Card>
      ) : null}
      {dirty ? <Button title="Save edit" kind="secondary" loading={busy === 'save'} onPress={() => act('save', save)} /> : null}
      <Button
        title={project.final_video_url ? 'Re-cut the film' : 'Make the final cut'}
        cost={renderCost}
        disabled={rendering || edit.clips.length === 0 || needsMixer}
        loading={busy === 'render'}
        style={{ marginTop: space(1) }}
        onPress={() =>
          act('render', async () => {
            if (!(await confirmSpend({ action: 'Make the final cut', credits: renderCost, balance, detail: `${secs(total)} film from your edit.` }))) return;
            if (dirty) await save();
            await api.render(project.id);
            Alert.alert('Cutting your film', 'It appears on the Film step in a minute or two. You can close the app meanwhile.');
            router.back();
          })
        }
      />
      {state.custom || dirty ? (
        <Button
          title="Start over from Maya’s cut"
          kind="ghost"
          loading={busy === 'reset'}
          style={{ marginTop: space(0.5) }}
          onPress={() =>
            Alert.alert('Start over?', 'Your trims, order and sounds are replaced by all shots in order with the score.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Start over',
                style: 'destructive',
                onPress: () =>
                  act('reset', async () => {
                    const res = await api.resetEdit(project.id);
                    setState(res);
                    setEdit(res.edit);
                    setDirty(false);
                    setSel(null);
                  }),
              },
            ])
          }
        />
      ) : null}
    </Screen>
  );

  function removeAsset(m: MediaItem) {
    Alert.alert('Delete from library?', `“${m.label}” is removed from this film’s library and from the edit.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          act('del', async () => {
            await api.deleteAsset(m.assetId!);
            const next = { ...edit, clips: edit.clips.filter((c) => c.url !== m.url), audio: edit.audio.filter((a) => a.url !== m.url) };
            if (next.clips.length !== edit.clips.length || next.audio.length !== edit.audio.length) change(next, null);
          }),
      },
    ]);
  }
}

// ---------------------------------------------------------------- AI sounds

function SfxForm({ projectId, opts, balance }: { projectId: string; opts: EditorOptions; balance: number | null }) {
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState(3);
  const [busy, setBusy] = useState(false);
  const cost = opts.sfxPer5Sec * Math.max(1, Math.ceil(seconds / 5));
  return (
    <View style={{ marginTop: space(2) }}>
      <Field label="Describe the sound" value={prompt} onChangeText={setPrompt} placeholder="Temple bell ringing, crowd cheering, door slams" />
      <Text style={[type.label, { marginBottom: 6 }]}>Length</Text>
      <Chips values={[1, 2, 3, 5, 10, Math.min(20, opts.sfxMaxSec)]} selected={seconds} label={(v) => `${v} s`} onPick={setSeconds} />
      <Button
        title="Make sound effect"
        cost={cost}
        disabled={prompt.trim().length < 3}
        loading={busy}
        style={{ marginTop: space(1.5) }}
        onPress={async () => {
          if (!(await confirmSpend({ action: 'Make a sound effect', credits: cost, balance }))) return;
          setBusy(true);
          try {
            await api.soundEffect(projectId, { prompt: prompt.trim(), seconds });
            setPrompt('');
          } catch (e) {
            showError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Text style={[type.small, { marginTop: 6 }]}>Ready in about 10–30 seconds; it appears in the list above.</Text>
    </View>
  );
}

function VoiceForm({ projectId, opts, balance, language }: { projectId: string; opts: EditorOptions; balance: number | null; language: string }) {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(opts.voices[0]?.id ?? 'Aria');
  const [lang, setLang] = useState(opts.languages.includes(language) ? language : 'English');
  const [busy, setBusy] = useState(false);
  const cost = opts.voicePer100Chars * Math.max(1, Math.ceil(text.trim().length / 100));
  return (
    <View style={{ marginTop: space(2) }}>
      <Field
        label="What should the voice say?"
        value={text}
        onChangeText={(t) => setText(t.slice(0, opts.voiceMaxChars))}
        multiline
        placeholder="Diwali offer! 20% off on every sweet box, only at Sunil Sweets."
        hint={`${text.length}/${opts.voiceMaxChars} letters · about 15 letters per second`}
      />
      <Text style={[type.label, { marginBottom: 6 }]}>Voice</Text>
      <View style={st.wrap}>
        {opts.voices.map((v) => (
          <Chip key={v.id} label={v.label} selected={voice === v.id} onPress={() => setVoice(v.id)} />
        ))}
      </View>
      <Text style={[type.label, { marginTop: space(1.5), marginBottom: 6 }]}>Language</Text>
      <View style={st.wrap}>
        {opts.languages.map((l) => (
          <Chip key={l} label={l} selected={lang === l} onPress={() => setLang(l)} />
        ))}
      </View>
      <Button
        title="Make voice-over"
        cost={cost}
        disabled={text.trim().length < 2}
        loading={busy}
        style={{ marginTop: space(1.5) }}
        onPress={async () => {
          if (!(await confirmSpend({ action: 'Make a voice-over', credits: cost, balance }))) return;
          setBusy(true);
          try {
            await api.voiceOver(projectId, { text: text.trim(), voice, language: lang });
            setText('');
          } catch (e) {
            showError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------- small pieces

function LibraryRow({ m, onAdd, onDelete }: { m: MediaItem; onAdd: () => void; onDelete?: () => void }) {
  return (
    <View style={st.libRow}>
      <View style={{ flex: 1 }}>
        <Text style={type.body} numberOfLines={1}>
          {m.label}
        </Text>
        <Text style={type.small}>{secs(m.seconds)}</Text>
      </View>
      {onDelete ? <Tool label="✕" onPress={onDelete} /> : null}
      <Tool label="Add" onPress={onAdd} />
    </View>
  );
}

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={st.stepper}>
      <Text style={[type.small, { flex: 1 }]}>{label}</Text>
      <Tool label="− 0.5 s" onPress={onMinus} />
      <Text style={[type.body, { minWidth: 64, textAlign: 'center' }]}>{value}</Text>
      <Tool label="+ 0.5 s" onPress={onPlus} />
    </View>
  );
}

function Chips({ values, selected, label, onPick }: { values: readonly number[]; selected: number; label: (v: number) => string; onPick: (v: number) => void }) {
  return (
    <View style={st.wrap}>
      {values.map((v) => (
        <Chip key={v} label={label(v)} selected={Math.abs(selected - v) < 0.001} onPress={() => onPick(v)} />
      ))}
    </View>
  );
}

function Tool({ label, onPress, danger, disabled }: { label: string; onPress: () => void; danger?: boolean; disabled?: boolean }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [st.tool, danger && { borderColor: colors.danger }, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={[type.small, { color: danger ? colors.danger : colors.text, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space(1.5) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(1.5), padding: space(1), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: space(1) },
  rowOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  thumb: { width: 44, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  badge: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  panel: { marginTop: space(0.5), marginBottom: space(1.5) },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space(1.5) },
  tool: { paddingHorizontal: space(1.5), paddingVertical: space(1), borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space(1) },
  libRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: space(1), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
