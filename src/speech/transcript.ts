/** Text helpers for dictation. Pure functions, no engine, no DOM. */

/** Joins utterances into one line: trimmed, single spaces, empty ones dropped. */
export function joinSegments(segments: readonly string[]): string {
  return segments
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

export interface AppendResult {
  value: string;
  /** True when part of the transcript did not fit within `maxLength`. */
  truncated: boolean;
}

/**
 * Adds a transcript after the existing notes, as editable text. Recognizers return lower-case
 * words without punctuation, so a new sentence gets a capital letter; nothing else is changed.
 */
export function appendTranscript(notes: string, transcript: string, maxLength: number): AppendResult {
  const words = joinSegments([transcript]);
  if (!words) return { value: notes, truncated: false };
  const before = notes.replace(/\s+$/, '');
  const newSentence = before === '' || /[.!?]$/.test(before);
  const text = newSentence ? words.charAt(0).toUpperCase() + words.slice(1) : words;
  const joined = before === '' ? text : `${before} ${text}`;
  if (joined.length <= maxLength) return { value: joined, truncated: false };
  // Cut at a word boundary when one is close, so the notes do not end mid-word.
  const cut = joined.slice(0, maxLength);
  const space = cut.lastIndexOf(' ');
  return { value: (space > maxLength - 20 && space > before.length ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
}
