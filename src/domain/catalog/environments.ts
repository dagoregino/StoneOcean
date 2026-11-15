import type { EnvironmentDef, EnvironmentId } from '../types';

/**
 * Mission environments. Dose rates and delays are approximate published values, used to
 * drive the simulator and the triage wording; they are not mission-planning data.
 *
 * A consultation with Earth takes 2 × `commsDelaySec` of light travel plus `linkHandlingSec`
 * (see `domain/consult.ts`): about 2.5 s from the station, 11 s from the Moon, 22 min in
 * transit and 44 min from Mars, the worst case usually planned for.
 */
export const ENVIRONMENTS: Record<EnvironmentId, EnvironmentDef> = {
  iss: {
    id: 'iss',
    name: 'Space station (low Earth orbit)',
    shortName: 'Station',
    description: 'Microgravity, inside Earth’s magnetosphere. Flight surgeons are reachable in near real time.',
    gravityG: 0,
    commsDelaySec: 0.5,
    linkHandlingSec: 1.5,
    radiationMSvPerDay: 0.6,
    radiationReference: 'Typical ISS crew exposure, roughly 0.5–0.7 mSv/day.',
  },
  lunar: {
    id: 'lunar',
    name: 'Lunar surface base',
    shortName: 'Moon',
    description: 'One-sixth gravity, no magnetosphere. Ground support answers within seconds.',
    gravityG: 0.166,
    commsDelaySec: 1.3,
    linkHandlingSec: 8,
    radiationMSvPerDay: 1.37,
    radiationReference: 'Chang’E-4 LND lunar surface measurement, about 1.37 mSv/day (Zhang et al., 2020).',
  },
  transit: {
    id: 'transit',
    name: 'Deep-space transit to Mars',
    shortName: 'Transit',
    description: 'Microgravity in deep space. Signal delay grows by the day; evacuation is impossible.',
    gravityG: 0,
    commsDelaySec: 600,
    linkHandlingSec: 120,
    radiationMSvPerDay: 1.84,
    radiationReference: 'MSL/RAD cruise measurement, about 1.8 mSv/day (Zeitlin et al., 2013).',
  },
  mars: {
    id: 'mars',
    name: 'Mars surface base',
    shortName: 'Mars',
    description: '0.38 g on the surface. A question to Earth and its answer can take 40 minutes or more.',
    gravityG: 0.38,
    commsDelaySec: 1200,
    linkHandlingSec: 240,
    radiationMSvPerDay: 0.67,
    radiationReference: 'MSL/RAD Mars surface measurement, about 0.67 mSv/day (Hassler et al., 2014).',
  },
};

export const ENVIRONMENT_LIST: EnvironmentDef[] = Object.values(ENVIRONMENTS);

/** Human-readable one-way delay: "0.5 s", "1.3 s", "10 min". */
export function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}
