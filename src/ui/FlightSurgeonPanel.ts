import type { AppActions } from '../app/actions';
import type { HealthStore } from '../data/HealthStore';
import {
  CONSULT_PHASE_LABEL,
  CONSULT_PHASES,
  consultLatency,
  consultProgress,
  formatRoundTrip,
  latencyLadder,
  type ConsultLatency,
  type FlightSurgeonConsult,
} from '../domain/consult';
import { h, setText } from './dom';
import { formatWhen } from './format';
import { helpToggle } from './panel/help';

/** Remaining time as a countdown: "8.4 s", "21:47", "1:02:03". */
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const total = Math.ceil(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const breakdown = (latency: ConsultLatency): string =>
  `light ${formatRoundTrip(latency.oneWaySec)} each way + relays and ground ${formatRoundTrip(latency.handlingSec)}`;

const TICK_MS = 100;

/**
 * "Send to Flight Surgeon", under the triage verdict: the button when the situation calls for
 * the ground, then the consultation on its way (phase, countdown, real delay), then the answer.
 * The verdict above stays first: on board, the crew acts before Earth can answer.
 */
export class FlightSurgeonPanel {
  readonly element: HTMLElement;
  private readonly offer: HTMLElement;
  private readonly reason = h('p', { class: 'consult-reason' });
  private readonly offerDelay = h('p', { class: 'consult-delay' });
  private readonly progress: HTMLElement;
  private readonly title = h('h3', { id: 'consult-title', tabIndex: -1 }, 'Consulting the flight surgeon');
  private readonly steps = h('ol', { class: 'consult-steps' });
  private readonly phase = h('p', { class: 'consult-phase' });
  private readonly countdown = h('span', { class: 'consult-countdown', 'aria-hidden': 'true' });
  private readonly countdownLabel = h('span', { class: 'consult-countdown-label' });
  private readonly delay = h('p', { class: 'consult-delay' });
  private readonly accelerated = h('p', { class: 'consult-accelerated', hidden: true });
  private readonly announcer = h('p', { class: 'sr-only', role: 'status' });
  private readonly response: HTMLElement;
  private readonly ladder = h('ol', { class: 'eimo-ladder' });
  private timer: ReturnType<typeof setInterval> | null = null;
  private dismissed = 0;
  private shownPhase = '';

  constructor(private readonly store: HealthStore, private readonly actions: AppActions) {
    this.offer = h(
      'div',
      { class: 'consult-offer' },
      this.reason,
      h(
        'button',
        { class: 'consult-button', type: 'button', onclick: () => this.send() },
        h('span', { class: 'earth-icon', 'aria-hidden': 'true' }),
        h('span', null, 'Send to Flight Surgeon', h('span', { class: 'consult-button-sub' }, 'Enviar a Tierra')),
      ),
      this.offerDelay,
    );
    this.steps.append(...CONSULT_PHASES.map((phase) => h('li', { dataset: { phase } }, h('span', { class: 'sr-only' }, CONSULT_PHASE_LABEL[phase]))));
    this.progress = h(
      'div',
      { class: 'consult-progress' },
      this.title,
      this.steps,
      this.phase,
      h('p', { class: 'consult-timer' }, this.countdown, this.countdownLabel),
      this.delay,
      this.accelerated,
    );
    this.response = h('article', { class: 'consult-response', 'aria-labelledby': 'consult-response-title' });

    const help = helpToggle(
      'What is EIMO?',
      h('p', null, 'Earth-Independent Medical Operations: the crew detects, treats and verifies on board, and the ground supports rather than leads. The farther from Earth, the longer every answer takes, so the more the crew must be able to act alone first.'),
      h('p', { class: 'eimo-ladder-title' }, 'Round trip to a flight surgeon:'),
      this.ladder,
    );
    this.element = h(
      'section',
      { class: 'consult', hidden: true, 'aria-label': 'Flight surgeon consultation' },
      this.offer,
      this.progress,
      this.response,
      this.announcer,
      h('p', { class: 'eimo' }, h('span', null, 'HELIOS is a step toward ', h('abbr', { title: 'Earth-Independent Medical Operations' }, 'EIMO'), ' (Earth-Independent Medical Operations)'), help.button),
      help.content,
    );

    store.events.on('consults', () => this.render());
    store.events.on('data', () => this.render());
    store.events.on('interventions', () => this.render());
    store.events.on('environment', () => this.render());
    this.render();
  }

  private send(): void {
    this.actions.sendToFlightSurgeon();
    // The button is replaced by the progress: keep the keyboard focus on what replaced it.
    if (this.store.activeConsult) this.title.focus({ preventScroll: true });
  }

  private render(): void {
    const { store } = this;
    const active = store.activeConsult;
    const last = store.consults[store.consults.length - 1];
    const answered = last && !active && last.id !== this.dismissed ? last : null;
    const reason = store.consultReason;
    this.element.hidden = !active && !answered && !reason;
    this.element.dataset.mode = active ? 'active' : answered ? 'answered' : 'offer';
    this.renderLadder();

    this.offer.hidden = Boolean(active || answered || !reason);
    if (reason && !active) {
      const latency = consultLatency(store.environment);
      setText(this.reason, reason.kind === 'critical' ? 'The triage calls for the ground.' : `Escalation: ${reason.text}.`);
      setText(
        this.offerDelay,
        latency.realtime
          ? `Round trip from ${store.environment.shortName}: about ${formatRoundTrip(latency.roundTripSec)}. The flight surgeon can answer almost at once.`
          : `Round trip from ${store.environment.shortName}: about ${formatRoundTrip(latency.roundTripSec)}. Start the onboard protocol first; the answer comes later.`,
      );
    }

    this.progress.hidden = !active;
    if (active) {
      this.renderProgress(active);
      this.startTimer();
    } else {
      this.stopTimer();
    }

    this.response.hidden = !answered;
    if (answered && this.response.dataset.key !== `${answered.id}:${Boolean(reason)}`) this.renderResponse(answered, Boolean(reason));
    if (answered && this.shownPhase !== `${answered.id}:received`) {
      this.shownPhase = `${answered.id}:received`;
      setText(this.announcer, 'Response received from the flight surgeon.');
    }
  }

  private renderProgress(consult: FlightSurgeonConsult): void {
    const progress = consultProgress(consult.latency, consult.playback, (Date.now() - consult.startedAtMs) / 1000);
    // The store's phase is authoritative; the clock only refines the countdown between phases.
    const phase = CONSULT_PHASES.indexOf(consult.status) > CONSULT_PHASES.indexOf(progress.phase) ? consult.status : progress.phase;
    const index = CONSULT_PHASES.indexOf(phase);
    this.steps.querySelectorAll('li').forEach((li, i) => {
      li.dataset.state = i < index ? 'done' : i === index ? 'current' : 'next';
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    setText(this.phase, `${CONSULT_PHASE_LABEL[phase]}${phase === 'en-route' ? ' to Earth' : ''}`);
    const remaining = phase === 'preparing' || phase === 'sending' ? consult.latency.roundTripSec : progress.remainingSec;
    setText(this.countdown, formatCountdown(remaining));
    setText(this.countdownLabel, ' until the answer can arrive');
    setText(this.delay, `Estimated round-trip delay: ${formatRoundTrip(consult.latency.roundTripSec)} (${breakdown(consult.latency)}) · ${consult.environmentName}`);
    this.accelerated.hidden = !consult.playback.accelerated;
    if (consult.playback.accelerated) {
      setText(this.accelerated, `Demo playback accelerated ×${Math.round(consult.playback.speedup)}: in flight this wait is ${formatRoundTrip(consult.latency.roundTripSec)}.`);
    }
    const key = `${consult.id}:${phase}`;
    if (key !== this.shownPhase) {
      this.shownPhase = key;
      setText(this.announcer, `${CONSULT_PHASE_LABEL[phase]}. Round-trip delay ${formatRoundTrip(consult.latency.roundTripSec)}.`);
    }
  }

  private renderResponse(consult: FlightSurgeonConsult, stillWarranted: boolean): void {
    this.response.dataset.key = `${consult.id}:${stillWarranted}`;
    const answer = consult.response;
    const received = consult.events.find((e) => e.phase === 'received');
    this.response.replaceChildren(
      ...[
      h('span', { class: 'eyebrow' }, `Earth-based support · ${consult.environmentName}`),
      h('h3', { id: 'consult-response-title' }, 'Response from Flight Surgeon'),
      h('ul', { class: 'consult-lines' }, ...(answer?.lines ?? []).map((line) => h('li', null, line))),
      h(
        'p',
        { class: 'consult-meta' },
        `Requested ${formatWhen(consult.createdAt)}${received ? `, received ${formatWhen(received.t)}` : ''} · round trip ${formatRoundTrip(consult.latency.roundTripSec)}`,
      ),
      answer ? h('p', { class: 'reference' }, answer.note) : null,
      h(
        'div',
        { class: 'consult-actions' },
        stillWarranted ? h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => this.send() }, 'Send an update') : null,
        h(
          'button',
          {
            class: 'button button-quiet button-small',
            type: 'button',
            onclick: () => {
              this.dismissed = consult.id;
              this.render();
            },
          },
          'Close',
        ),
      ),
      ].filter((el): el is HTMLElement => el !== null),
    );
  }

  private renderLadder(): void {
    const current = this.store.environment.id;
    if (this.ladder.dataset.env === current) return;
    this.ladder.dataset.env = current;
    this.ladder.replaceChildren(
      ...latencyLadder().map((step) =>
        h('li', { class: step.id === current ? 'is-current' : '', 'aria-current': step.id === current ? 'true' : undefined }, h('span', null, step.shortName), h('strong', null, formatRoundTrip(step.roundTripSec))),
      ),
    );
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const active = this.store.activeConsult;
      if (active) this.renderProgress(active);
      else this.stopTimer();
    }, TICK_MS);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
