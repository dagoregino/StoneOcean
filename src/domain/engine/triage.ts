import { formatDelay } from '../catalog/environments';
import { severity, worstOf } from '../status';
import type { EnvironmentDef, SystemEvaluation, SystemId, Triage } from '../types';

/** Above this one-way delay a conversation with Earth is no longer practical. */
export const REALTIME_LIMIT_SEC = 5;

/**
 * Answers the challenge question "when does a result warrant attention from the crew or
 * from flight surgeons on the ground?" with one of four levels.
 *
 * The same critical finding leads to different instructions depending on distance from
 * Earth: near Earth the astronaut calls the flight surgeon; in deep space the crew must
 * start the onboard protocol first, because the answer arrives too late to wait for.
 */
export function triage(systems: Record<SystemId, SystemEvaluation>, env: EnvironmentDef): Triage {
  const flagged = Object.values(systems)
    .filter((s) => severity(s.status) >= severity('caution'))
    .sort((a, b) => severity(b.status) - severity(a.status));
  const ids = flagged.map((s) => s.def.id);
  const names = flagged.map((s) => s.def.name);
  const status = worstOf(Object.values(systems).map((s) => s.status));
  const critical = flagged.filter((s) => s.status === 'critical');

  if (critical.length > 0) {
    const list = critical.map((s) => s.def.name).join(', ');
    if (env.commsDelaySec <= REALTIME_LIMIT_SEC) {
      return {
        level: 'ground-consult',
        status,
        headline: 'Contact the flight surgeon now',
        detail: `${list}: critical. Real-time link available (${formatDelay(env.commsDelaySec)} delay). Start the listed actions while you call.`,
        systems: ids,
      };
    }
    const roundTrip = formatDelay(env.commsDelaySec * 2);
    return {
      level: 'ground-consult',
      status,
      headline: 'Start the onboard protocol now',
      detail: `${list}: critical. Earth cannot answer in time: a reply takes at least ${roundTrip}. Act with the Crew Medical Officer first; the report to flight surgeons is sent in parallel.`,
      systems: ids,
    };
  }

  if (flagged.length >= 2) {
    return {
      level: 'crew-medical',
      status,
      headline: 'Inform the Crew Medical Officer',
      detail: `${names.join(', ')} need attention. Several systems drifting together deserves a second opinion on board.`,
      systems: ids,
    };
  }

  if (flagged.length === 1) {
    return {
      level: 'self-care',
      status,
      headline: 'Self-care actions recommended',
      detail: `${names[0]} is outside its nominal range. Follow the listed actions and raise it at your next medical conference.`,
      systems: ids,
    };
  }

  const hasData = Object.values(systems).some((s) => s.status !== 'unknown');
  return {
    level: 'nominal',
    status,
    headline: hasData ? 'All systems nominal' : 'Waiting for data',
    detail: hasData ? 'Keep to your routine: exercise, sleep, nutrition and scheduled checks.' : 'No readings received yet.',
    systems: [],
  };
}
