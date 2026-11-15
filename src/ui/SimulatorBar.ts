import type { AppActions } from '../app/actions';
import { CLOCK_SPEEDS } from '../data/MissionClock';
import { SCENARIOS, scenarioById } from '../data/sources/scenarios';
import { h, setText } from './dom';

/** How long the simulated loss of signal lasts. */
const LOSS_SECONDS = 45;

export interface SimulatorState {
  scenarioId: string;
  speed: number;
  autoLog: boolean;
}

/** Demo controls, kept visually separate from the astronaut-facing console. */
export class SimulatorBar {
  private readonly description = h('p', { class: 'sim-description' });
  private readonly select: HTMLSelectElement;
  private readonly speedButtons: HTMLButtonElement[];
  private readonly autoLog: HTMLInputElement;
  private readonly lossButton: HTMLButtonElement;
  private linkDown = false;

  constructor(parent: HTMLElement, actions: AppActions, private state: SimulatorState) {
    this.select = h(
      'select',
      {
        id: 'scenario',
        onchange: () => {
          this.state.scenarioId = this.select.value;
          actions.setScenario(this.select.value);
          this.render();
        },
      },
      ...SCENARIOS.map((s) => h('option', { value: s.id }, s.name)),
    );
    this.speedButtons = CLOCK_SPEEDS.map((speed) =>
      h(
        'button',
        {
          class: 'segment',
          type: 'button',
          onclick: () => {
            this.state.speed = speed.minutesPerSecond;
            actions.setSpeed(speed.minutesPerSecond);
            this.render();
          },
        },
        speed.label,
      ),
    );
    this.autoLog = h('input', {
      type: 'checkbox',
      id: 'auto-log',
      onchange: () => {
        this.state.autoLog = this.autoLog.checked;
        actions.setAutoLog(this.autoLog.checked);
      },
    });

    // Demo control for the link to Earth: a short loss of signal, to show store-and-forward.
    this.lossButton = h(
      'button',
      { class: 'button button-quiet', type: 'button', title: 'Earth becomes unreachable for 45 seconds; reports are queued on board and sent when the link returns.', onclick: () => actions.setLossOfSignal(this.linkDown ? null : LOSS_SECONDS) },
      'Simulate loss of signal',
    );

    parent.append(
      h(
        'div',
        { class: 'sim-row' },
        h('span', { class: 'eyebrow' }, 'Demo simulator'),
        h('label', { for: 'scenario', class: 'sr-only' }, 'Scenario'),
        this.select,
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Simulation speed' }, ...this.speedButtons),
        h('label', { class: 'check', for: 'auto-log', title: 'When off, self-checks stop arriving and the crew member is prompted to log them.' }, this.autoLog, 'Auto-log self-checks'),
        h(
          'button',
          {
            class: 'button button-quiet',
            type: 'button',
            onclick: () => {
              this.state.scenarioId = SCENARIOS[0].id;
              actions.resetMission();
              this.render();
            },
          },
          'Restart',
        ),
        this.lossButton,
      ),
      this.description,
    );
    this.render();
  }

  /** Shows a state that was changed from outside (the guided demo restores the simulator when it ends). */
  sync(state: Partial<SimulatorState>): void {
    Object.assign(this.state, state);
    this.render();
  }

  /** The link to Earth changed: the button offers the opposite. */
  setLinkDown(down: boolean): void {
    this.linkDown = down;
    setText(this.lossButton, down ? 'Restore Earth link' : 'Simulate loss of signal');
    this.lossButton.setAttribute('aria-pressed', String(down));
  }

  private render(): void {
    this.select.value = this.state.scenarioId;
    this.autoLog.checked = this.state.autoLog;
    this.speedButtons.forEach((button, i) =>
      button.setAttribute('aria-pressed', String(CLOCK_SPEEDS[i].minutesPerSecond === this.state.speed)),
    );
    setText(this.description, scenarioById(this.state.scenarioId).description);
  }
}
