import { SYSTEMS } from './catalog/systems';
import { EVENT_SOURCE_LABEL, type EventSource, type MissionEvent } from './missionLog';
import { SYMPTOM_TYPE_LABEL, type SymptomReport } from './symptoms';
import type { MissionMinutes, SystemId } from './types';

/**
 * A health episode: everything that happened around one body system, from the moment its
 * status left nominal until it came back, told in the order it happened and laid out as a
 * SOAP note (Subjective, Objective, Assessment, Plan).
 *
 * The record is assembled from the mission history. It contains no finding of its own: the
 * assessment is the status and the triage the rules engine produced, never a diagnosis.
 */

export interface EpisodeLine {
  t: MissionMinutes;
  text: string;
  source: EventSource;
}

export interface HealthEpisode {
  id: string;
  systemId: SystemId;
  systemName: string;
  startedAt: MissionMinutes;
  /** Set once the system is back to nominal. */
  closedAt?: MissionMinutes;
  /** How the episode ended, when it has. */
  outcome: 'open' | 'resolved';
  /** What the crew member reported. */
  subjective: EpisodeLine[];
  /** What was measured. */
  objective: EpisodeLine[];
  /** What the rules engine concluded from the measurements. */
  assessment: EpisodeLine[];
  /** What was done, asked and verified. */
  plan: EpisodeLine[];
  /** Every entry of the episode in the order it happened. */
  timeline: MissionEvent[];
}

const isFlagged = (status: string): boolean => status === 'caution' || status === 'critical';

/**
 * Builds the episodes found in the mission history, oldest first. An episode opens when a
 * system's status leaves nominal and closes when it returns to it. Entries that belong to no
 * body system (the link, the consultations) are included when they fall inside the episode.
 */
export function buildEpisodes(log: readonly MissionEvent[]): HealthEpisode[] {
  const episodes: HealthEpisode[] = [];
  const open = new Map<SystemId, HealthEpisode>();

  for (const event of log) {
    if (event.kind === 'status' && event.systemId && event.status) {
      const { from, to } = event.status;
      let episode = open.get(event.systemId);
      if (!episode && isFlagged(to) && !isFlagged(from)) {
        episode = {
          id: `EP-${String(episodes.length + 1).padStart(3, '0')}`,
          systemId: event.systemId,
          systemName: SYSTEMS[event.systemId].name,
          startedAt: event.t,
          outcome: 'open',
          subjective: [],
          objective: [],
          assessment: [],
          plan: [],
          timeline: [],
        };
        episodes.push(episode);
        open.set(event.systemId, episode);
      }
      if (episode) {
        add(episode, event);
        if (to === 'nominal') {
          episode.closedAt = event.t;
          episode.outcome = 'resolved';
          open.delete(event.systemId);
        }
      }
      continue;
    }
    // Everything else joins the episode of its own body system, or every open episode when it concerns the whole crew member.
    const targets = event.systemId ? [open.get(event.systemId)] : [...open.values()];
    for (const episode of targets) if (episode) add(episode, event);
  }
  // An answer from Earth is dated when it arrived, which can be before the entry after it was written: show real order.
  for (const episode of episodes) episode.timeline.sort((a, b) => a.t - b.t || a.id - b.id);
  return episodes;
}

function add(episode: HealthEpisode, event: MissionEvent): void {
  episode.timeline.push(event);
  const line: EpisodeLine = { t: event.t, text: event.text, source: event.source };
  switch (event.kind) {
    case 'symptom':
    case 'check-in':
      episode.subjective.push(line);
      break;
    case 'status':
      // The measurement is objective; what the rules made of it is the assessment.
      if (event.value) episode.objective.push({ t: event.t, source: 'measured', text: event.value });
      episode.assessment.push({ t: event.t, source: 'triage', text: `${event.text}${event.basis ? ` (${event.basis})` : ''}` });
      break;
    case 'verification':
      episode.objective.push(line);
      episode.plan.push({ ...line, source: 'protocol' });
      break;
    case 'guidance':
    case 'treatment':
    case 'consult':
    case 'link':
      episode.plan.push(line);
      break;
  }
}

/** The part of a discomfort report worth repeating in a summary. */
export const describeSymptom = (report: SymptomReport): string => `${SYMPTOM_TYPE_LABEL[report.type]}, ${report.intensity}/10${report.notes ? ` — ${report.notes}` : ''}`;

/** A plain-text medical summary of one episode: readable in any editor, with the source of every line. */
export function episodeSummary(episode: HealthEpisode, when: (t: MissionMinutes) => string): string {
  const section = (title: string, lines: EpisodeLine[], empty: string): string =>
    [title, ...(lines.length > 0 ? lines.map((l) => `  ${when(l.t)}  [${EVENT_SOURCE_LABEL[l.source]}] ${l.text}`) : [`  ${empty}`])].join('\n');
  return [
    `HELIOS episode record ${episode.id}`,
    `Body system: ${episode.systemName}`,
    `Opened: ${when(episode.startedAt)}`,
    episode.closedAt !== undefined ? `Closed: ${when(episode.closedAt)} (measured back to nominal)` : 'Status: open',
    '',
    section('S - Subjective (reported by the crew member)', episode.subjective, 'Nothing reported.'),
    '',
    section('O - Objective (measured)', episode.objective, 'No measurement recorded.'),
    '',
    section('A - Assessment (status and triage from the onboard rules; not a diagnosis)', episode.assessment, 'No assessment recorded.'),
    '',
    section('P - Plan (actions, consultations, verification)', episode.plan, 'No action recorded.'),
    '',
    'Timeline',
    ...episode.timeline.map((e) => `  ${when(e.t)}  [${EVENT_SOURCE_LABEL[e.source]}] ${e.text}`),
    '',
    'Decision support record generated on board. Simulated readings. Not a medical device.',
  ].join('\n');
}
