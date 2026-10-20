import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { api } from '../../lib/api';
import { videoCost } from '../../lib/cost';
import { useCatalog, useDirectorAccess, useProject, useWallet } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import type { DirectorOption, Shot } from '../../lib/types';
import { CameraPicker, DirectorLocked, DirectorOptions } from '../../ui/director';
import { Button, Card, Chip, confirmSpend, Field, Screen, SectionLabel, showError, StatusPill } from '../../ui/kit';
import { aspectOf, Player } from '../../ui/media';
import { colors, radius, space, type } from '../../ui/theme';

export default function ShotScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [projectId, setProjectId] = useState<string>();
  useEffect(() => {
    supabase
      .from('shots')
      .select('project_id')
      .eq('id', id)
      .maybeSingle()
      .then((r) => setProjectId(r.data?.project_id));
  }, [id]);
  const { project, shots, characters } = useProject(projectId);
  const shot = shots.find((s) => s.id === id);
  const cat = useCatalog();
  const { balance } = useWallet();
  const director = useDirectorAccess();

  if (!project || !shot || !cat) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return (
    <ShotEditor
      key={shot.id}
      shot={shot}
      ratio={project.aspect_ratio}
      tierCost={videoCost(cat, project, shot)}
      imageCost={cat.image}
      directCost={cat.director.direct}
      director={director}
      balance={balance}
      speakers={characters.map((c) => c.name)}
    />
  );
}

function ShotEditor({
  shot,
  ratio,
  tierCost,
  imageCost,
  directCost,
  director,
  balance,
  speakers,
}: {
  shot: Shot;
  ratio: '16:9' | '9:16';
  tierCost: number;
  imageCost: number;
  directCost: number;
  director: boolean | null;
  balance: number | null;
  speakers: string[];
}) {
  const [action, setAction] = useState(shot.action);
  const [camera, setCamera] = useState(shot.camera ?? '');
  const [dialogue, setDialogue] = useState(shot.dialogue ?? '');
  const [speaker, setSpeaker] = useState(shot.speaker ?? '');
  const [duration, setDuration] = useState(shot.duration_sec);
  const [busy, setBusy] = useState<string | null>(null);
  const [options, setOptions] = useState<DirectorOption[] | null>(null);
  const [using, setUsing] = useState<number | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const dirty =
    action !== shot.action || camera !== (shot.camera ?? '') || dialogue !== (shot.dialogue ?? '') || speaker !== (shot.speaker ?? '') || duration !== shot.duration_sec;
  const drawing = shot.keyframe_status === 'queued' || shot.keyframe_status === 'running';
  const filming = shot.video_status === 'queued' || shot.video_status === 'running';

  async function go(key: string, spend: { action: string; credits: number } | null, fn: () => Promise<unknown>) {
    if (spend && !(await confirmSpend({ ...spend, balance }))) return;
    setBusy(key);
    try {
      if (dirty) await api.updateShot(shot.id, { action, camera, dialogue, speaker, duration_sec: duration });
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: `Shot ${shot.idx + 1}` }} />

      {shot.video_url ? (
        <>
          <SectionLabel right={<StatusPill status={shot.video_status} label={shot.video_status === 'done' ? `Take ${shot.takes}` : undefined} />}>
            {shot.video_model ? `Video · ${shot.video_model}` : 'Video'}
          </SectionLabel>
          <Player uri={shot.video_url} ratio={ratio} />
        </>
      ) : null}
      {shot.prev_video_url ? (
        <>
          <SectionLabel>{shot.prev_video_model ? `Previous take · ${shot.prev_video_model}` : 'Previous take'}</SectionLabel>
          <Player uri={shot.prev_video_url} ratio={ratio} />
          <Text style={[type.small, { marginTop: 6 }]}>Compare the two. The final cut uses the newest take.</Text>
        </>
      ) : null}

      <SectionLabel right={<StatusPill status={shot.keyframe_status} />}>Storyboard frame</SectionLabel>
      <View style={[st.frame, { aspectRatio: aspectOf(ratio) }, ratio === '9:16' && { width: '65%', alignSelf: 'center' }]}>
        {shot.keyframe_url ? <Image source={{ uri: shot.keyframe_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} /> : null}
        {drawing ? <ActivityIndicator color={colors.accent} /> : !shot.keyframe_url ? <Text style={type.small}>Not drawn yet</Text> : null}
      </View>
      {shot.error && (shot.keyframe_status === 'failed' || shot.video_status === 'failed') ? (
        <Card style={{ borderColor: colors.danger, marginTop: space(1.5) }}>
          <Text style={[type.small, { color: colors.danger }]}>{shot.error}</Text>
          <Text style={[type.small, { marginTop: 4 }]}>Credits for that attempt were returned. Try rewording the shot.</Text>
        </Card>
      ) : null}

      <View style={{ flexDirection: 'row', gap: space(1), marginTop: space(1.5) }}>
        <Button
          title={shot.keyframe_url ? 'Redraw' : 'Draw frame'}
          kind="secondary"
          cost={imageCost}
          disabled={drawing}
          loading={busy === 'draw'}
          style={{ flex: 1 }}
          onPress={() => go('draw', { action: 'Draw this frame', credits: imageCost }, () => api.keyframe(shot.id))}
        />
        {shot.keyframe_url && !drawing ? (
          <Button
            title={shot.approved ? 'Unapprove' : 'Approve'}
            kind={shot.approved ? 'ghost' : 'primary'}
            loading={busy === 'ok'}
            style={{ flex: 1 }}
            onPress={() => go('ok', null, () => api.approve(shot.id, !shot.approved))}
          />
        ) : null}
      </View>
      {shot.approved && shot.keyframe_url ? (
        <Button
          title={shot.video_url ? 'Re-take video' : 'Film this shot'}
          cost={tierCost}
          disabled={filming}
          loading={busy === 'film'}
          style={{ marginTop: space(1) }}
          onPress={() => go('film', { action: shot.video_url ? 'Re-take this shot' : 'Film this shot', credits: tierCost }, () => api.video(shot.id))}
        />
      ) : null}

      <SectionLabel>What happens</SectionLabel>
      <Field label="Action" value={action} onChangeText={setAction} multiline hint="Describe the frame: place, light, who is there, what moves." />
      <Field label="Camera" value={camera} onChangeText={setCamera} placeholder="slow push-in, close-up" hint={director ? 'Type it, or build it with the Director tools below.' : undefined} />
      <Field label="Dialogue" value={dialogue} onChangeText={setDialogue} multiline placeholder="Leave empty for a silent shot" hint="About 2–3 words per second fits the shot." />
      {speakers.length > 0 && (
        <>
          <Text style={[type.label, { marginBottom: 6 }]}>Who speaks</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space(2) }}>
            <Chip label="Nobody" selected={!speaker} onPress={() => setSpeaker('')} />
            {speakers.map((n) => (
              <Chip key={n} label={n} selected={speaker === n} onPress={() => setSpeaker(n)} />
            ))}
          </View>
        </>
      )}
      <Text style={[type.label, { marginBottom: 6 }]}>Length</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: space(2) }}>
        {([4, 6, 8] as const).map((d) => (
          <Chip key={d} label={`${d} sec`} selected={duration === d} onPress={() => setDuration(d)} />
        ))}
      </View>
      <SectionLabel>Director</SectionLabel>
      {director === false ? <DirectorLocked /> : null}
      {director ? (
        <View>
          <Text style={[type.small, { marginBottom: space(1.5) }]}>Tap a shot size, angle, move, lens and light. Each choice tells you what it makes the audience feel.</Text>
          <CameraPicker key={pickerKey} camera={camera} onChange={setCamera} />
          <Button
            title="Ask the Director"
            kind="secondary"
            cost={directCost}
            loading={busy === 'ask'}
            style={{ marginTop: space(1) }}
            onPress={() =>
              go('ask', { action: 'Ask the Director', credits: directCost }, async () => {
                const res = await api.direct(shot.id);
                setOptions(res.options);
              })
            }
          />
          {options ? (
            <View style={{ marginTop: space(2) }}>
              <Text style={[type.small, { marginBottom: space(1) }]}>Three ways to shoot this. Using one replaces the camera and action, and unapproves the frame so you can redraw it.</Text>
              <DirectorOptions
                options={options}
                busyIndex={using}
                onUse={async (o, i) => {
                  setUsing(i);
                  try {
                    await api.updateShot(shot.id, { camera: o.camera, action: o.action });
                    setCamera(o.camera);
                    setAction(o.action);
                    setPickerKey((k) => k + 1);
                    setOptions(null);
                  } catch (e) {
                    showError(e);
                  } finally {
                    setUsing(null);
                  }
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {dirty ? (
        <Button
          title="Save changes"
          kind="secondary"
          loading={busy === 'save'}
          onPress={() => go('save', null, async () => undefined)}
        />
      ) : null}
      {dirty && shot.approved ? <Text style={[type.small, { marginTop: 6 }]}>Saving unapproves the frame so you can check it again.</Text> : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  frame: { width: '100%', backgroundColor: colors.surfaceRaised, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
