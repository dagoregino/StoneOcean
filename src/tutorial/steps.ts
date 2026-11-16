export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  target: () => Element[] | DOMRect | null;
  clickTargets: () => Element[];
  enter?: () => ((keep: boolean) => void) | void;
  settleMs?: number;
}

/** Returns the first element matching a selector, or null. */
function q(sel: string): Element | null {
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}

export const FINAL_STEP: TutorialStep = {
  id: 'done',
  title: "You're ready",
  description: 'Explore the body, check the triage, and run the guided demo whenever you want.',
  position: 'auto',
  target: () => null,
  clickTargets: () => [],
};

export function buildSteps(): TutorialStep[] {
  const steps: TutorialStep[] = [];

  const brand = q('.brand');
  if (brand) steps.push({
    id: 'brand',
    title: 'HELIOS',
    description: 'Your health twin. Every body system is a data object whose live status drives its color.',
    position: 'bottom',
    target: () => [brand],
    clickTargets: () => [],
  });

  const envSwitch = q('.segmented[aria-label="Mission environment"]');
  if (envSwitch) steps.push({
    id: 'env',
    title: 'Mission environment',
    description: 'Station, Moon, Mars transit, Mars surface. Radiation, gravity and signal delay change with it.',
    position: 'bottom',
    target: () => [envSwitch],
    clickTargets: () => [],
  });

  const playMission = q('.play-mission');
  if (playMission) steps.push({
    id: 'demo',
    title: 'Guided demo',
    description: 'A 90-second tour of one health episode: detection, triage, consultation, protocol, verification.',
    position: 'bottom',
    target: () => [playMission],
    clickTargets: () => [playMission],
  });

  const legend = q('#legend');
  if (legend) steps.push({
    id: 'legend',
    title: 'Status legend',
    description: 'Nominal, caution, critical, unknown. Click one to filter the body systems list.',
    position: 'bottom',
    target: () => [legend],
    clickTargets: () => [],
  });

  const explore = q('.tool-primary');
  if (explore) steps.push({
    id: 'explore',
    title: 'Explore my body',
    description: 'Opens the anatomy: bones, muscles, vessels, organs. Click a system, click again to go deeper.',
    position: 'left',
    target: () => [explore],
    clickTargets: () => [explore],
  });

  const report = q('.tool-toggle');
  if (report) steps.push({
    id: 'report',
    title: 'Report discomfort',
    description: 'Pin a symptom on the body. HELIOS suggests self-checks and next steps; it never changes your status.',
    position: 'left',
    target: () => [report],
    clickTargets: () => [report],
  });

  const systemsToggle = q('.systems-toggle');
  if (systemsToggle) steps.push({
    id: 'systems',
    title: 'Body systems',
    description: 'Every system with its live status. Opens as a drawer so the stage stays full.',
    position: 'right',
    target: () => [systemsToggle],
    clickTargets: () => [systemsToggle],
  });

  const triage = q('.triage');
  if (triage) steps.push({
    id: 'triage',
    title: 'Status now',
    description: 'The one-line answer: is the astronaut OK, and what to do. Color, glyph and words, never color alone.',
    position: 'left',
    target: () => [triage],
    clickTargets: () => [],
  });

  const tabs = q('.tabs');
  if (tabs) steps.push({
    id: 'tabs',
    title: 'Overview / Trends',
    description: 'Overview: alerts and vital tiles. Trends: 7-day charts with status bands.',
    position: 'left',
    target: () => [tabs],
    clickTargets: () => [],
  });

  const nav = q('.main-nav');
  if (nav) steps.push({
    id: 'nav',
    title: 'Monitoring / Medical Resources',
    description: 'Switch between the health twin and the onboard medical inventory.',
    position: 'bottom',
    target: () => [nav],
    clickTargets: () => [],
  });

  steps.push(FINAL_STEP);
  return steps;
}