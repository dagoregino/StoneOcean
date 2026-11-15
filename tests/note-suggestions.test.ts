import { describe, expect, it } from 'vitest';
import { HealthStore } from '../src/data/HealthStore';
import { INDICATORS } from '../src/domain/catalog/indicators';
import { NOTE_KEYWORD_RULES, suggestSelfChecksFromNotes, tokenizeNotes } from '../src/domain/noteSuggestions';
import { createSymptomReport } from '../src/domain/symptoms';

const ids = (text: string) => suggestSelfChecksFromNotes(text).map((s) => s.indicatorId);

describe('self-check suggestions from notes', () => {
  it('normalizes case, accents and apostrophes', () => {
    expect(tokenizeNotes("I can't see — VISIÓN borrosa")).toEqual(['i', 'cant', 'see', 'vision', 'borrosa']);
  });

  it('suggests the dizziness score for dizziness words, in English and Spanish', () => {
    expect(ids('I feel dizzy after the treadmill')).toEqual(['dizziness']);
    expect(ids('Some nausea and the room keeps spinning')).toEqual(['dizziness']);
    expect(ids('Tengo mareo desde la mañana')).toEqual(['dizziness']);
  });

  it('suggests the vision check for vision problems', () => {
    expect(ids('Near vision is blurry when reading')).toEqual(['visionChange']);
    expect(ids('I cannot see the checklist clearly')).toEqual(['visionChange']);
    expect(ids('Veo borroso de cerca')).toEqual(['visionChange']);
  });

  it('lists every term that matched, in reading order, once', () => {
    expect(suggestSelfChecksFromNotes('Blurry vision, blurry again')).toEqual([{ indicatorId: 'visionChange', matches: ['blurry', 'vision'] }]);
    expect(ids('Dizzy, and my vision is blurred')).toEqual(['dizziness', 'visionChange']);
  });

  it('ignores negated mentions, but a negation does not reach past "but"', () => {
    expect(ids('No dizziness today')).toEqual([]);
    expect(ids('Not feeling dizzy anymore')).toEqual([]);
    expect(ids('Sin mareo')).toEqual([]);
    expect(ids('No headache but dizzy')).toEqual(['dizziness']);
  });

  it('matches whole words only and offers nothing for unrelated notes', () => {
    expect(ids('Watched television, felt fine')).toEqual([]);
    expect(ids('Sore lower back after lifting')).toEqual([]);
    expect(ids('')).toEqual([]);
  });

  it('only ever points at self-check indicators', () => {
    for (const rule of NOTE_KEYWORD_RULES) expect(INDICATORS[rule.indicatorId].acquisition).toBe('self-check');
  });
});

describe('confirmed self-checks on a report', () => {
  const base = { systemId: 'muscular' as const, position: { x: 0, y: 1, z: 0 }, intensity: 4, type: 'other' as const };

  it('adds only what was confirmed, once, and only self-checks', () => {
    expect(createSymptomReport(1, 0, { ...base, notes: 'dizzy' }).relatedSelfChecks).toEqual([]);
    expect(createSymptomReport(1, 0, { ...base, confirmedSelfChecks: ['dizziness'] }).relatedSelfChecks).toEqual(['dizziness']);
    expect(createSymptomReport(1, 0, { ...base, type: 'dizziness', confirmedSelfChecks: ['dizziness', 'visionChange'] }).relatedSelfChecks).toEqual(['dizziness', 'visionChange']);
    // heartRate is a sensor, not a self-check: never added.
    expect(createSymptomReport(1, 0, { ...base, confirmedSelfChecks: ['heartRate'] }).relatedSelfChecks).toEqual([]);
  });

  it('does not change the symptom type, a status or the triage', () => {
    const store = new HealthStore('iss');
    store.ingest([{ indicatorId: 'dizziness', value: 1, t: 10, source: 'manual' }], 10);
    const before = JSON.stringify(store.evaluation);
    const report = store.reportSymptom({ ...base, notes: 'Very dizzy and blurry vision', confirmedSelfChecks: ['dizziness', 'visionChange'] });
    expect(report.type).toBe('other');
    expect(report.notes).toBe('Very dizzy and blurry vision');
    expect(JSON.stringify(store.evaluation)).toBe(before);
  });
});
