import type { AppActions } from '../app/actions';
import type { HealthStore } from '../data/HealthStore';
import type { ResourceStore } from '../data/resources/ResourceStore';
import { formatDelay } from '../domain/catalog/environments';
import { INDICATORS } from '../domain/catalog/indicators';
import { severity } from '../domain/status';
import type { Evaluation, IndicatorId, SystemId } from '../domain/types';
import { h, setText } from './dom';
import { FlightSurgeonPanel } from './FlightSurgeonPanel';
import { statusBadge, updateBadge } from './format';
import type { PanelContext, PanelTab } from './panel/context';
import { OverviewTab } from './panel/OverviewTab';
import { ProtocolTab } from './panel/ProtocolTab';
import { TrendsTab } from './panel/TrendsTab';

const TRIAGE_ICON: Record<string, string> = {
  nominal: '●',
  'self-care': '▲',
  'crew-medical': '▲',
  'ground-consult': '◆',
};

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'protocol', label: 'Protocol & evidence' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Right column. The triage verdict stays on top; below it, three tabs disclose detail step
 * by step: the overview (what is happening), the trend (how it got here) and the protocol
 * with its evidence (what to do and why). All three follow the body system selected in 3D.
 */
export class SidePanel {
  private readonly triage = h('section', { class: 'triage', 'aria-live': 'polite' });
  private readonly triageIcon = h('span', { class: 'triage-icon', 'aria-hidden': 'true' });
  private readonly triageHeadline = h('h2');
  private readonly triageDetail = h('p');
  private readonly triageLink = h('p', { class: 'triage-link' });
  private readonly scopeName = h('h3');
  private readonly scopeBadge = statusBadge('unknown');
  private readonly back: HTMLButtonElement;
  private readonly tabButtons: HTMLButtonElement[];
  private readonly body = h('div', { class: 'panel-body', id: 'panel-tabpanel', role: 'tabpanel', tabIndex: 0 });
  private view: PanelTab | null = null;
  private tab: TabId = 'overview';
  private indicator: IndicatorId | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: HealthStore,
    private readonly actions: AppActions,
    private readonly resources: ResourceStore,
    private readonly openResources: () => void,
  ) {
    this.triage.append(
      this.triageIcon,
      h('div', null, h('span', { class: 'eyebrow' }, 'What should I do?'), this.triageHeadline, this.triageDetail, this.triageLink),
    );
    this.back = h('button', { class: 'link-button', type: 'button', onclick: () => store.select(null) }, '← All systems');
    this.tabButtons = TABS.map((tab) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', id: `panel-tab-${tab.id}`, 'aria-controls': 'panel-tabpanel', onclick: () => this.open(tab.id) }, tab.label),
    );
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panel sections', onkeydown: (event: KeyboardEvent) => this.onTabKey(event) }, ...this.tabButtons);
    // Priority: status and what to do (triage), then the ground consultation, then the details.
    const consult = new FlightSurgeonPanel(store, actions);
    parent.append(this.triage, consult.element, h('div', { class: 'panel-scope' }, this.back, h('div', { class: 'panel-scope-title' }, this.scopeName, this.scopeBadge)), tablist, this.body);

    store.events.on('selection', (id) => {
      // An indicator stays in focus only while its own body system is the one selected.
      if (this.indicator && INDICATORS[this.indicator].systemId !== id) this.indicator = null;
      // A system that needs attention opens on what to do about it, not on a summary.
      const system = id ? store.evaluation.systems[id] : null;
      if (system?.driver && severity(system.status) >= severity('caution')) {
        this.tab = 'protocol';
        this.indicator = system.driver.def.id;
      }
      this.show();
    });
    store.events.on('data', (evaluation) => this.update(evaluation));
    store.events.on('interventions', () => this.update(store.evaluation));
    store.events.on('medicalPlan', () => this.update(store.evaluation));
    store.events.on('environment', () => this.update(store.evaluation));
    // The inventory changed: the resource check on each protocol may read differently now.
    resources.events.on('change', () => this.update(store.evaluation));
    // The live feed answers once, shortly after start: rebuild the view to show it.
    store.events.on('spaceWeather', () => this.show());
    this.show();
  }

  private open(tab: TabId, indicator: IndicatorId | null = this.indicator): void {
    this.tab = tab;
    this.indicator = indicator;
    this.show();
  }

  /** Rebuilds the current tab for the current selection. */
  private show(): void {
    const { store } = this;
    this.view?.dispose();
    const context: PanelContext = {
      store,
      actions: this.actions,
      resources: this.resources,
      openResources: this.openResources,
      system: store.selected,
      indicator: this.indicator,
      openTrend: (id) => this.open('trends', id),
      openProtocol: (id) => this.open('protocol', id),
      openSystem: (id) => this.openSystem(id),
    };
    this.view = this.tab === 'overview' ? new OverviewTab(context) : this.tab === 'trends' ? new TrendsTab(context) : new ProtocolTab(context);
    this.body.replaceChildren(this.view.element);
    this.body.scrollTop = 0;
    this.body.setAttribute('aria-labelledby', `panel-tab-${this.tab}`);
    this.tabButtons.forEach((button, i) => {
      const selected = TABS[i].id === this.tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.update(store.evaluation);
  }

  private openSystem(id: SystemId): void {
    this.indicator = null;
    if (this.store.selected === id) this.show();
    else this.store.select(id);
  }

  private update(evaluation: Evaluation): void {
    const { triage } = evaluation;
    const env = this.store.environment;
    this.triage.dataset.status = triage.status;
    setText(this.triageIcon, TRIAGE_ICON[triage.level]);
    setText(this.triageHeadline, triage.headline);
    setText(this.triageDetail, triage.detail);
    setText(this.triageLink, `${env.name} · signal to Earth takes ${formatDelay(env.commsDelaySec)} each way`);

    const selected = this.store.selected;
    this.back.hidden = !selected;
    setText(this.scopeName, selected ? evaluation.systems[selected].def.name : 'All body systems');
    this.scopeBadge.hidden = !selected;
    if (selected) updateBadge(this.scopeBadge, evaluation.systems[selected].status);
    this.view?.update(evaluation);
  }

  /** Arrow keys move between tabs, as in any tab list. */
  private onTabKey(event: KeyboardEvent): void {
    const current = TABS.findIndex((tab) => tab.id === this.tab);
    const next = event.key === 'ArrowRight' ? current + 1 : event.key === 'ArrowLeft' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next === -1 && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = (next + TABS.length) % TABS.length;
    this.open(TABS[index].id);
    this.tabButtons[index].focus();
  }
}
