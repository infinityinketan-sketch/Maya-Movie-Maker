import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../../lib/api';
import { framesNeeded, planCost, portraitsNeeded, videoCost, videosNeeded } from '../../lib/cost';
import { useCatalog, useDirectorAccess, useProject, useWallet } from '../../lib/hooks';
import { TIER_NAMES, TIER_ORDER, type Catalog, type Character, type FilmReview, type Project, type ReviewNote, type Scene, type Shot } from '../../lib/types';
import { DirectorLocked, ReviewView } from '../../ui/director';
import { Button, Card, Chip, confirmSpend, Empty, Field, Screen, SectionLabel, showError, StatusPill } from '../../ui/kit';
import { aspectOf, Player, saveImageToPhone, saveVideoToPhone, shareImage, shareVideo } from '../../ui/media';
import { colors, radius, space, type } from '../../ui/theme';

type Step = 'story' | 'cast' | 'board' | 'film';
const STEPS: { id: Step; label: string }[] = [
  { id: 'story', label: '1 Story' },
  { id: 'cast', label: '2 Cast' },
  { id: 'board', label: '3 Storyboard' },
  { id: 'film', label: '4 Film' },
];

function suggestedStep(p: Project, chars: Character[], shots: Shot[]): Step {
  if (!shots.length) return 'story';
  if (chars.some((c) => !c.portrait_url)) return 'cast';
  if (shots.some((s) => !s.approved)) return 'board';
  return 'film';
}

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { project, characters, scenes, shots, loading } = useProject(id);
  const cat = useCatalog();
  const { balance } = useWallet();
  const [step, setStep] = useState<Step | null>(null);

  if (loading || !project || !cat) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  const current = step ?? suggestedStep(project, characters, shots);
  const ctx = { project, characters, scenes, shots, cat, balance };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: project.title,
          headerRight: () => (
            <Pressable
              accessibilityLabel="Delete film"
              hitSlop={12}
              onPress={() =>
                Alert.alert('Delete this film?', 'The script, frames and videos are deleted for good. Credits already used are not returned.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        await api.deleteProject(project.id);
                        router.back();
                      } catch (e) {
                        showError(e);
                      }
                    },
                  },
                ])
              }
            >
              <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete</Text>
            </Pressable>
          ),
        }}
      />
      <View style={st.steps}>
        {STEPS.map((s) => (
          <Pressable key={s.id} onPress={() => setStep(s.id)} style={[st.step, current === s.id && st.stepOn]} accessibilityRole="tab" accessibilityState={{ selected: current === s.id }}>
            <Text style={[st.stepText, current === s.id && { color: colors.accentInk }]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      {project.error && project.status === 'failed' ? (
        <Card style={{ borderColor: colors.danger, marginBottom: space(2) }}>
          <Text style={[type.small, { color: colors.danger }]}>{project.error}</Text>
          <Text style={[type.small, { marginTop: 4 }]}>Your credits for that step were returned.</Text>
        </Card>
      ) : null}

      {current === 'story' && <StoryStep {...ctx} />}
      {current === 'cast' && <CastStep {...ctx} />}
      {current === 'board' && <BoardStep {...ctx} />}
      {current === 'film' && <FilmStep {...ctx} />}
    </Screen>
  );
}

interface Ctx {
  project: Project;
  characters: Character[];
  scenes: Scene[];
  shots: Shot[];
  cat: Catalog;
  balance: number | null;
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, opts: { action: string; credits: number; balance: number | null; detail?: string } | null, fn: () => Promise<unknown>) {
    if (opts && !(await confirmSpend(opts))) return;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

// ---------------------------------------------------------------- 1 Story

function StoryStep({ project, scenes, shots, cat, balance }: Ctx) {
  const { busy, run } = useAction();
  const cost = planCost(cat, project.target_duration_sec);

  if (project.status === 'planning') {
    return (
      <Card style={{ alignItems: 'center', paddingVertical: space(5) }}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[type.heading, { marginTop: space(2) }]}>Writing your story…</Text>
        <Text style={[type.small, { textAlign: 'center', marginTop: 6 }]}>Characters, scenes and every shot. Usually under a minute — you can leave this screen.</Text>
      </Card>
    );
  }
  if (!shots.length) {
    return (
      <Empty
        title="No story yet"
        body={project.idea}
        action={<Button title="Write the story" cost={cost} loading={busy === 'plan'} onPress={() => run('plan', { action: 'Write the story', credits: cost, balance }, () => api.plan(project.id))} />}
      />
    );
  }
  const total = shots.reduce((s, x) => s + x.duration_sec, 0);
  return (
    <View>
      <Text style={type.title}>{project.title}</Text>
      {project.logline ? <Text style={[type.body, { color: colors.accent, marginTop: space(1) }]}>{project.logline}</Text> : null}
      {project.synopsis ? <Text style={[type.body, { color: colors.textMuted, marginTop: space(1) }]}>{project.synopsis}</Text> : null}
      <Text style={[type.small, { marginTop: space(1) }]}>
        {scenes.length} scenes · {shots.length} shots · {total} seconds · {project.language}
      </Text>

      {scenes.map((sc) => (
        <View key={sc.id}>
          <SectionLabel>{sc.heading}</SectionLabel>
          {sc.summary ? <Text style={[type.small, { marginBottom: space(1) }]}>{sc.summary}</Text> : null}
          {shots
            .filter((s) => s.scene_id === sc.id)
            .map((s) => (
              <ShotLine key={s.id} shot={s} />
            ))}
        </View>
      ))}

      <Text style={[type.small, { marginTop: space(3) }]}>Tap any shot to change what happens, the camera or the dialogue — editing is free.</Text>

      <DirectorReview project={project} shots={shots} cat={cat} balance={balance} />
      <Button
        title="Rewrite the whole story"
        kind="secondary"
        cost={cost}
        loading={busy === 'plan'}
        style={{ marginTop: space(2) }}
        onPress={() =>
          run('plan', { action: 'Rewrite the story', credits: cost, balance, detail: 'This replaces all scenes, shots and characters, including frames and videos already made.' }, () => api.plan(project.id))
        }
      />
    </View>
  );
}

function DirectorReview({ project, shots, cat, balance }: Pick<Ctx, 'project' | 'shots' | 'cat' | 'balance'>) {
  const access = useDirectorAccess();
  const [review, setReview] = useState<FilmReview | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | 'all' | 'run' | null>(null);
  const cost = cat.director.reviewByShots[String(Math.min(40, Math.max(1, shots.length)))] ?? 0;

  if (access === null) return null;
  if (!access) {
    return (
      <View style={{ marginTop: space(3) }}>
        <DirectorLocked />
      </View>
    );
  }

  async function runReview() {
    if (!(await confirmSpend({ action: "Director's review", credits: cost, balance, detail: 'A director checks every shot for variety, angles, pacing and anything AI video will struggle with.' }))) return;
    setBusy('run');
    try {
      setReview(await api.review(project.id));
      setApplied(new Set());
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function applyNote(n: ReviewNote, i: number) {
    await api.updateShot(n.shotId, { ...(n.camera ? { camera: n.camera } : {}), ...(n.action ? { action: n.action } : {}) });
    setApplied((prev) => new Set(prev).add(i));
  }

  return (
    <View style={{ marginTop: space(3) }}>
      {!review ? (
        <Card>
          <Text style={[type.label, { color: colors.accent }]}>Director tools</Text>
          <Text style={[type.heading, { marginTop: 6 }]}>Get a director&apos;s notes before you shoot</Text>
          <Text style={[type.small, { marginTop: 6 }]}>Checks opening and ending shots, shot variety, camera angles, dialogue coverage and pacing, with fixes you can apply in one tap.</Text>
          <Button title="Director's review" cost={cost} loading={busy === 'run'} style={{ marginTop: space(1.5) }} onPress={runReview} />
        </Card>
      ) : (
        <ReviewView
          review={review}
          applied={applied}
          busy={busy === 'run' ? null : busy}
          onApply={async (n, i) => {
            setBusy(i);
            try {
              await applyNote(n, i);
            } catch (e) {
              showError(e);
            } finally {
              setBusy(null);
            }
          }}
          onApplyAll={async () => {
            setBusy('all');
            try {
              for (const [i, n] of review.notes.entries()) if ((n.camera || n.action) && !applied.has(i)) await applyNote(n, i);
            } catch (e) {
              showError(e);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </View>
  );
}

function ShotLine({ shot }: { shot: Shot }) {
  return (
    <Card onPress={() => router.push({ pathname: '/shot/[id]', params: { id: shot.id } })} style={{ marginBottom: space(1), padding: space(1.5) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={[type.small, { color: colors.textFaint }]}>
          Shot {shot.idx + 1} · {shot.duration_sec}s{shot.camera ? ` · ${shot.camera}` : ''}
        </Text>
      </View>
      <Text style={type.body} numberOfLines={3}>
        {shot.action}
      </Text>
      {shot.dialogue ? (
        <Text style={[type.body, { color: colors.accent, marginTop: 4, fontStyle: 'italic' }]} numberOfLines={2}>
          {shot.speaker ? `${shot.speaker}: ` : ''}“{shot.dialogue}”
        </Text>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- 2 Cast

function CastStep({ project, characters, cat, balance }: Ctx) {
  const { busy, run } = useAction();
  const missing = portraitsNeeded(characters);
  if (!characters.length) return <Empty title="No characters" body="This story has no recurring characters, so you can go straight to the storyboard." />;
  return (
    <View>
      <Text style={[type.small, { marginBottom: space(2) }]}>
        Each character gets a reference picture. Maya uses it in every shot so faces and clothes stay the same through the film.
      </Text>
      {missing.length > 0 && (
        <Button
          title={`Create ${missing.length} character look${missing.length > 1 ? 's' : ''}`}
          cost={missing.length * cat.image}
          loading={busy === 'all'}
          style={{ marginBottom: space(2) }}
          onPress={() => run('all', { action: 'Create character looks', credits: missing.length * cat.image, balance }, () => api.portraits(project.id))}
        />
      )}
      {characters.map((c) => (
        <CharacterCard key={c.id} c={c} cost={cat.image} balance={balance} />
      ))}
    </View>
  );
}

function CharacterCard({ c, cost, balance }: { c: Character; cost: number; balance: number | null }) {
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(c.description);
  const [voice, setVoice] = useState(c.voice ?? '');
  const working = c.portrait_status === 'queued' || c.portrait_status === 'running';
  return (
    <Card style={{ marginBottom: space(2) }}>
      <View style={[st.portrait, { aspectRatio: 16 / 9 }]}>
        {c.portrait_url ? <Image source={{ uri: c.portrait_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} /> : null}
        {working ? <ActivityIndicator color={colors.accent} /> : !c.portrait_url ? <Text style={type.small}>No look yet</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space(1.5) }}>
        <Text style={type.heading}>{c.name}</Text>
        <StatusPill status={c.portrait_status} />
      </View>
      {editing ? (
        <View style={{ marginTop: space(1) }}>
          <Field label="Look" value={desc} onChangeText={setDesc} multiline />
          <Field label="Voice" value={voice} onChangeText={setVoice} placeholder="warm, deep male voice" />
          <View style={{ flexDirection: 'row', gap: space(1) }}>
            <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => setEditing(false)} />
            <Button
              title="Save"
              style={{ flex: 1 }}
              loading={busy === 'save'}
              onPress={() =>
                run('save', null, async () => {
                  await api.updateCharacter(c.id, { description: desc, voice });
                  setEditing(false);
                })
              }
            />
          </View>
        </View>
      ) : (
        <>
          <Text style={[type.small, { marginTop: 6 }]}>{c.description}</Text>
          {c.voice ? <Text style={[type.small, { marginTop: 4, color: colors.textFaint }]}>Voice: {c.voice}</Text> : null}
          <View style={{ flexDirection: 'row', gap: space(1), marginTop: space(1.5) }}>
            <Button title="Edit" kind="secondary" style={{ flex: 1 }} onPress={() => setEditing(true)} />
            <Button
              title={c.portrait_url ? 'Redo look' : 'Create look'}
              kind={c.portrait_url ? 'secondary' : 'primary'}
              cost={cost}
              style={{ flex: 1.4 }}
              disabled={working}
              loading={busy === 'p'}
              onPress={() => run('p', { action: `Create ${c.name}'s look`, credits: cost, balance }, () => api.portrait(c.id))}
            />
          </View>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- 3 Storyboard

function BoardStep({ project, characters, shots, cat, balance }: Ctx) {
  const { busy, run } = useAction();
  const missing = framesNeeded(shots);
  const ready = shots.filter((s) => s.keyframe_url && !s.approved);
  const castMissing = characters.some((c) => !c.portrait_url);
  if (!shots.length) return <Empty title="Write the story first" body="The storyboard is drawn from the shot list." />;
  return (
    <View>
      <Text style={[type.small, { marginBottom: space(2) }]}>
        Each shot starts from a still frame. Approve the frames you like — only approved shots get filmed, so you never pay for video you didn&apos;t want.
      </Text>
      {castMissing && <Text style={[type.small, { color: colors.warn, marginBottom: space(1.5) }]}>Tip: create the character looks first so faces match across shots.</Text>}
      {missing.length > 0 && (
        <Button
          title={`Draw ${missing.length} frame${missing.length > 1 ? 's' : ''}`}
          cost={missing.length * cat.image}
          loading={busy === 'all'}
          style={{ marginBottom: space(1) }}
          onPress={() => run('all', { action: 'Draw the storyboard', credits: missing.length * cat.image, balance }, () => api.storyboard(project.id))}
        />
      )}
      {ready.length > 1 && (
        <Button
          title={`Approve all ${ready.length} new frames`}
          kind="secondary"
          loading={busy === 'approve'}
          style={{ marginBottom: space(1) }}
          onPress={() => run('approve', null, () => Promise.all(ready.map((s) => api.approve(s.id, true))))}
        />
      )}
      <View style={{ marginTop: space(1) }}>
        {shots.map((s) => (
          <FrameCard key={s.id} shot={s} project={project} cost={cat.image} balance={balance} />
        ))}
      </View>
    </View>
  );
}

function FrameCard({ shot, project, cost, balance }: { shot: Shot; project: Project; cost: number; balance: number | null }) {
  const { busy, run } = useAction();
  const working = shot.keyframe_status === 'queued' || shot.keyframe_status === 'running';
  return (
    <Card style={{ marginBottom: space(2), padding: space(1.5) }}>
      <Pressable onPress={() => router.push({ pathname: '/shot/[id]', params: { id: shot.id } })}>
        <View style={[st.frame, { aspectRatio: aspectOf(project.aspect_ratio) }, project.aspect_ratio === '9:16' && { width: '60%', alignSelf: 'center' }]}>
          {shot.keyframe_url ? <Image source={{ uri: shot.keyframe_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} /> : null}
          {working ? <ActivityIndicator color={colors.accent} /> : null}
          {shot.approved ? (
            <View style={st.approvedBadge}>
              <Text style={{ color: colors.accentInk, fontWeight: '800', fontSize: 12 }}>✓ Approved</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space(1) }}>
        <Text style={[type.small, { color: colors.textFaint }]}>
          Shot {shot.idx + 1} · {shot.duration_sec}s
        </Text>
        <StatusPill status={shot.keyframe_status} />
      </View>
      <Text style={[type.small, { marginTop: 4 }]} numberOfLines={2}>
        {shot.action}
      </Text>
      <View style={{ flexDirection: 'row', gap: space(1), marginTop: space(1.5) }}>
        <Button
          title={shot.keyframe_url ? 'Redraw' : 'Draw'}
          kind="secondary"
          cost={cost}
          disabled={working}
          loading={busy === 'draw'}
          style={{ flex: 1 }}
          onPress={() => run('draw', { action: `Draw shot ${shot.idx + 1}`, credits: cost, balance }, () => api.keyframe(shot.id))}
        />
        {shot.keyframe_url && !working ? (
          <Button
            title={shot.approved ? 'Unapprove' : 'Approve'}
            kind={shot.approved ? 'ghost' : 'primary'}
            loading={busy === 'ok'}
            style={{ flex: 1 }}
            onPress={() => run('ok', null, () => api.approve(shot.id, !shot.approved))}
          />
        ) : null}
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------- 4 Film

function FilmStep({ project, shots, cat, balance }: Ctx) {
  const { busy, run } = useAction();
  const [musicPrompt, setMusicPrompt] = useState(project.music_prompt ?? '');
  const todo = videosNeeded(shots);
  const todoCost = todo.reduce((s, x) => s + videoCost(cat, project, x), 0);
  const filmed = shots.filter((s) => s.video_url).length;
  const allFilmed = shots.length > 0 && filmed === shots.length;
  const unapproved = shots.filter((s) => !s.approved).length;
  const seconds = shots.reduce((s, x) => s + x.duration_sec, 0);
  const renderCost = cat.renderPerMinute * Math.max(1, Math.ceil(seconds / 60));
  const rendering = project.render_status === 'queued' || project.render_status === 'running';
  const musicWorking = project.music_status === 'queued' || project.music_status === 'running';

  if (!shots.length) return <Empty title="Write the story first" body="Then draw and approve the storyboard." />;

  return (
    <View>
      {project.final_video_url ? (
        <View style={{ marginBottom: space(3) }}>
          <SectionLabel>Your film</SectionLabel>
          <Player uri={project.final_video_url} ratio={project.aspect_ratio} />
          <View style={{ flexDirection: 'row', gap: space(1), marginTop: space(1.5) }}>
            <Button title="Save to phone" kind="secondary" style={{ flex: 1 }} loading={busy === 'save'} onPress={() => run('save', null, () => saveVideoToPhone(project.final_video_url!, project.title))} />
            <Button title="Share" style={{ flex: 1 }} loading={busy === 'share'} onPress={() => run('share', null, () => shareVideo(project.final_video_url!, project.title))} />
          </View>
        </View>
      ) : null}

      <SectionLabel right={<Text style={type.small}>{filmed}/{shots.length} filmed</Text>}>Shots</SectionLabel>
      {unapproved > 0 && <Text style={[type.small, { color: colors.warn, marginBottom: space(1) }]}>{unapproved} shot{unapproved > 1 ? 's are' : ' is'} not approved yet — approve frames on the Storyboard step.</Text>}
      {todo.length > 0 && (
        <Button
          title={`Film ${todo.length} approved shot${todo.length > 1 ? 's' : ''}`}
          cost={todoCost}
          loading={busy === 'film'}
          style={{ marginBottom: space(1.5) }}
          onPress={() =>
            run('film', { action: 'Film approved shots', credits: todoCost, balance, detail: `${cat.tiers[project.tier].label}. Each shot takes 1–5 minutes; you can close the app meanwhile.` }, () => api.videos(project.id))
          }
        />
      )}
      {shots.map((s) => (
        <Pressable key={s.id} onPress={() => router.push({ pathname: '/shot/[id]', params: { id: s.id } })} style={st.filmRow}>
          <View style={[st.filmThumb, { aspectRatio: aspectOf(project.aspect_ratio) }]}>
            {s.keyframe_url ? <Image source={{ uri: s.keyframe_url }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={type.small}>
              Shot {s.idx + 1} · {s.duration_sec}s{s.takes > 1 ? ` · ${s.takes} takes` : ''}
            </Text>
            <View style={{ marginTop: 4 }}>
              {s.video_status === 'none' ? (
                <Text style={[type.small, { color: colors.textFaint }]}>{s.approved ? 'Ready to film' : 'Not approved'}</Text>
              ) : (
                <StatusPill status={s.video_status} label={s.video_status === 'done' ? 'Filmed' : undefined} />
              )}
            </View>
          </View>
          <Text style={{ color: colors.textFaint, fontSize: 18 }}>›</Text>
        </Pressable>
      ))}

      <SectionLabel right={<StatusPill status={project.music_status} />}>Music</SectionLabel>
      <Card>
        <TextInput
          value={musicPrompt}
          onChangeText={setMusicPrompt}
          onEndEditing={() => musicPrompt !== project.music_prompt && api.updateProject(project.id, { music_prompt: musicPrompt }).catch(showError)}
          multiline
          placeholder="Soft sitar and strings, hopeful, slow build"
          placeholderTextColor={colors.textFaint}
          style={{ color: colors.text, fontSize: 15, minHeight: 60, textAlignVertical: 'top' }}
        />
        {project.music_url ? <Text style={[type.small, { color: colors.good, marginTop: 6 }]}>Score ready — it plays under the whole film.</Text> : null}
        <Button
          title={project.music_url ? 'New score' : 'Compose score'}
          kind="secondary"
          cost={cat.music}
          disabled={musicWorking}
          loading={busy === 'music'}
          style={{ marginTop: space(1.5) }}
          onPress={() =>
            run('music', { action: 'Compose the score', credits: cat.music, balance }, async () => {
              if (musicPrompt !== project.music_prompt) await api.updateProject(project.id, { music_prompt: musicPrompt });
              await api.music(project.id);
            })
          }
        />
      </Card>

      <SectionLabel right={<StatusPill status={project.render_status} />}>Final cut</SectionLabel>
      <Card>
        <Text style={type.small}>
          {project.edit
            ? 'Your own edit is saved — trims, order and sounds. Make the cut from the editor.'
            : allFilmed
              ? `Joins all ${shots.length} shots${project.music_url ? ' with your score' : ''} into one ${seconds}-second film. Want to trim, reorder or add voice-over and sound effects? Open the editor.`
              : 'Film every shot first — or open the editor to cut the film from the shots you have.'}
        </Text>
        {project.edit ? null : (
          <Button
            title={project.final_video_url ? 'Re-cut the film' : 'Make the final cut'}
            cost={renderCost}
            disabled={!allFilmed || rendering}
            loading={busy === 'render'}
            style={{ marginTop: space(1.5) }}
            onPress={() => run('render', { action: 'Make the final cut', credits: renderCost, balance }, () => api.render(project.id))}
          />
        )}
        <Button
          title="Edit & mix"
          kind={project.edit ? 'primary' : 'secondary'}
          disabled={filmed === 0 || rendering}
          style={{ marginTop: space(1) }}
          onPress={() => router.push({ pathname: '/edit/[id]', params: { id: project.id } })}
        />
      </Card>

      {project.kind === 'ad' ? (
        <>
          <SectionLabel right={<StatusPill status={project.poster_status} />}>WhatsApp poster</SectionLabel>
          <Card>
            {project.poster_url ? (
              <View style={{ width: '60%', aspectRatio: 9 / 16, alignSelf: 'center', borderRadius: radius.md, overflow: 'hidden', marginBottom: space(1.5) }}>
                <Image source={{ uri: project.poster_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
              </View>
            ) : null}
            <Text style={type.small}>A Status-size poster with the shop name, offer and contact written on it, using the shop photo. Check the spelling before sending.</Text>
            <Button
              title={project.poster_url ? 'New poster' : 'Make poster'}
              kind="secondary"
              cost={cat.image}
              disabled={project.poster_status === 'queued' || project.poster_status === 'running'}
              loading={busy === 'poster'}
              style={{ marginTop: space(1.5) }}
              onPress={() => run('poster', { action: 'Make the poster', credits: cat.image, balance }, () => api.poster(project.id))}
            />
            {project.poster_url ? (
              <View style={{ flexDirection: 'row', gap: space(1), marginTop: space(1) }}>
                <Button title="Save" kind="ghost" style={{ flex: 1 }} loading={busy === 'psave'} onPress={() => run('psave', null, () => saveImageToPhone(project.poster_url!, `${project.title} poster`))} />
                <Button title="Share" kind="ghost" style={{ flex: 1 }} loading={busy === 'pshare'} onPress={() => run('pshare', null, () => shareImage(project.poster_url!, `${project.title} poster`))} />
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      <SectionLabel>Quality</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {TIER_ORDER.map((t) => (
          <Chip
            key={t}
            label={`${TIER_NAMES[t]} · ${cat.tiers[t].videoPerShot['6']} cr`}
            selected={project.tier === t}
            onPress={() => api.updateProject(project.id, { tier: t }).catch(showError)}
          />
        ))}
      </View>
      <Text style={[type.small, { marginTop: 6 }]}>Price per 6-second shot. Changes apply to shots you film next. To compare two models, switch quality and re-take a shot — the shot screen keeps the previous take next to the new one.</Text>
    </View>
  );
}

const st = StyleSheet.create({
  steps: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, padding: 4, marginBottom: space(2.5), borderWidth: 1, borderColor: colors.border },
  step: { flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  stepOn: { backgroundColor: colors.accent },
  stepText: { color: colors.textMuted, fontWeight: '700', fontSize: 12.5 },
  portrait: { width: '100%', backgroundColor: colors.surfaceRaised, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  frame: { width: '100%', backgroundColor: colors.surfaceRaised, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  approvedBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: colors.accent, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  filmRow: { flexDirection: 'row', alignItems: 'center', gap: space(1.5), paddingVertical: space(1), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  filmThumb: { height: 54, backgroundColor: colors.surfaceRaised, borderRadius: 6, overflow: 'hidden' },
});
