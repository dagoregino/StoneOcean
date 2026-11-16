import type { HealthStore } from '../data/HealthStore';
import { TWIN_VIEW_LABEL, type TwinView } from '../domain/twinView';

const SWITCH_VIEWS: readonly TwinView[] = ['astronaut', 'anatomy'];
import { h, setText } from './dom';

const HINT: Record<TwinView, string> = {
  astronaut: 'Click the astronaut to scan and open the anatomy',
  scan: 'Click a body system to look closer',
  anatomy: 'Click again to go deeper',
};
const VIEW_TITLE: Record<TwinView, string> = {
  astronaut: 'Back to the astronaut',
  scan: 'See the anatomy through the suit',
  anatomy: 'The anatomy alone',
};

/**
 * How the twin is shown. At rest there is one invitation, "Explore my body"; once the
 * anatomy is open, it becomes a switch between the three views.
 */
export class TwinViewControl {
  private readonly explore: HTMLButtonElement;
  private readonly switcher: HTMLElement;
  private readonly buttons: HTMLButtonElement[];

  constructor(tools: HTMLElement, private readonly hint: HTMLElement, private readonly store: HealthStore) {
    this.explore = h(
      'button',
      { class: 'tool-primary', type: 'button', onclick: () => store.setTwinView('anatomy') },
      h('span', { class: 'tool-primary-icon', 'aria-hidden': 'true' }),
      'Explore my body',
    );
    // The scanner is a moment on the way to the anatomy, not a place to stay: it is not offered as a view.
    this.buttons = SWITCH_VIEWS.map((view) => h('button', { class: 'segment', type: 'button', title: VIEW_TITLE[view], onclick: () => store.setTwinView(view) }, TWIN_VIEW_LABEL[view]));
    this.switcher = h('div', { class: 'segmented twin-switch', role: 'group', 'aria-label': 'View of the body' }, ...this.buttons);
    tools.prepend(this.explore, this.switcher);
    store.events.on('twinView', () => this.render());
    // Report mode owns the hint while it is on; take it back afterwards.
    store.events.on('reportMode', (enabled) => {
      if (!enabled) this.render();
    });
    this.render();
  }

  private render(): void {
    const view = this.store.twinView;
    const resting = view === 'astronaut';
    const hadFocus = document.activeElement === this.explore || this.buttons.includes(document.activeElement as HTMLButtonElement);
    this.explore.hidden = !resting;
    this.switcher.hidden = resting;
    this.buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(SWITCH_VIEWS[i] === view || (view === 'scan' && SWITCH_VIEWS[i] === 'anatomy'))));
    if (!this.store.reportMode) setText(this.hint, HINT[view]);
    // Keep the keyboard where it was when one control replaces the other.
    if (hadFocus) (resting ? this.explore : this.buttons[1]).focus({ preventScroll: true });
  }
}
