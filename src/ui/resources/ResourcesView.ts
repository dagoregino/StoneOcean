import type { HealthStore } from '../../data/HealthStore';
import type { ResourceStore } from '../../data/resources/ResourceStore';
import { INDICATOR_RULES } from '../../domain/evidence/indicatorRules';
import { daysUntil } from '../../domain/resources/dates';
import { conditionOf, crewFindings, findingsFor, freeUnits, isUsable, WARNING_DAYS } from '../../domain/resources/findings';
import { PROCEDURES, procedureName } from '../../domain/resources/protocols';
import { READINESS_LABEL, type ProtocolReadiness, type StepReadiness } from '../../domain/resources/readiness';
import {
  AVAILABILITY_LABEL,
  CATEGORY_LABEL,
  CATEGORY_SHORT,
  isStock,
  LEVEL_GLYPH,
  LEVEL_RANK,
  MOVEMENT_LABEL,
  MOVEMENT_TYPES,
  RESOURCE_CATEGORIES,
  TRAINING_LABEL,
  TRAINING_RANK,
  type CrewMember,
  type Level,
  type Movement,
  type MovementType,
  type Resource,
  type ResourceAlert,
  type ResourceCategory,
} from '../../domain/resources/types';
import { severity } from '../../domain/status';
import type { IndicatorId } from '../../domain/types';
import { h } from '../dom';
import { openCrewForm, openImportDialog, openMovementDetail, openMovementForm, openResourceDetail, openResourceForm, openScanDialog, typeLabel } from './dialogs';
import { confirmDialog, formatDate, formatDateTime, icon, levelBadge, toast } from './kit';
import {
  ALERT_TOPIC_LABEL,
  ALERT_TOPICS,
  alertDate,
  alertTopic,
  daysText,
  findingDate,
  infoTip,
  initials,
  meter,
  movementIcon,
  movementSign,
  pendingOf,
  PROTOCOL_STATUS_LABEL,
  PROTOCOL_STATUS_LEVEL,
  PROTOCOL_STATUSES,
  protocolStatus,
  ring,
  segmentBar,
  STEP_KEY,
  type AlertTopic,
  type Part,
  type ProtocolStatus,
} from './visuals';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'movements', label: 'Movements' },
  { id: 'crew', label: 'Crew capabilities' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'readiness', label: 'Protocol readiness' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const READINESS_LEVEL: Record<StepReadiness, Level> = { ready: 'ok', ready_with_limits: 'attention', blocked: 'critical', needs_authorization: 'inactive', unspecified: 'inactive', no_resources: 'ok' };

/** The worst state of a protocol's steps, as one badge. */
export function protocolBadge(readiness: ProtocolReadiness): HTMLElement {
  const blocked = readiness.steps.filter((s) => s.readiness === 'blocked').length;
  const limited = readiness.steps.filter((s) => s.readiness === 'ready_with_limits').length;
  if (blocked > 0) return levelBadge('critical', `${blocked} step${blocked === 1 ? '' : 's'} blocked`);
  if (limited > 0) return levelBadge('attention', 'Ready, with limits');
  return levelBadge('ok', 'Ready');
}
export { READINESS_LEVEL };

/** Worst first: what cannot be done comes before what can. */
const STATUS_ORDER: Record<ProtocolStatus, number> = { blocked: 0, unknown: 1, limited: 2, ready: 3 };

/** Level words used everywhere in the module, so a color always comes with the same label. */
const LEVEL_WORD: Record<Level, string> = { ok: 'Ready', attention: 'Needs attention', critical: 'Not usable', inactive: 'Deactivated' };

const LOGISTICS_NOTE =
  'A check of logistics only. That something is on board does not mean using it is appropriate: that is decided by the protocol and the responsible medical staff.';
const SIMULATED_NOTE = 'Names, quantities, lots and storage notes are made up to show the module working. They are not a recommended kit for any mission.';

interface Filters {
  category: ResourceCategory | 'all';
  search: string;
  condition: 'all' | Level;
  sort: 'name' | 'quantity' | 'expiry';
  view: 'cards' | 'table';
  movementType: MovementType | 'all';
  movementSearch: string;
  procedure: string;
  showAcknowledged: boolean;
  alertLevel: 'all' | 'critical' | 'attention';
  alertTopic: 'all' | AlertTopic;
  openAlert: string | null;
  readinessStatus: 'all' | ProtocolStatus;
  openProtocols: string[];
}

/** A chip that filters: pressed state, optional icon and count. Its id keeps focus across re-renders. */
function filterChip(id: string, label: string, pressed: boolean, onclick: () => void, options: { count?: number; iconEl?: HTMLElement | null; level?: Level } = {}): HTMLButtonElement {
  return h(
    'button',
    { class: 'res-chip', id, type: 'button', 'aria-pressed': String(pressed), dataset: options.level ? { level: options.level } : undefined, onclick },
    options.iconEl ?? null,
    options.level ? h('span', { class: 'res-chip-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[options.level]) : null,
    label,
    options.count === undefined ? null : h('span', { class: 'res-chip-count' }, String(options.count)),
  );
}

/** A colored pill for a protocol's overall status: glyph and words, never color alone. */
const statusPill = (status: ProtocolStatus): HTMLElement => h('span', { class: 'res-status', dataset: { status } }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH[PROTOCOL_STATUS_LEVEL[status]]), PROTOCOL_STATUS_LABEL[status]);

/** One segment per step, colored by what the readiness engine found for it. */
function stepBar(readiness: ProtocolReadiness): HTMLElement {
  return h(
    'span',
    { class: 'res-steps', role: 'img', 'aria-label': readiness.steps.map((s) => `Step ${s.index + 1}: ${READINESS_LABEL[s.readiness]}`).join('. ') },
    ...readiness.steps.map((s) => h('span', { class: 'res-steps-part', dataset: { key: STEP_KEY[s.readiness] }, title: `Step ${s.index + 1}: ${READINESS_LABEL[s.readiness]}` })),
  );
}

/**
 * Medical Resources: what is on board, what state it is in, who can use it, and whether the
 * approved protocols can be carried out with it. Every number on it is read from the saved
 * inventory; the charts only draw those numbers.
 *
 * Each section shows a quick view first (numbers, bars, states); selecting something opens its
 * details; records, history and the engine's own sentences sit one level further in.
 */
export class ResourcesView {
  private section: SectionId = 'overview';
  private readonly body = h('div', { class: 'res-body', role: 'tabpanel', id: 'res-panel', tabIndex: -1 });
  private readonly tabs: HTMLButtonElement[];
  private readonly notice = h('div', { class: 'res-sim-notice' });
  private readonly filters: Filters = {
    category: 'all',
    search: '',
    condition: 'all',
    sort: 'name',
    view: 'cards',
    movementType: 'all',
    movementSearch: '',
    procedure: '',
    showAcknowledged: false,
    alertLevel: 'all',
    alertTopic: 'all',
    openAlert: null,
    readinessStatus: 'all',
    openProtocols: [],
  };

  constructor(
    parent: HTMLElement,
    private readonly store: ResourceStore,
    private readonly health: HealthStore,
    private readonly user: () => string,
  ) {
    this.tabs = SECTIONS.map((section) => h('button', { class: 'tab', type: 'button', role: 'tab', id: `res-tab-${section.id}`, 'aria-controls': 'res-panel', onclick: () => this.open(section.id) }, section.label));
    parent.append(
      h(
        'header',
        { class: 'res-head' },
        h('div', { class: 'res-head-left' }, h('div', { class: 'res-head-title' }, h('h2', null, 'Medical Resources'), infoTip('What is on board, what state it is in, and who is trained to use it.', 'About Medical Resources')), this.notice),
        h(
          'div',
          { class: 'res-head-actions' },
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openScanDialog(store, this.user()) }, icon('scan'), 'Find by code'),
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openImportDialog(store) }, 'Import / export'),
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openMovementForm(store, this.user()) }, 'Record movement'),
          h('button', { class: 'button', type: 'button', onclick: () => openResourceForm(store, undefined, this.filters.category === 'all' ? undefined : this.filters.category) }, '+ Register resource'),
        ),
      ),
      h('div', { class: 'tabs res-tabs', role: 'tablist', 'aria-label': 'Medical resources sections', onkeydown: (event: KeyboardEvent) => this.onTabKey(event) }, ...this.tabs),
      this.body,
    );
    store.events.on('change', () => this.render());
    health.events.on('medicalPlan', () => this.render());
    this.render();
  }

  open(section: SectionId, filters: Partial<Filters> = {}): void {
    this.section = section;
    Object.assign(this.filters, filters);
    this.render();
    this.body.scrollTop = 0;
  }

  /** Arrow keys move between sections, as in any tab list. */
  private onTabKey(event: KeyboardEvent): void {
    const current = SECTIONS.findIndex((s) => s.id === this.section);
    const next = event.key === 'ArrowRight' ? current + 1 : event.key === 'ArrowLeft' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const index = (next + SECTIONS.length) % SECTIONS.length;
    this.open(SECTIONS[index].id);
    this.tabs[index].focus();
  }

  private render(): void {
    const { store } = this;
    const alerts = store.ready ? store.alerts.length : 0;
    const blocked = store.ready && !store.error ? store.readinessOfAll(this.health.medicalPlan).filter((r) => protocolStatus(r) === 'blocked').length : 0;
    this.tabs.forEach((tab, i) => {
      const id = SECTIONS[i].id;
      const selected = id === this.section;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (id === 'alerts') tab.replaceChildren('Alerts', alerts > 0 ? h('span', { class: 'res-count' }, String(alerts)) : '');
      if (id === 'readiness') tab.replaceChildren('Protocol readiness', blocked > 0 ? h('span', { class: 'res-count', dataset: { level: 'critical' }, title: `${blocked} blocked` }, String(blocked)) : '');
    });
    this.notice.hidden = !store.hasSimulatedData;
    if (!this.notice.hidden && this.notice.childElementCount === 0) {
      this.notice.append(
        h('span', { class: 'res-sim-tag' }, 'Simulated'),
        h('span', null, 'Demonstration data'),
        infoTip(SIMULATED_NOTE, 'About the demonstration data'),
        h(
          'button',
          {
            class: 'link-button',
            type: 'button',
            onclick: () =>
              confirmDialog('Restore the demonstration data?', 'Everything registered on this device is erased, including the movement history, and the original demonstration records are loaded again.', 'Erase and restore', async () => {
                await store.resetDemo();
                toast('Demonstration data restored.');
              }),
          },
          'Restore demo data',
        ),
      );
    }
    if (!store.ready) return void this.body.replaceChildren(h('p', { class: 'empty' }, 'Loading the inventory…'));
    if (store.error) {
      return void this.body.replaceChildren(h('div', { class: 'res-error' }, h('strong', null, 'The inventory could not be opened on this device.'), h('p', null, store.error), h('p', null, 'Nothing has been lost. Check that the browser allows local storage for this page, then reload.')));
    }
    // Keep what the reader was typing or pressing: rebuild the results, not the control they are in.
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active && this.body.contains(active) ? active.id : '';
    const caret = focusId && 'selectionStart' in active! ? active!.selectionStart : null;
    const scroll = this.body.scrollTop;
    const views: Record<SectionId, () => HTMLElement[]> = {
      overview: () => this.overview(),
      inventory: () => this.inventory(),
      movements: () => this.movementsSection(),
      crew: () => this.crewSection(),
      alerts: () => this.alertsSection(),
      readiness: () => this.readinessSection(),
    };
    this.body.setAttribute('aria-labelledby', `res-tab-${this.section}`);
    this.body.replaceChildren(...views[this.section]());
    this.body.scrollTop = scroll;
    if (focusId) {
      const again = document.getElementById(focusId) as HTMLInputElement | null;
      again?.focus({ preventScroll: true });
      if (again && caret !== null) again.setSelectionRange?.(caret, caret);
    }
  }

  // ---------- Overview ----------

  private overview(): HTMLElement[] {
    const { store } = this;
    const now = store.today;
    const active = store.activeResources;
    const levels = active.map((r) => conditionOf(r, now).level);
    const byLevel = (level: Level): number => levels.filter((l) => l === level).length;
    const usable = active.filter((r) => isUsable(r, now)).length;
    const alerts = store.alerts;
    const subjects = (...kinds: string[]): number => new Set(alerts.filter((a) => kinds.includes(a.kind)).map((a) => a.subjectId)).size;
    const expired = subjects('expired');
    const readiness = this.orderedReadiness();
    const statusCount = (status: ProtocolStatus): number => readiness.filter((r) => protocolStatus(r) === status).length;
    const statusParts: Part[] = PROTOCOL_STATUSES.map((status) => ({ key: status, value: statusCount(status), label: PROTOCOL_STATUS_LABEL[status].toLowerCase() }));
    const healthParts: Part[] = (['ok', 'attention', 'critical'] as const).map((level) => ({ key: level, value: byLevel(level), label: LEVEL_WORD[level].toLowerCase() }));
    const deactivated = store.resources.length - active.length;
    const criticalAlerts = alerts.filter((a) => a.level === 'critical').length;

    const tile = (id: string, label: string, value: string, level: Level, onOpen: () => void, extra: { iconName?: Parameters<typeof icon>[0]; sub?: string | null; visual?: HTMLElement | null } = {}): HTMLElement =>
      h(
        'button',
        { class: 'res-kpi', id, type: 'button', dataset: { level }, onclick: onOpen },
        h('span', { class: 'res-kpi-label' }, extra.iconName ? icon(extra.iconName) : h('span', { class: 'res-kpi-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[level]), label),
        h('span', { class: 'res-kpi-value' }, value),
        extra.visual ?? null,
        extra.sub ? h('span', { class: 'res-kpi-sub' }, extra.sub) : null,
      );
    const lowStock = subjects('low_stock', 'out_of_stock', 'all_reserved');
    const expiring = subjects('expiring_soon', 'expired');
    const equipment = subjects('out_of_service', 'needs_attention', 'calibration_overdue', 'calibration_due', 'maintenance_overdue', 'maintenance_due', 'inspection_overdue', 'inspection_due', 'battery_low');
    const notUsable = byLevel('critical');
    const readyProtocols = statusCount('ready') + statusCount('limited');

    const kpis = h(
      'section',
      { class: 'res-kpis', 'aria-label': 'Summary' },
      tile('res-kpi-total', 'Total resources', String(active.length), 'ok', () => this.open('inventory', { category: 'all', condition: 'all' }), { iconName: 'all', sub: deactivated > 0 ? `${deactivated} deactivated` : null }),
      tile('res-kpi-usable', 'Available now', String(usable), 'ok', () => this.open('inventory', { category: 'all', condition: 'all' }), {
        visual: meter(usable, active.length, `${usable} of ${active.length} usable now`),
        sub: `of ${active.length}`,
      }),
      tile('res-kpi-low', 'Low stock', String(lowStock), lowStock > 0 ? 'attention' : 'ok', () => this.open('alerts', { alertTopic: 'stock', alertLevel: 'all' })),
      tile('res-kpi-critical', 'Not usable', String(notUsable), notUsable > 0 ? 'critical' : 'ok', () => this.open('inventory', { category: 'all', condition: 'critical' })),
      tile('res-kpi-expiry', 'Expiring', String(expiring), expiring > 0 ? 'attention' : 'ok', () => this.open('alerts', { alertTopic: 'expiry', alertLevel: 'all' }), { sub: expired > 0 ? `${expired} expired` : `≤ ${WARNING_DAYS.expiry} d` }),
      tile('res-kpi-maint', 'Maintenance due', String(equipment), equipment > 0 ? 'attention' : 'ok', () => this.open('alerts', { alertTopic: 'equipment', alertLevel: 'all' }), { iconName: 'device' }),
      tile('res-kpi-protocols', 'Protocols ready', `${readyProtocols}/${readiness.length}`, statusCount('blocked') > 0 ? 'critical' : 'ok', () => this.open('readiness', { readinessStatus: 'all' }), {
        visual: segmentBar(statusParts, 'Protocols'),
        sub: statusCount('blocked') > 0 ? `${statusCount('blocked')} blocked` : null,
      }),
      tile('res-kpi-alerts', 'Open alerts', String(alerts.length), criticalAlerts > 0 ? 'critical' : alerts.length > 0 ? 'attention' : 'ok', () => this.open('alerts', { alertTopic: 'all', alertLevel: 'all' }), {
        iconName: 'alert',
        sub: criticalAlerts > 0 ? `${criticalAlerts} critical` : null,
      }),
    );

    // Inventory health: one ring, then the same split per category.
    const legend = (parts: Part[], onPick: (key: string) => void, idPrefix: string): HTMLElement =>
      h(
        'ul',
        { class: 'res-legend' },
        ...parts.map((p) =>
          h(
            'li',
            null,
            h('button', { class: 'res-legend-item', id: `${idPrefix}-${p.key}`, type: 'button', dataset: { key: p.key }, onclick: () => onPick(p.key) }, h('span', { class: 'res-legend-dot', 'aria-hidden': 'true' }), h('span', null, p.label), h('strong', null, String(p.value))),
          ),
        ),
      );
    const healthCard = h(
      'section',
      { class: 'res-card res-panel' },
      h('header', { class: 'res-panel-head' }, h('h3', null, 'Inventory health'), infoTip('Active resources by their worst finding today: ready, needing attention (running low, coming due) or not usable (expired, out of stock, out of service).')),
      h(
        'div',
        { class: 'res-panel-split' },
        ring(healthParts, { value: String(usable), caption: `of ${active.length} usable` }, 'Inventory health'),
        legend(healthParts.map((p) => ({ ...p, label: LEVEL_WORD[p.key as Level] })), (key) => this.open('inventory', { category: 'all', condition: key as Level }), 'res-health'),
      ),
      h(
        'div',
        { class: 'res-cat-rows' },
        ...RESOURCE_CATEGORIES.map((category) => {
          const items = active.filter((r) => r.category === category);
          const parts: Part[] = (['ok', 'attention', 'critical'] as const).map((level) => ({ key: level, value: items.filter((r) => conditionOf(r, now).level === level).length, label: LEVEL_WORD[level].toLowerCase() }));
          return h(
            'button',
            { class: 'res-cat-row', id: `res-cat-${category}`, type: 'button', onclick: () => this.open('inventory', { category, condition: 'all' }) },
            h('span', { class: 'res-cat-name' }, icon(category), CATEGORY_SHORT[category]),
            segmentBar(parts, CATEGORY_LABEL[category]),
            h('span', { class: 'res-cat-total' }, String(items.length)),
          );
        }),
      ),
    );

    const readinessCard = h(
      'section',
      { class: 'res-card res-panel' },
      h(
        'header',
        { class: 'res-panel-head' },
        h('h3', null, 'Protocol readiness'),
        readiness.length > 6 ? h('button', { class: 'link-button', type: 'button', onclick: () => this.open('readiness', { readinessStatus: 'all' }) }, `All ${readiness.length} →`) : null,
        infoTip(LOGISTICS_NOTE),
      ),
      h(
        'div',
        { class: 'res-panel-split' },
        ring(statusParts, { value: `${readyProtocols}/${readiness.length}`, caption: 'can be done' }, 'Protocol readiness'),
        legend(statusParts.map((p) => ({ ...p, label: PROTOCOL_STATUS_LABEL[p.key as ProtocolStatus] })), (key) => this.open('readiness', { readinessStatus: key as ProtocolStatus }), 'res-ready'),
      ),
      h(
        'ul',
        { class: 'res-proto-mini' },
        ...[...readiness]
          .sort((a, b) => STATUS_ORDER[protocolStatus(a)] - STATUS_ORDER[protocolStatus(b)])
          .slice(0, 6)
          .map((r) =>
          h(
            'li',
            null,
            h(
              'button',
              { class: 'res-proto-mini-row', id: `res-mini-${r.ruleId}`, type: 'button', onclick: () => this.open('readiness', { readinessStatus: 'all', openProtocols: [...new Set([...this.filters.openProtocols, r.ruleId])] }) },
              h('span', { class: 'res-proto-mini-name', title: r.condition }, this.isActiveRule(r.ruleId) ? h('span', { class: 'res-live-dot', title: 'Active now', 'aria-label': 'Active now' }) : null, r.condition),
              stepBar(r),
              statusPill(protocolStatus(r)),
            ),
          ),
        ),
      ),
    );

    const top = alerts.slice(0, 6);
    const attentionCard = h(
      'section',
      { class: 'res-card res-panel' },
      h('header', { class: 'res-panel-head' }, h('h3', null, 'Needs attention first'), alerts.length > top.length ? h('button', { class: 'link-button', type: 'button', onclick: () => this.open('alerts', { alertTopic: 'all', alertLevel: 'all' }) }, `All ${alerts.length} →`) : null),
      top.length === 0
        ? h('p', { class: 'res-allclear' }, levelBadge('ok', 'All clear'), ' Nothing needs attention.')
        : h('ul', { class: 'res-alert-mini' }, ...top.map((alert) => h('li', null, this.alertMini(alert)))),
    );

    return [kpis, h('div', { class: 'res-overview-grid' }, healthCard, readinessCard, attentionCard)];
  }

  /** One alert in a single line: glyph, short label, subject and its date. Opens the record. */
  private alertMini(alert: ResourceAlert): HTMLElement {
    const date = alertDate(alert, this.store);
    return h(
      'button',
      { class: 'res-alert-mini-row', type: 'button', dataset: { level: alert.level }, title: alert.message, onclick: () => this.openAlertSubject(alert) },
      h('span', { class: 'res-alert-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[alert.level]),
      h('span', { class: 'res-alert-mini-text' }, h('strong', null, alert.label), h('span', null, alert.subjectName)),
      date ? h('span', { class: 'res-when' }, daysText(daysUntil(date, this.store.today))) : null,
    );
  }

  private openAlertSubject(alert: ResourceAlert): void {
    if (alert.subject === 'resource') openResourceDetail(this.store, this.user(), alert.subjectId);
    else this.open('crew');
  }

  /** Rules whose indicators are in caution or critical right now, according to the triage engine. */
  private activeRuleIds(): Set<string> {
    const ids = new Set<string>();
    for (const system of Object.values(this.health.evaluation.systems)) {
      for (const indicator of system.indicators) {
        if (severity(indicator.status) >= severity('caution')) ids.add(INDICATOR_RULES[indicator.def.id as IndicatorId].ruleId);
      }
    }
    return ids;
  }

  private isActiveRule(ruleId: string): boolean {
    return this.activeRuleIds().has(ruleId);
  }

  /** Every protocol checked by the readiness engine, the ones active now first. */
  private orderedReadiness(): ProtocolReadiness[] {
    const active = this.activeRuleIds();
    return [...this.store.readinessOfAll(this.health.medicalPlan)].sort((a, b) => Number(active.has(b.ruleId)) - Number(active.has(a.ruleId)));
  }

  // ---------- Inventory ----------

  private inventory(): HTMLElement[] {
    const { store, filters } = this;
    const now = store.today;
    const term = filters.search.trim().toLowerCase();
    const inCategory = store.resources.filter((r) => filters.category === 'all' || r.category === filters.category);
    const matching = inCategory
      .filter((r) => !term || r.name.toLowerCase().includes(term) || r.id.toLowerCase().includes(term) || (r.lot ?? '').toLowerCase().includes(term))
      .map((r) => ({ r, condition: conditionOf(r, now) }));
    const rows = matching
      .filter(({ condition }) => (filters.condition === 'all' ? condition.level !== 'inactive' || filters.search !== '' : condition.level === filters.condition))
      .sort((a, b) => {
        if (filters.sort === 'quantity') return freeUnits(a.r) - freeUnits(b.r) || a.r.name.localeCompare(b.r.name);
        if (filters.sort === 'expiry') return (a.r.expiresOn ?? '9999').localeCompare(b.r.expiresOn ?? '9999') || a.r.name.localeCompare(b.r.name);
        return a.r.name.localeCompare(b.r.name);
      });

    const search = h('input', { id: 'res-search', class: 'res-input res-search', type: 'search', placeholder: 'Search name, ID or lot', value: filters.search, 'aria-label': 'Search the inventory' });
    search.addEventListener('input', () => {
      filters.search = search.value;
      this.render();
    });
    const sort = h('select', { class: 'res-input', id: 'res-sort', 'aria-label': 'Sort by' }, h('option', { value: 'name' }, 'Name'), h('option', { value: 'quantity' }, 'Lowest quantity'), h('option', { value: 'expiry' }, 'Earliest expiry'));
    sort.value = filters.sort;
    sort.addEventListener('change', () => {
      filters.sort = sort.value as Filters['sort'];
      this.render();
    });
    const set = (patch: Partial<Filters>) => (): void => {
      Object.assign(filters, patch);
      this.render();
    };
    const levelCount = (level: Level): number => matching.filter(({ condition }) => condition.level === level).length;

    return [
      h(
        'div',
        { class: 'res-chips', role: 'group', 'aria-label': 'Category' },
        ...(['all', ...RESOURCE_CATEGORIES] as const).map((c) =>
          filterChip(`res-chip-cat-${c}`, c === 'all' ? 'All' : CATEGORY_SHORT[c], filters.category === c, set({ category: c }), { iconEl: icon(c), count: store.activeResources.filter((r) => c === 'all' || r.category === c).length }),
        ),
      ),
      h(
        'div',
        { class: 'res-toolbar' },
        search,
        h(
          'div',
          { class: 'res-chips res-chips-tight', role: 'group', 'aria-label': 'State' },
          filterChip('res-chip-cond-all', 'All active', filters.condition === 'all', set({ condition: 'all' })),
          ...(['ok', 'attention', 'critical', 'inactive'] as const).map((level) => filterChip(`res-chip-cond-${level}`, LEVEL_WORD[level], filters.condition === level, set({ condition: level }), { level, count: levelCount(level) })),
        ),
        h('span', { class: 'res-spacer' }),
        h('label', { class: 'res-inline-label', for: 'res-sort' }, 'Sort', sort),
        h(
          'div',
          { class: 'segmented res-view-switch', role: 'group', 'aria-label': 'Layout' },
          h('button', { class: 'segment', id: 'res-view-cards', type: 'button', 'aria-pressed': String(filters.view === 'cards'), onclick: set({ view: 'cards' }) }, 'Cards'),
          h('button', { class: 'segment', id: 'res-view-table', type: 'button', 'aria-pressed': String(filters.view === 'table'), onclick: set({ view: 'table' }) }, 'Table'),
        ),
      ),
      rows.length === 0
        ? h('p', { class: 'empty res-empty' }, store.resources.length === 0 ? 'No resources registered yet. Use “Register resource” or import a file.' : 'No resources match. Clear the search or change the filters.')
        : filters.view === 'cards'
          ? h('div', { class: 'res-item-grid' }, ...rows.map(({ r }) => this.resourceCard(r)))
          : this.inventoryTable(rows.map(({ r }) => r)),
      h('p', { class: 'res-count-line' }, `${rows.length} shown`, infoTip('“Free” is what can be used now: units on board minus units reserved. The bar shows free units of those on board; the tick marks the minimum stock.')),
    ];
  }

  /** The one thing worth seeing at a glance for a record: its worst finding with its date, or what comes next. */
  private indicatorOf(resource: Resource): { text: string; level: Level } | null {
    const now = this.store.today;
    const worst = findingsFor(resource, now).sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1))[0];
    if (worst) {
      const date = findingDate(resource, worst.kind);
      const extra = worst.kind === 'battery_low' ? ` · ${resource.batteryPct}%` : date ? ` · ${daysText(daysUntil(date, now))}` : '';
      return { text: `${worst.label}${extra}`, level: worst.level };
    }
    if (!resource.active) return null;
    if (resource.expiresOn) return { text: `Expires ${daysText(daysUntil(resource.expiresOn, now))}`, level: 'ok' };
    const next = [
      ['Calibration', resource.nextCalibration],
      ['Inspection', resource.nextInspection],
      ['Maintenance', resource.nextMaintenance],
    ]
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .sort((a, b) => a[1].localeCompare(b[1]))[0];
    return next ? { text: `${next[0]} ${daysText(daysUntil(next[1], now))}`, level: 'ok' } : null;
  }

  /** Quick view of one record: name, category, how many are free, its state and one indicator. */
  private resourceCard(r: Resource): HTMLElement {
    const now = this.store.today;
    const condition = conditionOf(r, now);
    const stock = isStock(r.category);
    const free = freeUnits(r);
    const indicator = this.indicatorOf(r);
    const quantity = stock
      ? h(
          'div',
          { class: 'res-item-qty' },
          h('span', { class: 'res-item-num' }, h('strong', null, String(free)), ` / ${r.quantity} ${r.unit}`),
          meter(free, r.quantity, `${free} of ${r.quantity} ${r.unit} free${r.minStock !== null ? `, minimum ${r.minStock}` : ''}`, { key: condition.level, marker: r.minStock }),
        )
      : h(
          'div',
          { class: 'res-item-qty' },
          h('span', { class: 'res-item-num' }, h('strong', null, String(r.quantity)), ` ${r.quantity === 1 ? 'unit' : 'units'}`),
          typeof r.batteryPct === 'number' ? meter(r.batteryPct, 100, `Battery ${r.batteryPct}%`, { key: r.batteryPct < 20 ? 'attention' : 'ok' }) : null,
        );
    return h(
      'article',
      { class: 'res-item', dataset: { level: condition.level } },
      h(
        'button',
        { class: 'res-item-main', id: `res-item-${r.id}`, type: 'button', 'aria-label': `${r.name}, ${CATEGORY_SHORT[r.category]}, ${condition.label}. Open details.`, onclick: () => openResourceDetail(this.store, this.user(), r.id) },
        h('span', { class: 'res-item-top' }, h('span', { class: 'res-item-cat', dataset: { category: r.category } }, icon(r.category), CATEGORY_SHORT[r.category]), levelBadge(condition.level, condition.label)),
        h('span', { class: 'res-item-name' }, r.name),
        quantity,
        indicator ? h('span', { class: 'res-item-ind', dataset: { level: indicator.level } }, indicator.text) : h('span', { class: 'res-item-ind' }, ' '),
      ),
      h(
        'footer',
        { class: 'res-item-foot' },
        h('span', { class: 'res-id' }, r.id, r.simulated ? h('span', { class: 'res-sim-dot', title: 'Simulated record', 'aria-label': 'simulated' }) : null),
        r.active ? h('button', { class: 'button button-quiet button-small', type: 'button', 'aria-label': `Record a movement for ${r.name}`, onclick: () => openMovementForm(this.store, this.user(), { resourceId: r.id }) }, 'Move') : null,
      ),
    );
  }

  /** The detailed table, kept as an alternative layout: every column the inventory had before. */
  private inventoryTable(resources: Resource[]): HTMLElement {
    const { store, filters } = this;
    const now = store.today;
    const category = filters.category;
    const columns: { head: string; num?: boolean; cell: (r: Resource) => string | HTMLElement }[] = [
      { head: 'Name', cell: (r) => h('span', { class: 'res-name' }, h('strong', null, r.name), h('span', { class: 'res-id' }, r.id, r.simulated ? ' · simulated' : '')) },
    ];
    if (category === 'all') columns.push({ head: 'Category', cell: (r) => CATEGORY_SHORT[r.category] });
    columns.push({ head: category === 'device' || category === 'emergency' ? 'Units' : 'Free / on board', num: true, cell: (r) => (isStock(r.category) ? `${freeUnits(r)} / ${r.quantity} ${r.unit}` : `${r.quantity}`) });
    if (category === 'pharmaceutical') columns.push({ head: 'Lot', cell: (r) => r.lot ?? '—' });
    if (category === 'consumable') columns.push({ head: 'Minimum', num: true, cell: (r) => (r.minStock === null ? '—' : String(r.minStock)) });
    if (category === 'pharmaceutical' || category === 'consumable' || category === 'all') columns.push({ head: 'Expires', cell: (r) => formatDate(r.expiresOn) });
    if (category === 'pharmaceutical') columns.push({ head: 'Storage', cell: (r) => r.storage ?? '—' });
    if (category === 'device') {
      columns.push({ head: 'Brand and model', cell: (r) => [r.brand, r.model].filter(Boolean).join(' ') || '—' });
      columns.push({ head: 'Battery', num: true, cell: (r) => (typeof r.batteryPct === 'number' ? `${r.batteryPct}%` : '—') });
      columns.push({ head: 'Last maintenance', cell: (r) => formatDate(r.lastMaintenance) });
      columns.push({ head: 'Next calibration', cell: (r) => formatDate(r.nextCalibration) });
    }
    if (category === 'emergency') {
      columns.push({ head: 'Last inspection', cell: (r) => formatDate(r.lastInspection) });
      columns.push({ head: 'Next inspection', cell: (r) => formatDate(r.nextInspection) });
    }
    columns.push({ head: 'Location', cell: (r) => r.location });
    return h(
      'div',
      { class: 'res-table-wrap res-card' },
      h(
        'table',
        { class: 'res-table' },
        h('thead', null, h('tr', null, ...columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.head)), h('th', null, 'State'), h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
        h(
          'tbody',
          null,
          ...resources.map((r) => {
            const condition = conditionOf(r, now);
            return h(
              'tr',
              { class: r.active ? '' : 'is-inactive' },
              ...columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.cell(r))),
              h('td', null, levelBadge(condition.level, condition.label)),
              h(
                'td',
                { class: 'res-actions' },
                r.active ? h('button', { class: 'button button-quiet button-small', type: 'button', 'aria-label': `Record a movement for ${r.name}`, onclick: () => openMovementForm(store, this.user(), { resourceId: r.id }) }, 'Move') : null,
                h('button', { class: 'button button-quiet button-small', type: 'button', 'aria-label': `Details of ${r.name}`, onclick: () => openResourceDetail(store, this.user(), r.id) }, 'Details'),
              ),
            );
          }),
        ),
      ),
    );
  }

  // ---------- Movements: a timeline ----------

  private movementsSection(): HTMLElement[] {
    const { store, filters } = this;
    const term = filters.movementSearch.trim().toLowerCase();
    const searched = store.movements.filter((m) => !term || `${m.resourceName} ${m.resourceId} ${m.user} ${m.reason}`.toLowerCase().includes(term));
    const rows = searched.filter((m) => filters.movementType === 'all' || m.type === filters.movementType);
    const search = h('input', { id: 'res-move-search', class: 'res-input res-search', type: 'search', placeholder: 'Search resource, person or reason', value: filters.movementSearch, 'aria-label': 'Search movements' });
    search.addEventListener('input', () => {
      filters.movementSearch = search.value;
      this.render();
    });
    const pick = (type: Filters['movementType']) => (): void => {
      filters.movementType = type;
      this.render();
    };

    // Newest first, grouped by calendar day.
    const dayKey = (iso: string): string => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const today = dayKey(new Date().toISOString());
    const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
    const dayLabel = (key: string): string => (key === today ? 'Today' : key === yesterday ? 'Yesterday' : formatDate(key));
    const groups = new Map<string, Movement[]>();
    for (const m of rows.slice(0, 300)) {
      const key = dayKey(m.at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    const time = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    return [
      h(
        'div',
        { class: 'res-chips', role: 'group', 'aria-label': 'Type of movement' },
        filterChip('res-mchip-all', 'All', filters.movementType === 'all', pick('all'), { count: searched.length }),
        ...MOVEMENT_TYPES.map((t) => filterChip(`res-mchip-${t}`, MOVEMENT_LABEL[t], filters.movementType === t, pick(t), { iconEl: movementIcon(t), count: searched.filter((m) => m.type === t).length })),
      ),
      h('div', { class: 'res-toolbar' }, search, h('span', { class: 'res-spacer' }), h('button', { class: 'button', type: 'button', onclick: () => openMovementForm(store, this.user()) }, 'Record movement')),
      rows.length === 0
        ? h('p', { class: 'empty res-empty' }, store.movements.length === 0 ? 'No movements recorded yet.' : 'No movements match.')
        : h(
            'div',
            { class: 'res-timeline' },
            ...[...groups].map(([key, list]) =>
              h(
                'section',
                { class: 'res-day' },
                h('h3', { class: 'res-day-head' }, dayLabel(key), h('span', null, `${list.length}`)),
                h(
                  'ol',
                  { class: 'res-day-list' },
                  ...list.map((m) => {
                    const unit = store.resource(m.resourceId)?.unit ?? '';
                    return h(
                      'li',
                      null,
                      h(
                        'button',
                        { class: 'res-tl-item', id: `res-tl-${m.id}`, type: 'button', dataset: { type: m.type }, onclick: () => openMovementDetail(store, this.user(), m.id), 'aria-label': `${MOVEMENT_LABEL[m.type]}, ${m.resourceName}, ${movementSign(m.type)}${m.quantity} ${unit}, ${formatDateTime(m.at)} by ${m.user}. Open details.` },
                        movementIcon(m.type),
                        h('span', { class: 'res-tl-main' }, h('strong', null, m.resourceName), h('span', { class: 'res-tl-type' }, MOVEMENT_LABEL[m.type])),
                        h('span', { class: 'res-tl-qty', dataset: { type: m.type } }, `${movementSign(m.type)}${m.quantity}`, h('small', null, ` ${unit}`)),
                        h('span', { class: 'res-tl-after', title: 'On board after this movement' }, `→ ${m.balance.quantity}`),
                        h('span', { class: 'res-tl-meta' }, h('span', { class: 'res-avatar res-avatar-sm', title: m.user, 'aria-hidden': 'true' }, initials(m.user)), time(m.at)),
                      ),
                    );
                  }),
                ),
              ),
            ),
          ),
      h(
        'p',
        { class: 'res-count-line' },
        `${rows.length} movement${rows.length === 1 ? '' : 's'}${rows.length > 300 ? ' · newest 300 shown' : ''}`,
        infoTip('The history is a record: movements are added, never edited or removed. To correct a mistake, record the opposite movement and say why. Select a movement to see who recorded it, why, and the count after it.'),
      ),
    ];
  }

  // ---------- Crew ----------

  private crewSection(): HTMLElement[] {
    const { store, filters } = this;
    const now = store.today;
    const crew = store.crew;
    const inDate = (expiresOn?: string): boolean => !expiresOn || daysUntil(expiresOn, now) >= 0;
    const certState = (expiresOn?: string): Level => {
      if (!expiresOn) return 'ok';
      const days = daysUntil(expiresOn, now);
      return days < 0 ? 'critical' : days <= WARNING_DAYS.certification ? 'attention' : 'ok';
    };
    const allCerts = crew.flatMap((m) => m.certifications);
    const expiring = allCerts.filter((c) => certState(c.expiresOn) === 'attention').length;
    const expired = allCerts.filter((c) => certState(c.expiresOn) === 'critical').length;
    const available = crew.filter((m) => m.availability === 'available').length;

    const stat = (label: string, value: number, level: Level): HTMLElement => h('div', { class: 'res-mini-stat', dataset: { level } }, h('strong', null, String(value)), h('span', null, label));
    const dots = (rank: number): HTMLElement => h('span', { class: 'res-dots', 'aria-hidden': 'true' }, ...[1, 2, 3].map((n) => h('span', { class: n <= rank ? 'is-on' : '' })));
    const availabilityLevel = (member: CrewMember): Level => (member.availability === 'available' ? 'ok' : member.availability === 'off_duty' ? 'attention' : 'inactive');

    // Coverage matrix: procedures down, crew across. A cell is the level held and whether it is in date.
    const matrix = h(
      'div',
      { class: 'res-matrix-wrap' },
      h(
        'table',
        { class: 'res-matrix' },
        h('caption', { class: 'sr-only' }, 'Training coverage: who holds a certification for each procedure, at what level, and whether it is in date. Select a procedure to see who can do it now.'),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Procedure'),
            ...crew.map((member) =>
              h('th', { scope: 'col', title: `${member.name} · ${member.role} · ${AVAILABILITY_LABEL[member.availability]}` }, h('span', { class: 'res-avatar', dataset: { level: availabilityLevel(member) } }, initials(member.name)), h('span', { class: 'res-matrix-name' }, member.name.split(' ').slice(-1)[0])),
            ),
            h('th', { scope: 'col' }, 'Can do now'),
          ),
        ),
        h(
          'tbody',
          null,
          ...PROCEDURES.map((procedure) => {
            const qualified = crew.filter((m) => m.availability === 'available' && m.certifications.some((c) => c.procedureCode === procedure.code && inDate(c.expiresOn)));
            const selected = filters.procedure === procedure.code;
            return h(
              'tr',
              { class: selected ? 'is-selected' : '' },
              h(
                'th',
                { scope: 'row' },
                h(
                  'button',
                  {
                    class: 'res-matrix-proc',
                    id: `res-proc-${procedure.code}`,
                    type: 'button',
                    'aria-pressed': String(selected),
                    onclick: () => {
                      filters.procedure = selected ? '' : procedure.code;
                      this.render();
                    },
                  },
                  procedure.name,
                ),
              ),
              ...crew.map((member) => {
                const cert = member.certifications.find((c) => c.procedureCode === procedure.code);
                if (!cert) return h('td', { class: 'res-matrix-cell is-empty' }, h('span', { class: 'sr-only' }, `${member.name}: not trained`), h('span', { 'aria-hidden': 'true' }, '·'));
                const state = certState(cert.expiresOn);
                const validity = cert.expiresOn ? `${state === 'critical' ? 'expired' : 'valid until'} ${formatDate(cert.expiresOn)}` : 'does not lapse';
                return h(
                  'td',
                  { class: 'res-matrix-cell', dataset: { level: state }, title: `${member.name}: ${TRAINING_LABEL[cert.level]} · ${validity}` },
                  dots(TRAINING_RANK[cert.level]),
                  h('span', { class: 'sr-only' }, `${member.name}: ${TRAINING_LABEL[cert.level]}, ${validity}`),
                  state !== 'ok' ? h('span', { class: 'res-cell-flag', 'aria-hidden': 'true' }, LEVEL_GLYPH[state]) : null,
                );
              }),
              h('td', { class: 'res-matrix-count', dataset: { level: qualified.length === 0 ? 'critical' : qualified.length === 1 ? 'attention' : 'ok' } }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH[qualified.length === 0 ? 'critical' : qualified.length === 1 ? 'attention' : 'ok']), ` ${qualified.length}`),
            );
          }),
        ),
      ),
    );

    // "Who can do it?": the holders of the selected procedure, as before.
    const holders = filters.procedure
      ? crew
          .map((member) => ({ member, cert: member.certifications.find((c) => c.procedureCode === filters.procedure) }))
          .filter((entry): entry is { member: CrewMember; cert: NonNullable<typeof entry.cert> } => Boolean(entry.cert))
          .sort((a, b) => TRAINING_RANK[b.cert.level] - TRAINING_RANK[a.cert.level])
      : [];
    const who = filters.procedure
      ? h(
          'section',
          { class: 'res-card res-who', 'aria-live': 'polite' },
          h('header', { class: 'res-panel-head' }, h('h3', null, `Who can do it · ${procedureName(filters.procedure)}`), h('button', { class: 'link-button', type: 'button', onclick: () => ((filters.procedure = ''), this.render()) }, 'Clear')),
          holders.length === 0
            ? h('p', { class: 'res-none' }, levelBadge('critical', 'Nobody'), ' No one on the roster holds this certification.')
            : h(
                'ul',
                { class: 'res-holder-list' },
                ...holders.map(({ member, cert }) => {
                  const current = inDate(cert.expiresOn);
                  const ok = current && member.availability === 'available';
                  return h(
                    'li',
                    null,
                    h('span', { class: 'res-avatar', dataset: { level: availabilityLevel(member) } }, initials(member.name)),
                    h('span', { class: 'res-holder-text' }, h('strong', null, member.name), h('span', null, `${member.role} · ${TRAINING_LABEL[cert.level]}`)),
                    levelBadge(ok ? 'ok' : current ? 'attention' : 'critical', !current ? `Expired ${formatDate(cert.expiresOn)}` : member.availability === 'available' ? 'Available now' : AVAILABILITY_LABEL[member.availability]),
                  );
                }),
              ),
        )
      : null;

    return [
      h(
        'div',
        { class: 'res-mini-stats' },
        stat('crew', crew.length, 'ok'),
        stat('available now', available, available === 0 ? 'critical' : 'ok'),
        stat('certifications expiring', expiring, expiring > 0 ? 'attention' : 'ok'),
        stat('expired', expired, expired > 0 ? 'critical' : 'ok'),
        h('span', { class: 'res-spacer' }),
        h('button', { class: 'button', type: 'button', onclick: () => openCrewForm(store) }, '+ Add crew member'),
      ),
      crew.length === 0
        ? h('p', { class: 'empty res-empty' }, 'No crew members registered.')
        : h(
            'section',
            { class: 'res-card' },
            h(
              'header',
              { class: 'res-panel-head' },
              h('h3', null, 'Training coverage'),
              h('span', { class: 'res-matrix-key', 'aria-hidden': 'true' }, dots(1), 'Awareness', dots(2), 'Operator', dots(3), 'Advanced'),
              infoTip('Each dot row is the level held: awareness (can assist), operator (can perform), advanced (can lead and teach). ▲ expires within 30 days, ◆ expired. “Can do now” counts people available now with a certification in date. Select a procedure to see who holds it.'),
            ),
            matrix,
          ),
      who,
      h(
        'div',
        { class: 'res-crew-grid' },
        ...crew.map((member) => {
          const findings = crewFindings(member, now, procedureName);
          return h(
            'article',
            { class: 'res-card res-crew' },
            h(
              'header',
              null,
              h('span', { class: 'res-avatar res-avatar-lg', dataset: { level: availabilityLevel(member) } }, initials(member.name)),
              h('div', { class: 'res-crew-id' }, h('h4', null, member.name), h('p', null, member.role, member.simulated ? h('span', { class: 'res-sim-dot', title: 'Simulated record', 'aria-label': 'simulated' }) : null)),
              levelBadge(availabilityLevel(member), AVAILABILITY_LABEL[member.availability]),
            ),
            member.certifications.length === 0
              ? h('p', { class: 'empty' }, 'No medical training on record.')
              : h(
                  'ul',
                  { class: 'res-cert-chips' },
                  ...member.certifications.map((cert) => {
                    const state = certState(cert.expiresOn);
                    const days = cert.expiresOn ? daysUntil(cert.expiresOn, now) : null;
                    return h(
                      'li',
                      { dataset: { level: state }, title: `${procedureName(cert.procedureCode)} · ${TRAINING_LABEL[cert.level]} · ${cert.expiresOn ? `${days! < 0 ? 'expired' : 'valid until'} ${formatDate(cert.expiresOn)}` : 'does not lapse'}` },
                      dots(TRAINING_RANK[cert.level]),
                      h('span', { class: 'res-cert-chip-name' }, procedureName(cert.procedureCode)),
                      state !== 'ok' && days !== null ? h('span', { class: 'res-cert-chip-when' }, `${LEVEL_GLYPH[state]} ${daysText(days)}`) : null,
                    );
                  }),
                ),
            h(
              'footer',
              { class: 'res-crew-foot' },
              findings.length > 0 ? h('span', { class: 'res-crew-flag' }, `${findings.length} to renew`) : h('span', { class: 'res-id' }, `${member.certifications.length} certification${member.certifications.length === 1 ? '' : 's'}`),
              h('button', { class: 'button button-quiet button-small', type: 'button', 'aria-label': `Edit ${member.name}`, onclick: () => openCrewForm(store, member) }, 'Edit'),
            ),
          );
        }),
      ),
    ].filter((el): el is HTMLElement => el !== null);
  }

  // ---------- Alerts ----------

  private alertsSection(): HTMLElement[] {
    const { store, filters } = this;
    const now = store.today;
    const all = store.allAlerts;
    const pool = filters.showAcknowledged ? all : all.filter((a) => !store.isAcknowledged(a.id));
    const shown = pool.filter((a) => (filters.alertLevel === 'all' || a.level === filters.alertLevel) && (filters.alertTopic === 'all' || alertTopic(a.kind) === filters.alertTopic));
    const acknowledged = all.length - store.alerts.length;
    const set = (patch: Partial<Filters>) => (): void => {
      Object.assign(filters, patch);
      this.render();
    };
    const toggle = h('input', { type: 'checkbox', id: 'res-show-ack', checked: filters.showAcknowledged });
    toggle.addEventListener('change', () => {
      filters.showAcknowledged = toggle.checked;
      this.render();
    });
    const count = (level: 'critical' | 'attention'): number => pool.filter((a) => a.level === level).length;
    const topicCount = (topic: AlertTopic): number => pool.filter((a) => alertTopic(a.kind) === topic).length;
    const topicIcon = (topic: AlertTopic): HTMLElement => icon(topic === 'stock' ? 'consumable' : topic === 'expiry' ? 'pharmaceutical' : topic === 'equipment' ? 'device' : 'crew');

    const row = (alert: ResourceAlert): HTMLElement => {
      const seen = store.isAcknowledged(alert.id);
      const open = filters.openAlert === alert.id;
      const date = alertDate(alert, store);
      const panelId = `res-alert-detail-${alert.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
      return h(
        'li',
        { class: `res-alert-row${seen ? ' is-seen' : ''}${open ? ' is-open' : ''}`, dataset: { level: alert.level } },
        h(
          'button',
          {
            class: 'res-alert-main',
            id: `res-alert-${alert.id.replace(/[^A-Za-z0-9-]/g, '-')}`,
            type: 'button',
            'aria-expanded': String(open),
            'aria-controls': panelId,
            onclick: () => {
              filters.openAlert = open ? null : alert.id;
              this.render();
            },
          },
          h('span', { class: 'res-alert-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[alert.level]),
          h('span', { class: 'res-alert-label' }, alert.label, h('span', { class: 'sr-only' }, ` (${alert.level === 'critical' ? 'critical' : 'needs attention'})`)),
          h('span', { class: 'res-alert-subject' }, alert.subjectName),
          h('span', { class: 'res-alert-topic' }, topicIcon(alertTopic(alert.kind)), alert.subject === 'crew' ? 'Crew' : CATEGORY_SHORT[alert.category!]),
          h('span', { class: 'res-when' }, date ? daysText(daysUntil(date, now)) : ''),
          seen ? h('span', { class: 'res-seen-tag' }, 'Acknowledged') : null,
          h('span', { class: 'res-chevron', 'aria-hidden': 'true' }),
        ),
        h(
          'div',
          { class: 'res-alert-detail', id: panelId, hidden: !open },
          h('p', null, alert.message),
          h('p', { class: 'res-id' }, alert.subject === 'crew' ? `Crew certification · ${alert.subjectId}` : `${alert.subjectId} · ${CATEGORY_LABEL[alert.category!]}`, date ? ` · ${formatDate(date)}` : '', alert.blocksUse ? ' · blocks use in protocols' : ''),
          h(
            'div',
            { class: 'res-actions' },
            alert.subject === 'resource'
              ? h('button', { class: 'button button-small', type: 'button', onclick: () => openResourceDetail(store, this.user(), alert.subjectId) }, 'Open record')
              : h('button', { class: 'button button-small', type: 'button', onclick: () => this.open('crew') }, 'Open roster'),
            h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => void store.acknowledge(alert.id, !seen) }, seen ? 'Mark as open' : 'Acknowledge'),
          ),
        ),
      );
    };

    return [
      h(
        'div',
        { class: 'res-alert-summary' },
        h('button', { class: 'res-sev', id: 'res-sev-critical', type: 'button', dataset: { level: 'critical' }, 'aria-pressed': String(filters.alertLevel === 'critical'), onclick: set({ alertLevel: filters.alertLevel === 'critical' ? 'all' : 'critical' }) }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH.critical), h('strong', null, String(count('critical'))), 'Critical'),
        h('button', { class: 'res-sev', id: 'res-sev-attention', type: 'button', dataset: { level: 'attention' }, 'aria-pressed': String(filters.alertLevel === 'attention'), onclick: set({ alertLevel: filters.alertLevel === 'attention' ? 'all' : 'attention' }) }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH.attention), h('strong', null, String(count('attention'))), 'Needs attention'),
        h('div', { class: 'res-sev res-sev-static', dataset: { level: 'inactive' } }, h('span', { 'aria-hidden': 'true' }, '✓'), h('strong', null, String(acknowledged)), 'Acknowledged'),
      ),
      h(
        'div',
        { class: 'res-toolbar' },
        h(
          'div',
          { class: 'res-chips res-chips-tight', role: 'group', 'aria-label': 'Category' },
          filterChip('res-achip-all', 'All', filters.alertTopic === 'all', set({ alertTopic: 'all' }), { count: pool.length }),
          ...ALERT_TOPICS.map((topic) => filterChip(`res-achip-${topic}`, ALERT_TOPIC_LABEL[topic], filters.alertTopic === topic, set({ alertTopic: topic }), { iconEl: topicIcon(topic), count: topicCount(topic) })),
        ),
        h('span', { class: 'res-spacer' }),
        h('label', { class: 'check', for: 'res-show-ack' }, toggle, `Show acknowledged (${acknowledged})`),
        infoTip('One alert per problem. An acknowledged alert stays quiet until the problem is fixed; if the same problem comes back later, it is shown again. Select an alert for its full description and actions.'),
      ),
      shown.length === 0
        ? h('p', { class: 'res-allclear' }, levelBadge('ok', 'All clear'), all.length === 0 ? ' No alerts: everything registered is in date, in stock and in service.' : ' No alerts match these filters.')
        : h('ul', { class: 'res-alert-rows' }, ...shown.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]).map(row)),
    ];
  }

  // ---------- Protocol readiness ----------

  private readinessSection(): HTMLElement[] {
    const { filters } = this;
    const all = this.orderedReadiness();
    const shown = all.filter((r) => filters.readinessStatus === 'all' || protocolStatus(r) === filters.readinessStatus);
    const count = (status: ProtocolStatus): number => all.filter((r) => protocolStatus(r) === status).length;
    const toggleOpen = (ruleId: string): void => {
      const open = new Set(filters.openProtocols);
      if (open.has(ruleId)) open.delete(ruleId);
      else open.add(ruleId);
      filters.openProtocols = [...open];
      this.render();
    };
    const outcomeLevel = { available: 'ok', alternative: 'attention', missing: 'critical', insufficient: 'critical', unusable: 'critical' } as const;
    const outcomeWord = { available: 'On board', alternative: 'Approved alternative', missing: 'Missing', insufficient: 'Not enough', unusable: 'Not usable' } as const;

    const card = (r: ProtocolReadiness): HTMLElement => {
      const status = protocolStatus(r);
      const open = filters.openProtocols.includes(r.ruleId);
      const pending = pendingOf(r);
      const panelId = `res-proto-${r.ruleId}`;
      return h(
        'article',
        { class: `res-proto${open ? ' is-open' : ''}`, dataset: { status } },
        h(
          'button',
          { class: 'res-proto-main', id: `res-proto-btn-${r.ruleId}`, type: 'button', 'aria-expanded': String(open), 'aria-controls': panelId, onclick: () => toggleOpen(r.ruleId) },
          h('span', { class: 'res-proto-title' }, this.isActiveRule(r.ruleId) ? h('span', { class: 'res-active-tag' }, 'Active now') : null, h('strong', null, r.condition)),
          statusPill(status),
          h('span', { class: 'res-proto-progress' }, stepBar(r), h('span', { class: 'res-proto-count' }, h('strong', null, String(r.executable.length)), ` / ${r.steps.length} steps can be done`)),
          pending.length > 0
            ? h('span', { class: 'res-pending' }, ...pending.slice(0, 4).map((p) => h('span', { class: 'res-pending-chip', dataset: { level: p.level }, title: p.detail }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH[p.level]), p.text)), pending.length > 4 ? h('span', { class: 'res-pending-more' }, `+${pending.length - 4}`) : null)
            : h('span', { class: 'res-pending' }, h('span', { class: 'res-pending-chip', dataset: { level: 'ok' } }, h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH.ok), 'Nothing pending')),
          h('span', { class: 'res-chevron', 'aria-hidden': 'true' }),
        ),
        h(
          'div',
          { class: 'res-proto-detail', id: panelId, hidden: !open },
          h(
            'ol',
            { class: 'res-proto-steps' },
            ...r.steps.map((s) =>
              h(
                'li',
                { dataset: { key: STEP_KEY[s.readiness] } },
                h('div', { class: 'res-step-head' }, h('span', { class: 'res-step-num' }, String(s.index + 1)), h('span', { class: 'res-step-text' }, s.step.text), h('span', { class: 'res-step-level', title: `Authority level ${s.step.authorityLevel}` }, `L${s.step.authorityLevel}`), h('span', { class: 'res-step-state', dataset: { key: STEP_KEY[s.readiness] } }, READINESS_LABEL[s.readiness])),
                s.items.length + s.personnel.length > 0
                  ? h(
                      'ul',
                      { class: 'res-needs' },
                      ...s.items.map((item) =>
                        h(
                          'li',
                          { dataset: { level: outcomeLevel[item.outcome] }, title: item.detail },
                          h('span', { class: 'res-need-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[outcomeLevel[item.outcome]]),
                          h('span', { class: 'res-need-name' }, item.alternative ? `${item.need.label} → ${item.alternative.label}` : item.need.label),
                          h('span', { class: 'res-need-meta' }, `${outcomeWord[item.outcome]} · ${item.freeUnits} usable / ${item.need.quantity} needed`),
                        ),
                      ),
                      ...s.personnel.map((person) =>
                        h(
                          'li',
                          { dataset: { level: person.qualified.length === 0 ? 'critical' : person.qualified.length === 1 ? 'attention' : 'ok' }, title: person.detail },
                          h('span', { class: 'res-need-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[person.qualified.length === 0 ? 'critical' : person.qualified.length === 1 ? 'attention' : 'ok']),
                          h('span', { class: 'res-need-name' }, person.procedure),
                          h('span', { class: 'res-need-people' }, ...(person.qualified.length > 0 ? person.qualified.map((m) => h('span', { class: 'res-avatar res-avatar-sm', title: m.name }, initials(m.name))) : [h('span', { class: 'res-need-meta' }, 'No trained crew available')])),
                        ),
                      ),
                    )
                  : null,
                s.limitations.length > 0 ? h('details', { class: 'res-step-notes' }, h('summary', null, `${s.limitations.length} note${s.limitations.length === 1 ? '' : 's'}`), h('ul', null, ...s.limitations.map((text) => h('li', null, text)))) : null,
              ),
            ),
          ),
          r.escalations.length > 0 ? h('div', { class: 'res-escalate' }, h('strong', null, 'Escalate'), h('ul', null, ...r.escalations.map((text) => h('li', null, text)))) : null,
        ),
      );
    };

    return [
      h(
        'div',
        { class: 'res-ready-summary', role: 'group', 'aria-label': 'Filter by readiness' },
        ...PROTOCOL_STATUSES.map((status) =>
          h(
            'button',
            { class: 'res-sev', id: `res-rstat-${status}`, type: 'button', dataset: { level: PROTOCOL_STATUS_LEVEL[status] }, 'aria-pressed': String(filters.readinessStatus === status), onclick: () => ((filters.readinessStatus = filters.readinessStatus === status ? 'all' : status), this.render()) },
            h('span', { 'aria-hidden': 'true' }, LEVEL_GLYPH[PROTOCOL_STATUS_LEVEL[status]]),
            h('strong', null, String(count(status))),
            PROTOCOL_STATUS_LABEL[status],
          ),
        ),
        h('span', { class: 'res-spacer' }),
        h('span', { class: 'res-steps-key', 'aria-hidden': 'true' }, ...(['ready', 'limited', 'blocked', 'unknown'] as const).map((key) => h('span', { dataset: { key } }, h('i'), PROTOCOL_STATUS_LABEL[key]))),
        infoTip(`${LOGISTICS_NOTE} Each bar segment is one step of the protocol, as the readiness engine found it. A protocol is blocked if any step is; unknown if no step could be checked.`),
      ),
      shown.length === 0 ? h('p', { class: 'empty res-empty' }, 'No protocols match.') : h('div', { class: 'res-proto-list' }, ...shown.map(card)),
    ];
  }
}

export { typeLabel };
