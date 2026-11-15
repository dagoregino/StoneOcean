/**
 * The radio link to Earth, as far as the crew needs to know it: is the ground reachable,
 * and if not, when the next contact window opens.
 *
 * LOS (loss of signal) and AOS (acquisition of signal) are the usual flight terms. Losing
 * the link changes nothing clinical: the triage, the thresholds and the protocols are the
 * same. It only changes what can be sent now and what has to wait on board.
 */
export const LINK_STATES = ['available', 'loss-of-signal', 'reacquiring'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export interface CommunicationWindow {
  state: LinkState;
  /** Wall-clock milliseconds at which the link is expected back; absent while it is available. */
  nextContactAt?: number;
}

export const LINK_AVAILABLE: CommunicationWindow = { state: 'available' };

export const isLinkUp = (window: CommunicationWindow): boolean => window.state === 'available';

/** Time left until the next contact window, as HH:MM:SS. */
export function formatContactCountdown(window: CommunicationWindow, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil(((window.nextContactAt ?? nowMs) - nowMs) / 1000));
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${part(Math.floor(seconds / 3600))}:${part(Math.floor((seconds % 3600) / 60))}:${part(seconds % 60)}`;
}
