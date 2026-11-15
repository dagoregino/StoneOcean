import { describe, expect, it } from 'vitest';
import { STEP_MS } from '../src/tutorial/TutorialController';
import { FINAL_STEP, TUTORIAL_STEPS } from '../src/tutorial/steps';
import { placeCard, type RectLike } from '../src/tutorial/TutorialSpotlight';
import { rememberTutorial, shouldOfferTutorial, TUTORIAL_KEY } from '../src/tutorial/TutorialPrompt';

const rect = (left: number, top: number, width: number, height: number): RectLike => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 1440, height: 900 };
const card = { width: 320, height: 180 };

describe('interface tour: content', () => {
  it('is six steps of about 4.5 s: roughly a 30-second tour', () => {
    expect(TUTORIAL_STEPS).toHaveLength(6);
    const seconds = (TUTORIAL_STEPS.length * STEP_MS) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(24);
    expect(seconds).toBeLessThanOrEqual(32);
  });

  it('walks through the interface in the agreed order', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['twin', 'anatomy', 'systems', 'report', 'trends', 'resources']);
  });

  it('keeps every message short', () => {
    for (const step of [...TUTORIAL_STEPS, FINAL_STEP]) {
      expect(step.title.length, step.title).toBeLessThanOrEqual(40);
      expect(step.description.split(/\s+/).length, step.description).toBeLessThanOrEqual(22);
    }
  });

  it('mentions Play the Mission at the end without being it', () => {
    expect(FINAL_STEP.description).toMatch(/Play the Mission/);
    const sources = import.meta.glob<string>('../src/tutorial/*.ts', { query: '?raw', import: 'default', eager: true });
    for (const [file, source] of Object.entries(sources)) {
      // A layer over the page: no store, no scenario, no mission tour.
      expect(source, file).not.toMatch(/MissionTour|HealthStore|SimulatedSource|setScenario|playMission/);
    }
  });
});

describe('interface tour: placing the card', () => {
  it('uses the preferred side when there is room, and points the arrow at the target', () => {
    const target = rect(600, 100, 100, 40);
    const spot = placeCard(target, card, viewport, 'bottom');
    expect(spot.side).toBe('bottom');
    expect(spot.y).toBe(target.bottom + 16);
    expect(spot.x + spot.arrow).toBeCloseTo(650, 0);
  });

  it('falls back to a side that fits, and stays inside the window', () => {
    const nearBottom = rect(600, 820, 100, 40);
    const spot = placeCard(nearBottom, card, viewport, 'bottom');
    expect(spot.side).not.toBe('bottom');
    expect(spot.x).toBeGreaterThanOrEqual(10);
    expect(spot.x + card.width).toBeLessThanOrEqual(viewport.width - 10);
    expect(spot.y + card.height).toBeLessThanOrEqual(viewport.height - 10);
  });

  it('goes to the corner, without an arrow, when there is no target', () => {
    const spot = placeCard(null, card, viewport, 'auto');
    expect(spot.arrow).toBe(-1);
    expect(spot.x).toBe(viewport.width - card.width - 20);
  });
});

describe('interface tour: first visit', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), values };
  };

  it('is offered until the tour is taken or dismissed for good', () => {
    const storage = memory();
    expect(shouldOfferTutorial(storage)).toBe(true);
    rememberTutorial('dismissed', storage);
    expect(storage.values.get(TUTORIAL_KEY)).toBe('dismissed');
    expect(shouldOfferTutorial(storage)).toBe(false);
  });

  it('is not offered again once taken', () => {
    const storage = memory();
    rememberTutorial('done', storage);
    expect(shouldOfferTutorial(storage)).toBe(false);
  });
});
