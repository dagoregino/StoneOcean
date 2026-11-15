import type { AuthorityLevel } from '../domain/evidence/types';
import type { SymptomInput } from '../domain/symptoms';
import type { IndicatorId } from '../domain/types';

/** Everything the UI is allowed to ask the application to do. */
export interface AppActions {
  logReading(id: IndicatorId, value: number): void;
  setScenario(id: string): void;
  setSpeed(minutesPerSecond: number): void;
  setAutoLog(enabled: boolean): void;
  resetMission(): void;
  /** The crew member carried out a treatment step; the Verify step takes over from here. */
  startIntervention(id: IndicatorId, stepText: string, authorityLevel: AuthorityLevel): void;
  /** Mission medical plan: are drug steps pre-authorized? Off by default. */
  setDrugsPreauthorized(enabled: boolean): void;
  /** Discomfort marked on the 3D body goes into the mission log. */
  reportSymptom(input: SymptomInput): void;
  removeSymptom(id: number): void;
  /** "Send to Flight Surgeon": open a consultation with the ground (see domain/consult.ts). */
  sendToFlightSurgeon(): void;
}
