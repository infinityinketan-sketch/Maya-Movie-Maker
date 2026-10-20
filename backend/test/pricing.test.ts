import { describe, expect, it } from 'vitest';
import {
  catalog,
  CREDIT_PACKS,
  creditsFor,
  imageCostUsd,
  packWorstCaseProfitInr,
  planCostUsd,
  planMaxTokens,
  priceConfig,
  snapDuration,
  TIERS,
  videoCostUsd,
} from '../src/pricing';

const cfg = priceConfig({ USD_INR: '88', CREDIT_MARKUP: '3' });

describe('credit pricing', () => {
  it('charges ceil(cost in INR x 3)', () => {
    expect(creditsFor(0.0504, cfg)).toBe(14); // 2K storyboard frame: ₹4.44 x 3 = 13.3 -> 14
    expect(creditsFor(videoCostUsd('standard', 8), cfg)).toBe(317); // 8 s Veo Fast: $1.20 -> ₹105.6 x 3
    expect(creditsFor(videoCostUsd('budget', 4), cfg)).toBe(53);
    expect(creditsFor(0.000001, cfg)).toBe(1);
  });

  it('never prices an action below its API cost x markup', () => {
    for (const usd of [0.0002, 0.01, 0.0504, 0.1, 0.3, 1.2, 3.2, 12.7]) {
      const credits = creditsFor(usd, cfg);
      expect(credits).toBeGreaterThanOrEqual(usd * cfg.usdInr * cfg.markup);
    }
  });

  it('every credit pack is profitable even when all credits are spent through Google Play', () => {
    for (const pack of CREDIT_PACKS) {
      expect(packWorstCaseProfitInr(pack, cfg)).toBeGreaterThan(0);
      expect(pack.priceInr / pack.credits).toBeGreaterThanOrEqual(0.9); // at most a 10% bonus
    }
  });

  it('refuses a markup that would lose money on Play', () => {
    expect(() => priceConfig({ USD_INR: '88', CREDIT_MARKUP: '1.4' })).toThrow();
  });

  it('plan pricing covers the full output-token budget', () => {
    expect(planCostUsd(30)).toBeGreaterThan(0);
    expect(planCostUsd(300)).toBeGreaterThan(planCostUsd(30));
    expect(creditsFor(planCostUsd(60), cfg)).toBeLessThan(40);
    // a 5-minute film (~50 shots) gets enough output tokens for every shot
    expect(planMaxTokens(300)).toBeGreaterThanOrEqual(2500 + 350 * 50);
  });

  it('catalog lists every tier and duration', () => {
    const cat = catalog(cfg);
    for (const t of TIERS) expect(Object.keys(cat.tiers[t].videoPerShot)).toEqual(['4', '6', '8']);
    expect(cat.image).toBe(creditsFor(imageCostUsd(), cfg));
    expect(cat.packs.length).toBeGreaterThan(0);
  });

  it('snaps shot lengths to what Veo supports', () => {
    expect([1, 4, 5, 6, 7, 8, 12].map(snapDuration)).toEqual([4, 4, 4, 6, 6, 8, 8]);
  });
});

describe('render pricing', () => {
  it('bills per started minute and matches the catalog price', async () => {
    const { renderCredits } = await import('../src/pricing');
    const perMinute = catalog(cfg).renderPerMinute;
    expect(renderCredits(30, cfg)).toBe(perMinute);
    expect(renderCredits(60, cfg)).toBe(perMinute);
    expect(renderCredits(61, cfg)).toBe(perMinute * 2);
  });
});

describe('video models', () => {
  it('HD Value (LTX-2) bills its shortest clip that covers the shot and is cheaper than Standard', async () => {
    const { billedSeconds, VIDEO_MODELS } = await import('../src/pricing');
    expect(billedSeconds('value', 4)).toBe(6);
    expect(billedSeconds('value', 8)).toBe(8);
    expect(billedSeconds('standard', 4)).toBe(4);
    for (const d of [4, 6, 8]) expect(videoCostUsd('value', d)).toBeLessThan(videoCostUsd('standard', d));
    expect(VIDEO_MODELS.value.input({ prompt: 'p', imageUrl: 'u', seconds: 6, aspectRatio: '9:16' })).toEqual({
      prompt: 'p',
      image_url: 'u',
      duration: 6,
      resolution: '1080p',
      fps: 25,
      generate_audio: true,
    });
    expect(VIDEO_MODELS.standard.input({ prompt: 'p', imageUrl: 'u', seconds: 8, aspectRatio: '16:9' })).toMatchObject({ duration: '8s', aspect_ratio: '16:9' });
  });
});
