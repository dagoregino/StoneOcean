import type { HealthStore } from '../data/HealthStore';
import { ANSWER_LABEL, changesSinceYesterday, MOOD_ANSWERS, PLAN_KIND_LABEL, planForToday, SLEEP_ANSWERS, type MoodAnswer, type SleepAnswer } from '../domain/checkIn';
import { thresholdsFor } from '../domain/engine/evaluate';
import { openDialog, type Dialog } from './dialog';
import { h } from './dom';
import { formatValue } from './format';

const COMPARE_MS = 1300;

/**
 * The daily check-in: a short, optional start to the day. It shows what changed since
 * yesterday, asks three quick questions and ends on the plan for the day. Everything it
 * shows is read from the store; the answers are saved as given and change no status.
 */
export class DailyCheckIn {
  private dialog: Dialog | null = null;
  private timer: number | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(tools: HTMLElement, private readonly store: HealthStore) {
    tools.append(h('button', { class: 'tool-toggle', type: 'button', onclick: () => this.open() }, h('span', { class: 'tool-toggle-icon checkin-icon', 'aria-hidden': 'true' }, '☼'), 'Daily check-in'));
  }

  open(): void {
    if (this.dialog) return;
    const body = h('div', { class: 'checkin-body' });
    this.dialog = openDialog('Daily check-in', [body], {
      className: 'checkin-dialog',
      onClose: () => {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        this.dialog = null;
      },
    });
    const show = (...content: (HTMLElement | null)[]): void => {
      body.replaceChildren(...content.filter((el): el is HTMLElement => el !== null));
      body.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    };
    const answers: { sleep?: SleepAnswer; mood?: MoodAnswer; discomfort?: boolean } = {};
    const actions = (...buttons: HTMLElement[]): HTMLElement => h('div', { class: 'checkin-actions' }, ...buttons);
    const button = (label: string, onclick: () => void, primary = false): HTMLElement => h('button', { class: primary ? 'button' : 'button button-quiet', type: 'button', onclick }, label);

    const greeting = (): void =>
      show(
        h('h3', null, 'Yesterday, in one pass'),
        h('p', { class: 'checkin-lead' }, 'Three questions and a plan for today. First, what changed since yesterday.'),
        actions(button('Not now', () => this.dialog?.close()), button('Start', compare, true)),
      );

    const compare = (): void => {
      // The scanner runs once: on the twin if the astronaut is on show, and as a single sweep here.
      if (this.store.twinView === 'astronaut') this.store.setTwinView('anatomy');
      show(h('div', { class: 'checkin-scan', 'aria-hidden': 'true' }, h('span')), h('p', { class: 'checkin-lead', role: 'status' }, 'Comparing with yesterday…'));
      this.timer = window.setTimeout(changes, this.reducedMotion ? 0 : COMPARE_MS);
    };

    const changes = (): void => {
      const list = changesSinceYesterday((id) => this.store.history(id), this.store.missionTime, (id) => this.store.baselineOf(id)?.baseline.sd);
      show(
        h('h3', null, 'What changed?'),
        list.length === 0
          ? h('p', { class: 'checkin-lead' }, 'Nothing moved beyond your usual day-to-day variation since yesterday.')
          : h(
              'ul',
              { class: 'checkin-changes' },
              ...list.map((change) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'checkin-change-name' }, change.def.name),
                  h('strong', null, change.label),
                  h('span', { class: 'checkin-change-detail' }, `${formatValue(change.yesterday, change.def)} → ${formatValue(change.today, change.def)} ${change.def.unit} · means of the last two days`),
                ),
              ),
            ),
        h('p', { class: 'reference' }, 'Measured readings only. Whether a change matters is decided by the alerts, not by this list.'),
        actions(button('Continue', sleep, true)),
      );
    };

    const question = <T extends string>(title: string, options: readonly T[], label: (option: T) => string, onAnswer: (option: T) => void, step: number): void =>
      show(h('p', { class: 'checkin-step' }, `Question ${step} of 3`), h('h3', null, title), h('div', { class: 'checkin-options' }, ...options.map((option) => button(label(option), () => onAnswer(option)))));

    const sleep = (): void =>
      question('How did you sleep?', SLEEP_ANSWERS, (o) => ANSWER_LABEL[o], (answer) => {
        answers.sleep = answer;
        mood();
      }, 1);
    const mood = (): void =>
      question('How are you feeling today?', MOOD_ANSWERS, (o) => ANSWER_LABEL[o], (answer) => {
        answers.mood = answer;
        discomfort();
      }, 2);
    const discomfort = (): void =>
      question('Any discomfort today?', ['no', 'yes'] as const, (o) => (o === 'no' ? 'No' : 'Yes — select on body'), (answer) => {
        answers.discomfort = answer === 'yes';
        this.store.recordCheckIn({ sleep: answers.sleep!, mood: answers.mood!, discomfort: answers.discomfort });
        plan();
      }, 3);

    const plan = (): void => {
      const { store } = this;
      const items = planForToday(store.evaluation, store.interventions, store.medicalPlan, (def) => thresholdsFor(def, store.environment));
      show(
        h('h3', null, 'Your plan today'),
        items.length === 0
          ? h('p', { class: 'checkin-lead' }, 'Nothing is pending. Keep to your routine.')
          : h('ul', { class: 'checkin-plan' }, ...items.map((item) => h('li', { dataset: { kind: item.kind } }, h('span', { class: 'checkin-plan-kind' }, PLAN_KIND_LABEL[item.kind]), h('span', null, item.text)))),
        h('p', { class: 'reference' }, 'Built from tasks HELIOS already tracks: active protocols, verifications, due self-checks and daily targets. Your answers are saved to the mission log and change no status.'),
        actions(
          answers.discomfort
            ? button(
                'Mark the discomfort on the body',
                () => {
                  this.dialog?.close();
                  store.setReportMode(true);
                },
                true,
              )
            : button('Done', () => this.dialog?.close(), true),
        ),
      );
    };

    greeting();
  }
}
