import type { AppActions } from '../app/actions';
import type { HealthStore } from '../data/HealthStore';
import type { ResourceStore } from '../data/resources/ResourceStore';
import { formatDelay } from '../domain/catalog/environments';
import { INDICATORS } from '../domain/catalog/indicators';
import { severity } from '../domain/status';
import type { Evaluation, IndicatorId, SystemId } from '../domain/types';
import { openDialog, type Dialog } from './dialog';
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
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Right column, in the order the crew member asks: how am I (the triage verdict, always on
 * top), what changed and where (Overview), am I improving (Trends). The clinical detail,
 * protocol and evidence, is one step further: it opens in its own window from any alert,
 * indicator or trend, so it never crowds the first screen. Everything follows the body
 * system selected in 3D.
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
  /** The protocol window while it is open: it keeps following the live data. */
  private protocol: { tab: ProtocolTab; dialog: Dialog } | null = null;
  /** True when data arrived while the panel was not on screen: it is brought up to date when it returns. */
  private stale = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly store: HealthStore,
    private readonly actions: AppActions,
    private readonly resources: ResourceStore,
    private readonly openResources: () => void,
  ) {
    this.triage.append(
      this.triageIcon,
      h('div', null, h('span', { class: 'eyebrow' }, 'Status now'), this.triageHeadline, this.triageDetail, this.triageLink),
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
      // A system that needs attention opens on its overview: the alert and its first step are at the top.
      const system = id ? store.evaluation.systems[id] : null;
      if (system?.driver && severity(system.status) >= severity('caution')) this.tab = 'overview';
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

  /** Brings the panel up to date after it was off screen (another section was open). */
  refresh(): void {
    if (!this.stale) return;
    this.stale = false;
    this.update(this.store.evaluation);
  }

  /**
   * Protocol and evidence for one indicator (or a whole body system), in its own window.
   * It is the same Detect -> Treat -> Verify detail as before, moved out of the main tabs.
   */
  openProtocol(indicator: IndicatorId | null, system: SystemId | null = indicator ? INDICATORS[indicator].systemId : this.store.selected): void {
    this.protocol?.dialog.close();
    const tab = new ProtocolTab({
      store: this.store,
      actions: this.actions,
      resources: this.resources,
      openResources: () => {
        this.protocol?.dialog.close();
        this.openResources();
      },
      system,
      indicator,
      openTrend: (id) => {
        this.protocol?.dialog.close();
        this.open('trends', id);
      },
      openProtocol: (id) => this.openProtocol(id),
      openSystem: (id) => this.openProtocol(null, id),
    });
    const dialog = openDialog('Protocol and evidence', [tab.element], {
      wide: true,
      className: 'protocol-dialog',
      onClose: () => {
        tab.dispose();
        if (this.protocol?.tab === tab) this.protocol = null;
      },
    });
    this.protocol = { tab, dialog };
    tab.update(this.store.evaluation);
  }

  /** Opens the overview on a self-check's own card with its logging form ready. */
  startGuidedCheck(indicatorIds: IndicatorId[]): void {
    const first = indicatorIds[0];
    if (!first) return;
    const systemId = INDICATORS[first].systemId;
    this.tab = 'overview';
    this.indicator = null;
    if (this.store.selected === systemId) this.show();
    else this.store.select(systemId);
    const input = document.getElementById(`log-${first}`) as HTMLInputElement | null;
    const form = input?.closest('form');
    if (!input || !form) return;
    form.hidden = false;
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
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
      openProtocol: (id) => this.openProtocol(id),
      openSystem: (id) => this.openSystem(id),
    };
    this.view = this.tab === 'overview' ? new OverviewTab(context) : new TrendsTab(context);
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
    // Nobody is looking (another section is open): skip the work and catch up later.
    if (this.parent.offsetParent === null) {
      this.stale = true;
      return;
    }
    this.protocol?.tab.update(evaluation);
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
