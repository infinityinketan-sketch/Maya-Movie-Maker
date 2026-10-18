import type { Env } from '../env';
import { planMaxTokens, shotsFor, snapDuration, UNIT_USD } from '../pricing';

export interface PlannedShot {
  duration_sec: number;
  camera: string;
  action: string;
  dialogue?: string;
  speaker?: string;
  characters?: string[];
}
export interface FilmPlan {
  title: string;
  logline: string;
  synopsis: string;
  music_prompt: string;
  characters: { name: string; description: string; voice?: string }[];
  scenes: { heading: string; summary: string; shots: PlannedShot[] }[];
}

export interface PlanInput {
  idea: string;
  genre: string | null;
  language: string;
  style: string | null;
  aspectRatio: string;
  targetSec: number;
}

const PLAN_TOOL = {
  name: 'submit_film_plan',
  description: 'Submit the complete production plan for the short film.',
  input_schema: {
    type: 'object',
    required: ['title', 'logline', 'synopsis', 'music_prompt', 'characters', 'scenes'],
    properties: {
      title: { type: 'string', description: 'Film title, at most 6 words' },
      logline: { type: 'string', description: 'One sentence' },
      synopsis: { type: 'string', description: '3-5 sentences' },
      music_prompt: { type: 'string', description: 'Instrumental score description for a music model: genre, mood, instruments, tempo. No lyrics, no artist names.' },
      characters: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string', description: 'Fixed visual description reused in every shot: age, build, face, hair, skin tone, clothing with colours. 40-70 words.' },
            voice: { type: 'string', description: 'How the voice sounds, e.g. "warm low female voice, Indian English accent"' },
          },
        },
      },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['heading', 'summary', 'shots'],
          properties: {
            heading: { type: 'string', description: 'Slug line, e.g. "EXT. MARINE DRIVE - NIGHT"' },
            summary: { type: 'string' },
            shots: {
              type: 'array',
              items: {
                type: 'object',
                required: ['duration_sec', 'camera', 'action'],
                properties: {
                  duration_sec: { type: 'integer', enum: [4, 6, 8] },
                  camera: { type: 'string', description: 'Shot size, angle and movement, e.g. "slow dolly-in, medium close-up, low angle"' },
                  action: {
                    type: 'string',
                    description: 'Self-contained visual description of the frame and motion for a video model: setting, lighting, who is in frame (by name), what happens. 40-80 words.',
                  },
                  dialogue: { type: 'string', description: 'Spoken line in the film language, short enough to say in the shot duration (about 2.5 words per second). Omit if silent.' },
                  speaker: { type: 'string', description: 'Character name speaking the dialogue' },
                  characters: { type: 'array', items: { type: 'string' }, description: 'Names of characters visible in the shot' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function planPrompt(p: PlanInput): string {
  const shots = shotsFor(p.targetSec);
  return [
    `Write a production plan for a ${p.targetSec}-second ${p.genre ? p.genre + ' ' : ''}short film.`,
    `Idea from the director: """${p.idea.slice(0, 4000)}"""`,
    `Dialogue language: ${p.language}. Visual style: ${p.style || 'cinematic, natural light, shallow depth of field'}.`,
    `Frame: ${p.aspectRatio === '9:16' ? 'vertical 9:16 for phones' : 'horizontal 16:9'}.`,
    `Use about ${shots} shots whose durations add up to roughly ${p.targetSec} seconds. Each shot is generated separately by an image-to-video model, so describe every shot completely and keep each character's look identical across shots.`,
    'Rules: original characters only — no real people, celebrities, brands or copyrighted characters; nothing sexual, hateful or graphically violent; keep it suitable for a general audience.',
  ].join('\n');
}

export async function planFilm(env: Env, input: PlanInput): Promise<{ plan: FilmPlan; costUsd: number }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: planMaxTokens(input.targetSec),
      system:
        'You are a film director and screenwriter who plans short films for AI video generation. You think in shots, keep stories simple, visual and emotionally clear, and always answer by calling the submit_film_plan tool.',
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: PLAN_TOOL.name },
      messages: [{ role: 'user', content: planPrompt(input) }],
    }),
  });
  const body = (await res.json()) as {
    content?: { type: string; input?: unknown }[];
    usage?: { input_tokens: number; output_tokens: number };
    error?: { message: string };
    stop_reason?: string;
  };
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${body.error?.message ?? 'unknown'}`);
  const tool = body.content?.find((c) => c.type === 'tool_use');
  if (!tool?.input) throw new Error(`Claude returned no plan (stop_reason ${body.stop_reason})`);
  const usage = body.usage ?? { input_tokens: 0, output_tokens: 0 };
  const costUsd = (usage.input_tokens * UNIT_USD.llmInputPerMTok + usage.output_tokens * UNIT_USD.llmOutputPerMTok) / 1e6;
  return { plan: normalizePlan(tool.input as FilmPlan), costUsd };
}

/** Defensive clean-up so a slightly-off answer still produces valid rows. */
export function normalizePlan(raw: FilmPlan): FilmPlan {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter((c) => c && str(c.name, 60))
    .slice(0, 4)
    .map((c) => ({ name: str(c.name, 60), description: str(c.description, 800), voice: str(c.voice, 200) || undefined }));
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : [])
    .map((s) => ({
      heading: str(s.heading, 120) || 'SCENE',
      summary: str(s.summary, 600),
      shots: (Array.isArray(s.shots) ? s.shots : [])
        .filter((sh) => sh && str(sh.action, 2000))
        .slice(0, 40)
        .map((sh) => ({
          duration_sec: snapDuration(Number(sh.duration_sec) || 6),
          camera: str(sh.camera, 200),
          action: str(sh.action, 2000),
          dialogue: str(sh.dialogue, 400) || undefined,
          speaker: str(sh.speaker, 60) || undefined,
          characters: Array.isArray(sh.characters) ? sh.characters.map((n) => str(n, 60)).filter(Boolean) : [],
        })),
    }))
    .filter((s) => s.shots.length > 0)
    .slice(0, 30);
  if (!scenes.length) throw new Error('plan has no shots');
  return {
    title: str(raw.title, 80) || 'Untitled film',
    logline: str(raw.logline, 300),
    synopsis: str(raw.synopsis, 2000),
    music_prompt: str(raw.music_prompt, 500) || 'cinematic orchestral score, emotional, slow build',
    characters,
    scenes,
  };
}
