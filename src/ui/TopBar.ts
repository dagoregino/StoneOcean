import { APP_SUBTITLE, APP_TITLE } from '../config';
import type { HealthStore } from '../data/HealthStore';
import { formatMissionTime } from '../data/MissionClock';
import { ENVIRONMENT_LIST } from '../domain/catalog/environments';
import { h, setText } from './dom';

/** Title, mission clock and the environment switch. */
export class TopBar {
  constructor(parent: HTMLElement, store: HealthStore) {
    const clock = h('span', { class: 'mission-clock' });
    const buttons = ENVIRONMENT_LIST.map((env) =>
      h(
        'button',
        {
          class: 'segment',
          type: 'button',
          title: `${env.name}. ${env.description}`,
          onclick: () => store.setEnvironment(env.id),
        },
        env.shortName,
      ),
    );

    // Inline SVG needs the SVG namespace, so it is written as markup rather than built with h().
    const mark = h('span', { class: 'brand-mark', 'aria-hidden': 'true' });
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none"><path d="M1 14h4.6l2.1-6.4 3.2 12.2 2.8-9.4 1.9 3.6H23" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    parent.append(
      h(
        'div',
        { class: 'brand' },
        mark,
        h('div', null, h('h1', null, APP_TITLE), h('p', null, APP_SUBTITLE)),
      ),
      h(
        'div',
        { class: 'mission' },
        clock,
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Mission environment' }, ...buttons),
      ),
    );

    const renderEnvironment = (): void => {
      const env = store.environment;
      buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(ENVIRONMENT_LIST[i].id === env.id)));
    };
    const renderClock = (): void => {
      const { day, clock: time } = formatMissionTime(store.missionTime);
      setText(clock, `Mission day ${day} · ${time}`);
    };

    store.events.on('environment', renderEnvironment);
    store.events.on('data', renderClock);
    renderEnvironment();
    renderClock();
  }
}
