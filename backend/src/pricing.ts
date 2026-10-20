// Credit pricing. Rule: every action costs ceil(API cost in INR x markup) credits,
// and 1 credit sells for ₹1, so no purchase can lose money (see README "Pricing").
// Unit prices are fal.ai / Gemini / Anthropic list prices read in October 2026.
// Change them here when a provider changes its price; the app reads them via /v1/catalog.

export type Tier = 'budget' | 'standard' | 'premium';
export const TIERS: Tier[] = ['budget', 'standard', 'premium'];

export interface VideoModel {
  endpoint: string;
  resolution: '720p' | '1080p';
  usdPerSec: number; // with native audio
  label: string;
}

export const VIDEO_MODELS: Record<Tier, VideoModel> = {
  budget: { endpoint: 'fal-ai/veo3.1/lite/image-to-video', resolution: '720p', usdPerSec: 0.05, label: 'Veo 3.1 Lite · 720p' },
  standard: { endpoint: 'fal-ai/veo3.1/fast/image-to-video', resolution: '1080p', usdPerSec: 0.15, label: 'Veo 3.1 Fast · 1080p' },
  premium: { endpoint: 'fal-ai/veo3.1/image-to-video', resolution: '1080p', usdPerSec: 0.4, label: 'Veo 3.1 · 1080p' },
};

export const UNIT_USD = {
  llmInputPerMTok: 2, // Claude Sonnet 5.5
  llmOutputPerMTok: 10,
  image2k: 0.0504, // Nano Banana 2.1, 2K
  musicPer30s: 0.1, // Lyria 2 on fal.ai
  renderPerSec: 0.0002, // fal FFmpeg compose
};

export const MUSIC_MODEL = 'fal-ai/lyria2';
export const RENDER_MODEL = 'fal-ai/ffmpeg-api/compose';
export const VIDEO_DURATIONS = [4, 6, 8] as const;

export interface PriceConfig {
  usdInr: number;
  markup: number;
}

export function priceConfig(env: { USD_INR?: string; CREDIT_MARKUP?: string }): PriceConfig {
  const usdInr = Number(env.USD_INR || 88);
  const markup = Number(env.CREDIT_MARKUP || 3);
  if (!(usdInr > 0) || !(markup >= 1.6)) throw new Error('USD_INR must be > 0 and CREDIT_MARKUP at least 1.6 (Play Store break-even is 1.53)');
  return { usdInr, markup };
}

/** Credits for an API cost. Rounded up so we never charge below cost x markup. */
export function creditsFor(costUsd: number, cfg: PriceConfig): number {
  return Math.max(1, Math.ceil(costUsd * cfg.usdInr * cfg.markup - 1e-9));
}

export function shotsFor(targetSec: number): number {
  return Math.max(1, Math.round(targetSec / 6));
}

/** Output-token budget for a film plan; we charge for the full budget so a long answer can't lose money. */
export function planMaxTokens(targetSec: number): number {
  return Math.min(24000, 2500 + 350 * shotsFor(targetSec));
}
const PLAN_INPUT_TOKENS = 3000;

export function planCostUsd(targetSec: number): number {
  return (PLAN_INPUT_TOKENS * UNIT_USD.llmInputPerMTok + planMaxTokens(targetSec) * UNIT_USD.llmOutputPerMTok) / 1e6;
}
export function imageCostUsd(): number {
  return UNIT_USD.image2k;
}
export function videoCostUsd(tier: Tier, seconds: number): number {
  return VIDEO_MODELS[tier].usdPerSec * seconds;
}
export function musicCostUsd(): number {
  return UNIT_USD.musicPer30s; // one ~30 s track, looped under the film
}
export function renderCostUsd(seconds: number): number {
  return UNIT_USD.renderPerSec * seconds;
}

/** Render is billed per started minute so the app can show the exact price from the catalog. */
export function renderCredits(seconds: number, cfg: PriceConfig): number {
  return creditsFor(renderCostUsd(60), cfg) * Math.max(1, Math.ceil(seconds / 60));
}

export function snapDuration(sec: number): 4 | 6 | 8 {
  if (sec <= 5) return 4;
  if (sec <= 7) return 6;
  return 8;
}

/** Credit packs sold through Google Play (consumable). ₹1 per credit; the largest pack adds a 10% bonus. */
export interface CreditPack {
  productId: string;
  credits: number;
  priceInr: number;
  validDays: number;
  label: string;
}
export const CREDIT_PACKS: CreditPack[] = [
  { productId: 'maya_credits_100', credits: 100, priceInr: 99, validDays: 365, label: 'Starter' },
  { productId: 'maya_credits_500', credits: 500, priceInr: 499, validDays: 365, label: 'Creator' },
  { productId: 'maya_credits_1000', credits: 1000, priceInr: 999, validDays: 365, label: 'Pro' },
  { productId: 'maya_credits_5500', credits: 5500, priceInr: 4999, validDays: 365, label: 'Studio' },
];

/**
 * Worst-case profit check for a pack sold through Google Play:
 * price includes 18% GST, Play keeps 15% of the net, and a 10% buffer covers FX and price rises.
 */
export function packWorstCaseProfitInr(pack: CreditPack, cfg: PriceConfig): number {
  const netAfterGst = pack.priceInr / 1.18;
  const netAfterPlay = netAfterGst * 0.85;
  const maxApiCost = (pack.credits / cfg.markup) * 1.1;
  return netAfterPlay - maxApiCost;
}

export function catalog(cfg: PriceConfig) {
  const perTier = Object.fromEntries(
    TIERS.map((t) => [
      t,
      {
        label: VIDEO_MODELS[t].label,
        videoPerShot: Object.fromEntries(VIDEO_DURATIONS.map((d) => [d, creditsFor(videoCostUsd(t, d), cfg)])),
      },
    ]),
  );
  return {
    creditValueInr: 1,
    markup: cfg.markup,
    image: creditsFor(imageCostUsd(), cfg),
    music: creditsFor(musicCostUsd(), cfg),
    planPerDuration: Object.fromEntries([15, 20, 30, 60, 120, 180, 300].map((s) => [s, creditsFor(planCostUsd(s), cfg)])),
    renderPerMinute: creditsFor(renderCostUsd(60), cfg),
    tiers: perTier,
    packs: CREDIT_PACKS,
  };
}
