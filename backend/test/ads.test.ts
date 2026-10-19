import { describe, expect, it } from 'vitest';
import { adIdea, adPlanPrompt, posterPrompt, scriptFor, waLink, waMessage, type AdBrief } from '../src/ads';
import { planPrompt } from '../src/providers/anthropic';

const brief: AdBrief = {
  businessName: 'Sunil Sweets',
  businessType: 'Sweet shop',
  area: 'Pimple Saudagar',
  offer: '20% off on Diwali gift boxes',
  occasion: 'Diwali',
  language: 'Marathi',
  contactLine: '98xxxxxx00 · Kunal Icon Road',
  photoUrl: 'https://media.example.com/u/1/uploads/photo/a.jpg',
};

describe('shop ads', () => {
  it('plans a hook, show and offer structure in the right language', () => {
    const p = adPlanPrompt(brief, 20, 3);
    expect(p).toContain('20-second vertical');
    expect(p).toContain('Sunil Sweets — Sweet shop, Pimple Saudagar');
    expect(p).toContain('Dialogue language: Marathi');
    expect(p).toContain('1. HOOK');
    expect(p).toContain('3. OFFER + INVITE');
    expect(p).toContain('No on-screen text');
    expect(p).toContain('reference photo');
  });

  it('the story planner switches to the ad brief for ad projects', () => {
    const p = planPrompt({ ad: brief, idea: adIdea(brief), genre: null, language: 'Marathi', style: null, aspectRatio: '9:16', targetSec: 20 });
    expect(p).toContain('Offer to sell: 20% off on Diwali gift boxes');
    expect(p).not.toContain('Idea from the director');
  });

  it('writes poster text in the customer script', () => {
    expect(scriptFor('Marathi')).toBe('Devanagari script');
    expect(scriptFor('English')).toBe('Latin script');
    const p = posterPrompt(brief);
    expect(p).toContain('Shop name (top, biggest): Sunil Sweets');
    expect(p).toContain('Contact (bottom): 98xxxxxx00');
    expect(p).toContain('Devanagari');
  });

  it('builds a WhatsApp link with the Indian country code', () => {
    const msg = waMessage({ customerName: 'Sunil', businessName: 'Sunil Sweets', videoUrl: 'https://v', posterUrl: null, priceInr: 499, paid: false });
    expect(msg).toContain('Reel: https://v');
    expect(msg).toContain('₹499');
    expect(waLink('98765 43210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
    expect(waLink('+91 98765 43210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
    expect(waLink('09876543210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
    expect(waMessage({ customerName: 'S', businessName: 'B', videoUrl: null, posterUrl: null, priceInr: 499, paid: true })).not.toContain('₹');
  });
});
