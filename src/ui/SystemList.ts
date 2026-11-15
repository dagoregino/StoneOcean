import type { HealthStore } from '../data/HealthStore';
import { STATUS_GLYPH, STATUS_LABEL } from '../domain/status';
import { SYSTEM_IDS, type SystemEvaluation } from '../domain/types';
import { h, setText, syncList } from './dom';
import { formatValue } from './format';

function summary(system: SystemEvaluation): string {
  const driver = system.driver;
  if (!driver?.latest) return 'No data yet';
  return `${driver.def.name}: ${formatValue(driver.latest.value, driver.def)} ${driver.def.unit}`;
}

/**
 * Every body system with its live status, mirroring the 3D body. It is a drawer over the
 * left edge of the 3D view: closed when the dashboard opens, so the astronaut has the whole
 * stage, and one button away. It slides with a transform, so opening it never resizes the canvas.
 */
export class SystemList {
  private readonly list = h('div', { class: 'system-list' });
  private readonly toggle: HTMLButtonElement;
  private open = false;

  /** @param toggleHost where the button that opens the drawer goes (beside the 3D view) */
  constructor(private readonly parent: HTMLElement, private readonly store: HealthStore, toggleHost: HTMLElement) {
    parent.id ||= 'systems';
    this.toggle = h(
      'button',
      { class: 'systems-toggle', type: 'button', 'aria-controls': parent.id, 'aria-expanded': 'false', onclick: () => this.setOpen(!this.open) },
      h('span', { class: 'systems-toggle-icon', 'aria-hidden': 'true' }),
      h('span', { class: 'systems-toggle-label' }, 'Body systems'),
      h('span', { class: 'systems-toggle-count', hidden: true }),
    );
    toggleHost.prepend(this.toggle);
    parent.append(
      h(
        'div',
        { class: 'systems-head' },
        h('h2', { class: 'section-title' }, 'Body systems'),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Hide body systems', onclick: () => this.setOpen(false, true) }, '×'),
      ),
      this.list,
    );
    parent.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.setOpen(false, true);
    });
    const render = (): void => this.render();
    store.events.on('data', render);
    store.events.on('selection', render);
    store.events.on('hover', render);
    store.events.on('visibility', render);
    this.setOpen(false);
  }

  private setOpen(open: boolean, returnFocus = false): void {
    this.open = open;
    this.parent.classList.toggle('is-open', open);
    // Closed, it is out of the way for the keyboard and assistive technology too.
    this.parent.inert = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    document.getElementById('app')?.toggleAttribute('data-systems-open', open);
    this.render();
    if (open) this.list.querySelector<HTMLElement>('.system-main')?.focus({ preventScroll: true });
    else if (returnFocus) this.toggle.focus({ preventScroll: true });
  }

  private render(): void {
    const { store } = this;
    const systems = SYSTEM_IDS.map((id) => store.evaluation.systems[id]);
    // The button says how many systems need attention, so a closed drawer hides nothing important.
    const flagged = systems.filter((s) => s.status === 'caution' || s.status === 'critical');
    const count = this.toggle.querySelector<HTMLElement>('.systems-toggle-count')!;
    count.hidden = flagged.length === 0;
    setText(count, String(flagged.length));
    count.dataset.status = flagged.some((s) => s.status === 'critical') ? 'critical' : 'caution';
    this.toggle.setAttribute('aria-label', flagged.length > 0 ? `Body systems: ${flagged.length} need attention` : 'Body systems');
    // The rows themselves are only kept up to date while someone can see them.
    if (!this.open) return;
    syncList(
      this.list,
      systems,
      (s) => s.def.id,
      (s) => {
        const id = s.def.id;
        return h(
          'div',
          { class: 'system-row' },
          h(
            'button',
            {
              class: 'system-main',
              type: 'button',
              onclick: () => store.select(store.selected === id ? null : id),
              onpointerenter: () => store.hover(id),
              onpointerleave: () => store.hover(null),
            },
            h('span', { class: 'status-glyph', 'aria-hidden': 'true' }),
            h('span', { class: 'system-text' }, h('span', { class: 'system-name' }, s.def.name), h('span', { class: 'system-summary' })),
            h('span', { class: 'system-status' }),
          ),
          h(
            'button',
            { class: 'layer-toggle', type: 'button', onclick: () => store.toggleVisibility(id) },
            h('span', { 'aria-hidden': 'true' }),
          ),
        );
      },
      (el, s) => {
        const id = s.def.id;
        const hidden = store.hidden.has(id);
        el.dataset.status = s.status;
        el.classList.toggle('is-selected', store.selected === id);
        el.classList.toggle('is-hovered', store.hovered === id);
        el.classList.toggle('is-hidden', hidden);
        el.querySelector('.system-main')!.setAttribute('aria-pressed', String(store.selected === id));
        setText(el.querySelector('.status-glyph')!, STATUS_GLYPH[s.status]);
        setText(el.querySelector('.system-summary')!, summary(s));
        setText(el.querySelector('.system-status')!, STATUS_LABEL[s.status]);
        const toggle = el.querySelector('.layer-toggle')!;
        toggle.setAttribute('aria-pressed', String(!hidden));
        toggle.setAttribute('title', hidden ? `Show ${s.def.name} in 3D` : `Hide ${s.def.name} in 3D`);
        toggle.setAttribute('aria-label', hidden ? `Show ${s.def.name} layer` : `Hide ${s.def.name} layer`);
        setText(toggle.firstElementChild!, hidden ? 'Off' : 'On');
      },
    );
  }
}
