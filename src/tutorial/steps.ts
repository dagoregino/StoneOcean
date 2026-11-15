import type { SpotlightPosition, SpotlightTarget } from './TutorialSpotlight';

/**
 * The interface tour, as data: what each step lights up, what the assistant says, and what it
 * may open for a moment. It teaches where things are ("how do I use HELIOS?"); it never plays a
 * health scenario, which is what Play the Mission is for.
 *
 * Steps only find and press the app's real controls, as a person would. They change no data,
 * and whatever a step opens it closes again when the step ends, unless the person chose it.
 */
export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  position: SpotlightPosition;
  target: SpotlightTarget;
  /** Clicking one of these (the person trying it) moves the tour on. */
  clickTargets: () => Element[];
  /** Runs when the step starts; returns what undoes it when the step ends. */
  enter?: () => StepCleanup | void;
  /** Some steps move the page (a drawer slides in): measure again after this long. */
  settleMs?: number;
}

/** Undo a step's own changes. `keep` is true when the person clicked the highlighted control. */
export type StepCleanup = (keep: boolean) => void;

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const all = (...selectors: string[]): Element[] => selectors.map((s) => $(s)).filter((el): el is HTMLElement => el !== null && !(el as HTMLElement).hidden);
const isOpen = (button: Element | null): boolean => button?.getAttribute('aria-expanded') === 'true';

/** The astronaut: the middle of the 3D view, where the figure stands. */
function astronautBox(): DOMRect | null {
  const stage = $('#stage');
  const box = stage?.getBoundingClientRect();
  if (!box || box.width === 0) return null;
  const width = Math.min(box.width * 0.36, 360);
  return new DOMRect(box.left + (box.width - width) / 2, box.top + box.height * 0.08, width, box.height * 0.84);
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'twin',
    title: 'This is your Health Twin.',
    description: 'Click the astronaut to scan and explore the body.',
    position: 'right',
    target: astronautBox,
    clickTargets: () => all('#stage'),
  },
  {
    id: 'anatomy',
    title: 'Astronaut and Anatomy',
    description: 'Switch to Anatomy to explore body systems directly.',
    position: 'bottom',
    // Whichever is on show: "Explore my body" on the astronaut, the Astronaut / Anatomy switch otherwise.
    target: () => all('#viewport-tools .tool-primary', '#viewport-tools .twin-switch'),
    clickTargets: () => all('#viewport-tools .tool-primary', '#viewport-tools .twin-switch'),
  },
  {
    id: 'systems',
    title: 'Body Systems',
    description: 'Open Body Systems to inspect each system and its current status.',
    position: 'right',
    target: () => {
      const toggle = $('.systems-toggle');
      // Open, the drawer itself is lit; the button stays visible beside it.
      return isOpen(toggle) ? all('#systems') : all('.systems-toggle');
    },
    clickTargets: () => all('.systems-toggle'),
    settleMs: 340,
    enter() {
      const toggle = $<HTMLButtonElement>('.systems-toggle');
      if (!toggle || isOpen(toggle)) return;
      // Open it for this step only; the drawer moves the focus into itself, so it is given back.
      const focused = document.activeElement as HTMLElement | null;
      toggle.click();
      focused?.focus({ preventScroll: true });
      return (keep) => {
        if (!keep && isOpen(toggle)) toggle.click();
      };
    },
  },
  {
    id: 'report',
    title: 'Feeling something unusual?',
    description: 'Report it here, or tap directly on your body.',
    position: 'bottom',
    // The Report discomfort toggle is the one tool with a pressed state.
    target: () => all('#viewport-tools .tool-toggle[aria-pressed]'),
    clickTargets: () => all('#viewport-tools .tool-toggle[aria-pressed]'),
  },
  {
    id: 'trends',
    title: 'Trends',
    description: 'Use Trends to see how your measurements change over time.',
    position: 'left',
    target: () => all('#panel-tab-trends', '#panel-tabpanel'),
    clickTargets: () => all('#panel-tab-trends'),
    settleMs: 120,
    enter() {
      const trends = $<HTMLButtonElement>('#panel-tab-trends');
      const before = $<HTMLButtonElement>('#panel [role="tab"][aria-selected="true"]');
      if (!trends || !before || before === trends) return;
      // Show the chart for a moment, then put back the tab that was open.
      trends.click();
      return (keep) => {
        if (!keep && trends.getAttribute('aria-selected') === 'true') before.click();
      };
    },
  },
  {
    id: 'resources',
    title: 'Medical Resources',
    description: 'Medical Resources shows onboard supplies, guidance and available resources.',
    position: 'bottom',
    target: () => all('.main-nav .nav-item:nth-child(2)'),
    clickTargets: () => all('.main-nav .nav-item:nth-child(2)'),
  },
];

/** The closing card: points at Play the Mission, but never starts it. */
export const FINAL_STEP = {
  title: 'You’re ready.',
  description: 'Use Play the Mission whenever you want to see HELIOS in action: a complete health scenario, start to finish.',
  position: 'bottom' as SpotlightPosition,
  target: (): Element[] => all('.play-mission'),
};
