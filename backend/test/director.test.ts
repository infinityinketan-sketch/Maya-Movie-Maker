import { describe, expect, it } from 'vitest';
import {
  CAMERA_LIBRARY,
  composeCamera,
  directorPrices,
  directPrompt,
  normalizeOptions,
  normalizeReview,
  reviewPrompt,
  type FilmReview,
  type ShotContext,
} from '../src/director';
import { creditsFor, priceConfig } from '../src/pricing';

const cfg = priceConfig({ USD_INR: '88', CREDIT_MARKUP: '3' });
const film: ShotContext['film'] = { title: 'Chai at Dawn', genre: 'Drama', style: null, language: 'Hindi', aspectRatio: '9:16', logline: 'A tea seller sees tomorrow.' };

describe('camera library', () => {
  it('has unique ids and complete entries in every group', () => {
    for (const g of CAMERA_LIBRARY) {
      const ids = g.options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of g.options) for (const f of [o.label, o.prompt, o.says, o.useFor]) expect(f.length).toBeGreaterThan(2);
    }
    expect(CAMERA_LIBRARY.map((g) => g.id)).toEqual(['size', 'angle', 'movement', 'lens', 'light']);
  });

  it('composes the camera line in size, angle, move, lens, light order', () => {
    expect(composeCamera({ light: 'golden', size: 'cu', movement: 'pushin', angle: 'low' })).toBe(
      'close-up on the face, low angle looking up, slow dolly push-in, warm golden-hour sunlight, long soft shadows',
    );
    expect(composeCamera({ size: 'nope' })).toBe('');
  });
});

describe('AI Director', () => {
  it('gives the model the shots before and after', () => {
    const p = directPrompt({
      film,
      scene: { heading: 'EXT. TEA STALL - DAWN', summary: null },
      characters: [{ name: 'Raju', description: 'tea seller, 40' }],
      previous: { camera: 'wide shot', action: 'The stall opens' },
      next: null,
      shot: { idx: 1, durationSec: 6, camera: null, action: 'Raju pours tea', dialogue: 'Garam chai!', speaker: 'Raju' },
    });
    expect(p).toContain('Shot before: [wide shot] The stall opens');
    expect(p).toContain('This is the last shot');
    expect(p).toContain('Raju: "Garam chai!"');
    expect(p).toContain('vertical 9:16');
  });

  it('keeps at most three usable options', () => {
    const opts = normalizeOptions([
      { title: 'A', camera: 'close-up', action: 'Raju smiles at the kettle', why: 'warm' },
      { title: 'B', camera: '', action: 'missing camera', why: '' },
      { title: 'C', camera: 'wide', action: 'The street wakes', why: 'space' },
      { title: 'D', camera: 'top', action: 'Cups from above', why: 'pattern' },
      { title: 'E', camera: 'low', action: 'Raju towers', why: 'power' },
    ]);
    expect(opts.map((o) => o.title)).toEqual(['A', 'C', 'D']);
    expect(() => normalizeOptions([])).toThrow();
  });

  it('drops review notes that point at shots that do not exist', () => {
    const review = normalizeReview(
      {
        summary: 'Good.',
        strengths: ['Clear story'],
        notes: [
          { shot: 1, issue: 'No establishing shot', suggestion: 'Start wide', camera: 'wide shot' },
          { shot: 9, issue: 'x', suggestion: 'y' },
          { shot: 0, issue: 'x', suggestion: 'y' },
          { shot: 2, issue: '', suggestion: 'y' },
        ],
      } as FilmReview,
      3,
    );
    expect(review.notes).toHaveLength(1);
    expect(review.notes[0].camera).toBe('wide shot');
  });

  it('lists every shot in the review prompt', () => {
    const p = reviewPrompt(film, [
      { heading: 'INT. HOME', shots: [{ idx: 0, durationSec: 4, camera: null, action: 'A door opens', dialogue: null, speaker: null }] },
    ]);
    expect(p).toContain('#1 (4s) [no camera notes] A door opens');
  });

  it('prices Director calls in credits that grow with the film', () => {
    const prices = directorPrices((usd) => creditsFor(usd, cfg));
    expect(prices.direct).toBeGreaterThan(0);
    expect(prices.direct).toBeLessThan(15);
    expect(prices.reviewByShots[40]).toBeGreaterThanOrEqual(prices.reviewByShots[1]);
  });
});
