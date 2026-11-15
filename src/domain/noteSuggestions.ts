import { INDICATORS } from './catalog/indicators';
import type { IndicatorId } from './types';

/**
 * Self-checks worth suggesting from the free-text notes of a discomfort report, typed or
 * dictated.
 *
 * This is a keyword match, not an interpretation. A match never sets a symptom type, a
 * status or a finding: it only offers a self-check, and the crew member has to tick it
 * before it is attached to the report. The crew member then measures and logs it.
 * Nothing here knows how the text was produced, so it works the same with any speech engine
 * or with the keyboard.
 */

export interface NoteKeywordRule {
  indicatorId: IndicatorId;
  /** Words or short phrases, lower case and without accents. English and Spanish. */
  terms: readonly string[];
}

export const NOTE_KEYWORD_RULES: readonly NoteKeywordRule[] = [
  {
    indicatorId: 'dizziness',
    terms: [
      'dizzy',
      'dizziness',
      'lightheaded',
      'light headed',
      'vertigo',
      'spinning',
      'disoriented',
      'disorientation',
      'nausea',
      'nauseous',
      'nauseated',
      'motion sick',
      'motion sickness',
      'space sick',
      'space sickness',
      'off balance',
      'unsteady',
      'woozy',
      'mareo',
      'mareos',
      'mareado',
      'mareada',
      'nauseas',
      'desorientado',
      'desorientada',
    ],
  },
  {
    indicatorId: 'visionChange',
    terms: [
      'vision',
      'visual',
      'eyesight',
      'blur',
      'blurry',
      'blurred',
      'blurring',
      'double vision',
      'seeing double',
      'seeing spots',
      'floaters',
      'cant see',
      'cannot see',
      'can not see',
      'trouble seeing',
      'hard to see',
      'borrosa',
      'borroso',
      'veo doble',
      'veo borroso',
      'no veo bien',
      'vista',
    ],
  },
];

/** A negation this close before a term ("no dizziness", "sin mareo") cancels the match. */
const NEGATIONS = new Set([
  'no',
  'not',
  'without',
  'never',
  'none',
  'nor',
  'neither',
  'dont',
  'doesnt',
  'didnt',
  'isnt',
  'arent',
  'wasnt',
  'werent',
  'havent',
  'hasnt',
  'hadnt',
  'sin',
  'nunca',
  'ni',
  'tampoco',
]);
/** A negation does not reach across these ("no headache but dizzy" still mentions dizziness). */
const CLAUSE_BREAKS = new Set(['but', 'and', 'although', 'though', 'however', 'yet', 'pero', 'y', 'aunque', 'sino']);
const NEGATION_WINDOW = 3;

export interface NoteSelfCheckSuggestion {
  indicatorId: IndicatorId;
  /** The terms that matched, in the order they first appear in the notes. */
  matches: string[];
}

/** Lower case, no accents, no apostrophes ("can't" -> "cant"), split into words. */
export function tokenizeNotes(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function negated(tokens: readonly string[], start: number): boolean {
  for (let i = start - 1; i >= Math.max(0, start - NEGATION_WINDOW); i--) {
    if (CLAUSE_BREAKS.has(tokens[i])) return false;
    if (NEGATIONS.has(tokens[i])) return true;
  }
  return false;
}

/** Self-checks the notes mention, in catalog order. Only self-check indicators are ever offered. */
export function suggestSelfChecksFromNotes(text: string, rules: readonly NoteKeywordRule[] = NOTE_KEYWORD_RULES): NoteSelfCheckSuggestion[] {
  const tokens = tokenizeNotes(text);
  if (tokens.length === 0) return [];
  const suggestions: NoteSelfCheckSuggestion[] = [];
  for (const rule of rules) {
    if (INDICATORS[rule.indicatorId]?.acquisition !== 'self-check') continue;
    const found: { at: number; term: string }[] = [];
    for (const term of rule.terms) {
      const words = term.split(' ');
      for (let i = 0; i + words.length <= tokens.length; i++) {
        if (words.every((word, k) => tokens[i + k] === word) && !negated(tokens, i)) {
          found.push({ at: i, term });
          break;
        }
      }
    }
    if (found.length === 0) continue;
    found.sort((a, b) => a.at - b.at);
    suggestions.push({ indicatorId: rule.indicatorId, matches: [...new Set(found.map((f) => f.term))] });
  }
  return suggestions;
}
