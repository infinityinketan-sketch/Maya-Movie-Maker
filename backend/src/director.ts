// Director tools for paying users: a camera library (free to browse) and an AI Director
// that suggests framing for one shot or reviews the whole shot list (charged in credits).
import type { Env } from './env';
import { callClaudeTool, DIRECTOR_RULES } from './providers/anthropic';
import { UNIT_USD } from './pricing';

// ---------------------------------------------------------------- camera library

export interface CameraOption {
  id: string;
  label: string;
  prompt: string; // phrase sent to the video model
  says: string; // what it communicates
  useFor: string;
}
export interface CameraGroup {
  id: 'size' | 'angle' | 'movement' | 'lens' | 'light';
  title: string;
  options: CameraOption[];
}

export const CAMERA_LIBRARY: CameraGroup[] = [
  {
    id: 'size',
    title: 'Shot size',
    options: [
      { id: 'ews', label: 'Extreme wide', prompt: 'extreme wide shot', says: 'Scale, isolation, a world bigger than the people in it.', useFor: 'Openings, landscapes, endings.' },
      { id: 'ws', label: 'Wide', prompt: 'wide shot', says: 'Where we are and who is there.', useFor: 'Establishing a scene, group action.' },
      { id: 'fs', label: 'Full', prompt: 'full shot, head to toe', says: 'Body language and movement.', useFor: 'Walking, dancing, fights.' },
      { id: 'ms', label: 'Medium', prompt: 'medium shot, waist up', says: 'Neutral, conversational.', useFor: 'Dialogue, everyday action.' },
      { id: 'mcu', label: 'Medium close-up', prompt: 'medium close-up, chest up', says: 'Personal, attentive.', useFor: 'Important lines, reactions.' },
      { id: 'cu', label: 'Close-up', prompt: 'close-up on the face', says: 'Emotion and inner thought.', useFor: 'Decisions, tears, realisations.' },
      { id: 'ecu', label: 'Extreme close-up', prompt: 'extreme close-up', says: 'Intensity, obsession, a detail that matters.', useFor: 'Eyes, a ring, a ticking clock.' },
      { id: 'ots', label: 'Over the shoulder', prompt: 'over-the-shoulder shot', says: 'Connection between two people.', useFor: 'Conversations, confrontations.' },
      { id: 'pov', label: 'Point of view', prompt: 'first-person point-of-view shot', says: 'We see through their eyes.', useFor: 'Discovery, suspense.' },
      { id: 'insert', label: 'Insert', prompt: 'insert shot of a hand-held object in detail', says: 'A clue or detail the story turns on.', useFor: 'Phones, letters, products.' },
      { id: 'two', label: 'Two-shot', prompt: 'two-shot with both characters in frame', says: 'Relationship and distance between two people.', useFor: 'Couples, partners, rivals.' },
    ],
  },
  {
    id: 'angle',
    title: 'Angle',
    options: [
      { id: 'eye', label: 'Eye level', prompt: 'eye-level angle', says: 'Honest, equal, neutral.', useFor: 'Most dialogue.' },
      { id: 'low', label: 'Low angle', prompt: 'low angle looking up', says: 'Power, heroism or menace.', useFor: 'Heroes, villains, big moments.' },
      { id: 'high', label: 'High angle', prompt: 'high angle looking down', says: 'Weakness, loneliness, being watched.', useFor: 'Defeat, vulnerability.' },
      { id: 'top', label: 'Overhead', prompt: "bird's-eye overhead view", says: 'Fate, pattern, the bigger picture.', useFor: 'Maps, crowds, food, transitions.' },
      { id: 'dutch', label: 'Dutch tilt', prompt: 'Dutch tilted angle', says: 'Unease, madness, something is wrong.', useFor: 'Thrillers, dreams, shock.' },
      { id: 'worm', label: "Worm's-eye", prompt: "worm's-eye view from the ground", says: 'Towering, overwhelming.', useFor: 'Buildings, giants, reveals.' },
    ],
  },
  {
    id: 'movement',
    title: 'Camera move',
    options: [
      { id: 'static', label: 'Static', prompt: 'locked-off static camera', says: 'Calm, observation, let the acting speak.', useFor: 'Strong performances, tension.' },
      { id: 'pushin', label: 'Slow push-in', prompt: 'slow dolly push-in', says: 'Growing importance or realisation.', useFor: 'Key lines, decisions.' },
      { id: 'pullout', label: 'Pull-out', prompt: 'slow dolly pull-back revealing the surroundings', says: 'Reveal, isolation, ending.', useFor: 'Endings, reveals.' },
      { id: 'track', label: 'Tracking', prompt: 'tracking shot following the subject', says: 'Energy, journey, momentum.', useFor: 'Walking, chases.' },
      { id: 'pan', label: 'Pan', prompt: 'smooth horizontal pan', says: 'Connects two things in one space.', useFor: 'Landscapes, following a look.' },
      { id: 'tilt', label: 'Tilt up', prompt: 'slow tilt up', says: 'Awe, scale, revealing height.', useFor: 'Buildings, temples, a person standing.' },
      { id: 'crane', label: 'Crane up', prompt: 'crane shot rising up and away', says: 'Release, grandeur, the end of a chapter.', useFor: 'Finales, celebrations.' },
      { id: 'orbit', label: 'Orbit', prompt: '180-degree orbit around the subject', says: 'Heroic moment, a world turning around someone.', useFor: 'Hero shots, product hero.' },
      { id: 'handheld', label: 'Handheld', prompt: 'handheld camera with natural shake', says: 'Raw, urgent, documentary truth.', useFor: 'Action, chaos, realism.' },
      { id: 'drone', label: 'Drone', prompt: 'aerial drone shot gliding forward', says: 'Freedom, geography, scale.', useFor: 'Cities, travel, openings.' },
      { id: 'zoom', label: 'Crash zoom', prompt: 'fast crash zoom in', says: 'Comedy beat or sudden shock.', useFor: 'Punchlines, reveals.' },
    ],
  },
  {
    id: 'lens',
    title: 'Lens',
    options: [
      { id: '24', label: '24mm wide', prompt: '24mm wide-angle lens', says: 'Space and energy; faces close up look distorted.', useFor: 'Interiors, action.' },
      { id: '35', label: '35mm', prompt: '35mm lens', says: 'Natural storytelling view.', useFor: 'Most scenes.' },
      { id: '50', label: '50mm', prompt: '50mm lens', says: 'Close to the human eye.', useFor: 'Dialogue, portraits in context.' },
      { id: '85', label: '85mm portrait', prompt: '85mm portrait lens, shallow depth of field, creamy background blur', says: 'Intimate faces, background melts away.', useFor: 'Close-ups, romance.' },
      { id: 'tele', label: 'Telephoto', prompt: '200mm telephoto lens, compressed background', says: 'Watching from afar, compressed crowds.', useFor: 'Surveillance, sports, heat haze.' },
      { id: 'macro', label: 'Macro', prompt: 'macro lens extreme detail', says: 'A tiny world made huge.', useFor: 'Food, jewellery, insects, products.' },
    ],
  },
  {
    id: 'light',
    title: 'Light',
    options: [
      { id: 'golden', label: 'Golden hour', prompt: 'warm golden-hour sunlight, long soft shadows', says: 'Warmth, hope, nostalgia.', useFor: 'Romance, endings, festivals.' },
      { id: 'blue', label: 'Blue hour', prompt: 'cool blue-hour twilight', says: 'Melancholy, quiet, in-between.', useFor: 'Goodbyes, reflection.' },
      { id: 'window', label: 'Window light', prompt: 'soft natural window light from the side', says: 'Intimate, honest, homely.', useFor: 'Homes, interviews.' },
      { id: 'noir', label: 'Low-key noir', prompt: 'low-key lighting, deep shadows, single hard light', says: 'Mystery, danger, secrets.', useFor: 'Thrillers, villains.' },
      { id: 'high', label: 'High-key bright', prompt: 'bright high-key lighting, few shadows', says: 'Happy, clean, commercial.', useFor: 'Comedy, ads, kids.' },
      { id: 'neon', label: 'Neon night', prompt: 'neon city night lighting, pink and teal reflections on wet streets', says: 'Night energy, modern city.', useFor: 'Music videos, nightlife.' },
      { id: 'diya', label: 'Diya / candle', prompt: 'warm flickering diya and candle light', says: 'Devotion, festivals, intimacy.', useFor: 'Diwali, puja, weddings.' },
      { id: 'backlit', label: 'Backlit rim', prompt: 'strong backlight with glowing rim light around the subject', says: 'Heroic, magical, spiritual.', useFor: 'Hero entries, reveals.' },
    ],
  },
];

/** Builds the camera field from picked library options, in a fixed order. */
export function composeCamera(picks: Partial<Record<CameraGroup['id'], string>>): string {
  const parts: string[] = [];
  for (const g of CAMERA_LIBRARY) {
    const id = picks[g.id];
    const opt = id ? g.options.find((o) => o.id === id) : undefined;
    if (opt) parts.push(opt.prompt);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------- AI Director

export interface ShotContext {
  film: { title: string; genre: string | null; style: string | null; language: string; aspectRatio: string; logline: string | null };
  scene: { heading: string; summary: string | null };
  characters: { name: string; description: string }[];
  previous?: { camera: string | null; action: string } | null;
  next?: { camera: string | null; action: string } | null;
  shot: { idx: number; durationSec: number; camera: string | null; action: string; dialogue: string | null; speaker: string | null };
}

export interface DirectorOption {
  title: string;
  camera: string;
  action: string;
  why: string;
}

const DIRECT_TOOL = {
  name: 'suggest_framings',
  description: 'Give three different ways to shoot this one shot.',
  input_schema: {
    type: 'object',
    required: ['options'],
    properties: {
      options: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          required: ['title', 'camera', 'action', 'why'],
          properties: {
            title: { type: 'string', description: '2-4 word name, e.g. "Intimate push-in"' },
            camera: { type: 'string', description: 'Shot size, angle, ONE movement, lens and light in one line' },
            action: { type: 'string', description: 'Rewritten frame description for the video model, 40-80 words, same story beat and characters, describing the opening frame and the single motion' },
            why: { type: 'string', description: 'One sentence a beginner understands: what this framing makes the audience feel' },
          },
        },
      },
    },
  },
} as const;

export const DIRECT_MAX_TOKENS = 1800;
const DIRECT_INPUT_TOKENS = 3500;
export function directCostUsd(): number {
  return (DIRECT_INPUT_TOKENS * UNIT_USD.llmInputPerMTok + DIRECT_MAX_TOKENS * UNIT_USD.llmOutputPerMTok) / 1e6;
}

export function directPrompt(c: ShotContext): string {
  const lines = [
    `Film: "${c.film.title}"${c.film.genre ? ` (${c.film.genre})` : ''}. Look: ${c.film.style || 'cinematic'}. Frame: ${c.film.aspectRatio === '9:16' ? 'vertical 9:16' : 'wide 16:9'}.`,
    c.film.logline ? `Logline: ${c.film.logline}` : '',
    `Scene: ${c.scene.heading}${c.scene.summary ? ` — ${c.scene.summary}` : ''}`,
    c.characters.length ? `Characters: ${c.characters.map((ch) => `${ch.name} (${ch.description})`).join('; ')}` : '',
    c.previous ? `Shot before: [${c.previous.camera || 'no camera notes'}] ${c.previous.action}` : 'This is the first shot of the film.',
    `THIS SHOT (#${c.shot.idx + 1}, ${c.shot.durationSec}s): [${c.shot.camera || 'no camera notes'}] ${c.shot.action}`,
    c.shot.dialogue ? `Dialogue (${c.film.language}): ${c.shot.speaker || 'someone'}: "${c.shot.dialogue}"` : 'No dialogue.',
    c.next ? `Shot after: [${c.next.camera || 'no camera notes'}] ${c.next.action}` : 'This is the last shot of the film.',
    'Give three clearly different framings (for example one intimate, one dramatic, one bold). Each must cut well with the shots before and after. Keep the same story beat, characters and dialogue.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function directShot(env: Env, c: ShotContext): Promise<{ options: DirectorOption[]; costUsd: number }> {
  const { input, costUsd } = await callClaudeTool<{ options: DirectorOption[] }>(env, {
    system: `You are an experienced film director and cinematographer coaching a beginner. You answer by calling suggest_framings.\n\n${DIRECTOR_RULES}`,
    prompt: directPrompt(c),
    tool: DIRECT_TOOL,
    maxTokens: DIRECT_MAX_TOKENS,
  });
  return { options: normalizeOptions(input.options), costUsd };
}

export function normalizeOptions(raw: unknown): DirectorOption[] {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = (Array.isArray(raw) ? raw : [])
    .map((o) => ({ title: str(o?.title, 60), camera: str(o?.camera, 200), action: str(o?.action, 2000), why: str(o?.why, 300) }))
    .filter((o) => o.camera && o.action.length >= 5)
    .slice(0, 3);
  if (!out.length) throw new Error('The Director had no suggestions. Please try again.');
  return out;
}

// ---------------------------------------------------------------- Director's review of the whole film

export interface ReviewNote {
  shot: number; // 1-based shot number
  issue: string;
  suggestion: string;
  camera?: string;
  action?: string;
}
export interface FilmReview {
  summary: string;
  strengths: string[];
  notes: ReviewNote[];
}

const REVIEW_TOOL = {
  name: 'submit_review',
  description: "Submit the director's review of the shot list.",
  input_schema: {
    type: 'object',
    required: ['summary', 'strengths', 'notes'],
    properties: {
      summary: { type: 'string', description: 'Two sentences: overall verdict on coverage, pacing and visual storytelling' },
      strengths: { type: 'array', maxItems: 3, items: { type: 'string' } },
      notes: {
        type: 'array',
        maxItems: 10,
        description: 'Most important fixes first. Only real problems; an empty list is fine for a strong shot list.',
        items: {
          type: 'object',
          required: ['shot', 'issue', 'suggestion'],
          properties: {
            shot: { type: 'integer', description: 'Shot number (1-based)' },
            issue: { type: 'string', description: 'What is wrong, in plain words' },
            suggestion: { type: 'string', description: 'What to do instead, in plain words' },
            camera: { type: 'string', description: 'New camera line for this shot, if the fix changes the framing' },
            action: { type: 'string', description: 'New frame description (40-80 words), only if the fix needs it' },
          },
        },
      },
    },
  },
} as const;

export function reviewMaxTokens(shots: number): number {
  return Math.min(6000, 1200 + 350 * shots);
}
export function reviewCostUsd(shots: number): number {
  const input = 2500 + 300 * shots;
  return (input * UNIT_USD.llmInputPerMTok + reviewMaxTokens(shots) * UNIT_USD.llmOutputPerMTok) / 1e6;
}

export function reviewPrompt(film: ShotContext['film'], scenes: { heading: string; shots: ShotContext['shot'][] }[]): string {
  const out = [
    `Film: "${film.title}"${film.genre ? ` (${film.genre})` : ''}. Look: ${film.style || 'cinematic'}. Frame: ${film.aspectRatio === '9:16' ? 'vertical 9:16' : 'wide 16:9'}. Dialogue language: ${film.language}.`,
    film.logline ? `Logline: ${film.logline}` : '',
    'Shot list:',
  ];
  for (const sc of scenes) {
    out.push(`\n${sc.heading}`);
    for (const s of sc.shots) {
      out.push(`#${s.idx + 1} (${s.durationSec}s) [${s.camera || 'no camera notes'}] ${s.action}${s.dialogue ? ` — ${s.speaker || 'someone'}: "${s.dialogue}"` : ''}`);
    }
  }
  out.push(
    '\nReview it like a director before the shoot: establishing shots, variety of shot sizes, angles that match the emotion, screen direction, dialogue coverage, pacing, a strong opening frame and a memorable last shot, and anything an AI video model will struggle with (several movements in one shot, crowds of moving people, readable text, a face that disappears and comes back within a shot). Check every dialogue shot strictly: it must show ONLY its speaker facing the camera, never a second character and never a line spoken "to someone off camera"; flag any talking shot that breaks this and split it into a speaker shot and a silent reaction shot. When consecutive shots show the same person talking in the same place, their camera and frame wording must be identical apart from the line; flag any drift. Flag any description of something unwanted (\"not deep\", \"no beard\"), since the model tends to produce it; rewrite it as what is wanted. Give concrete fixes.',
  );
  return out.filter(Boolean).join('\n');
}

export async function reviewFilm(
  env: Env,
  film: ShotContext['film'],
  scenes: { heading: string; shots: ShotContext['shot'][] }[],
): Promise<{ review: FilmReview; costUsd: number }> {
  const total = scenes.reduce((n, s) => n + s.shots.length, 0);
  const { input, costUsd } = await callClaudeTool<FilmReview>(env, {
    system: `You are a respected film director reviewing a beginner's shot list. Be warm but specific. Answer by calling submit_review.\n\n${DIRECTOR_RULES}`,
    prompt: reviewPrompt(film, scenes),
    tool: REVIEW_TOOL,
    maxTokens: reviewMaxTokens(total),
  });
  return { review: normalizeReview(input, total), costUsd };
}

export function normalizeReview(raw: FilmReview, totalShots: number): FilmReview {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    summary: str(raw?.summary, 600) || 'The Director reviewed your shot list.',
    strengths: (Array.isArray(raw?.strengths) ? raw.strengths : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 3),
    notes: (Array.isArray(raw?.notes) ? raw.notes : [])
      .map((n) => ({
        shot: Math.round(Number(n?.shot)),
        issue: str(n?.issue, 300),
        suggestion: str(n?.suggestion, 400),
        camera: str(n?.camera, 200) || undefined,
        action: str(n?.action, 2000) || undefined,
      }))
      .filter((n) => Number.isInteger(n.shot) && n.shot >= 1 && n.shot <= totalShots && n.issue && n.suggestion)
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------- prices shown in the app

export function directorPrices(creditsFor: (usd: number) => number) {
  const reviewByShots: Record<number, number> = {};
  for (let n = 1; n <= 40; n++) reviewByShots[n] = creditsFor(reviewCostUsd(n));
  return { direct: creditsFor(directCostUsd()), reviewByShots };
}
