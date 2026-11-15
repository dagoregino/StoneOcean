import type { HealthStore } from '../../data/HealthStore';
import type { ResourceStore } from '../../data/resources/ResourceStore';
import { INDICATOR_RULES } from '../../domain/evidence/indicatorRules';
import { daysUntil } from '../../domain/resources/dates';
import { conditionOf, crewFindings, freeUnits } from '../../domain/resources/findings';
import { PROCEDURES, procedureName } from '../../domain/resources/protocols';
import type { ProtocolReadiness, StepReadiness } from '../../domain/resources/readiness';
import {
  AVAILABILITY_LABEL,
  CATEGORY_LABEL,
  CATEGORY_SHORT,
  isStock,
  LEVEL_RANK,
  MOVEMENT_LABEL,
  MOVEMENT_TYPES,
  RESOURCE_CATEGORIES,
  TRAINING_LABEL,
  TRAINING_RANK,
  type Level,
  type MovementType,
  type Resource,
  type ResourceCategory,
} from '../../domain/resources/types';
import { severity } from '../../domain/status';
import type { IndicatorId } from '../../domain/types';
import { h } from '../dom';
import { openCrewForm, openImportDialog, openMovementForm, openResourceDetail, openResourceForm, openScanDialog, typeLabel } from './dialogs';
import { confirmDialog, formatDate, formatDateTime, icon, levelBadge, toast } from './kit';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'movements', label: 'Movements' },
  { id: 'crew', label: 'Crew capabilities' },
  { id: 'alerts', label: 'Alerts' },
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

interface Filters {
  category: ResourceCategory | 'all';
  search: string;
  condition: 'all' | Level;
  sort: 'name' | 'quantity' | 'expiry';
  movementType: MovementType | 'all';
  movementSearch: string;
  procedure: string;
  showAcknowledged: boolean;
}

/**
 * Medical Resources: what is on board, what state it is in, who can use it, and whether the
 * approved protocols can be carried out with it. One screen with five sections; every number
 * on it is read from the saved inventory.
 */
export class ResourcesView {
  private section: SectionId = 'overview';
  private readonly body = h('div', { class: 'res-body', role: 'tabpanel', id: 'res-panel', tabIndex: -1 });
  private readonly tabs: HTMLButtonElement[];
  private readonly notice = h('p', { class: 'res-sim-notice' });
  private readonly filters: Filters = { category: 'all', search: '', condition: 'all', sort: 'name', movementType: 'all', movementSearch: '', procedure: '', showAcknowledged: false };

  constructor(
    parent: HTMLElement,
    private readonly store: ResourceStore,
    private readonly health: HealthStore,
    private readonly user: () => string,
  ) {
    this.tabs = SECTIONS.map((section) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-controls': 'res-panel', onclick: () => this.open(section.id) }, section.label));
    parent.append(
      h(
        'header',
        { class: 'res-head' },
        h('div', null, h('h2', null, 'Medical Resources'), h('p', { class: 'res-head-sub' }, 'What is on board, what state it is in, and who is trained to use it.')),
        h(
          'div',
          { class: 'res-head-actions' },
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openScanDialog(store, this.user()) }, icon('scan'), 'Find by code'),
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openMovementForm(store, this.user()) }, 'Record movement'),
          h('button', { class: 'button', type: 'button', onclick: () => openResourceForm(store, undefined, this.filters.category === 'all' ? undefined : this.filters.category) }, '+ Register resource'),
        ),
      ),
      this.notice,
      h('div', { class: 'tabs res-tabs', role: 'tablist', 'aria-label': 'Medical resources sections' }, ...this.tabs),
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

  private render(): void {
    const { store } = this;
    const alerts = store.ready ? store.alerts.length : 0;
    this.tabs.forEach((tab, i) => {
      const selected = SECTIONS[i].id === this.section;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (SECTIONS[i].id === 'alerts') tab.replaceChildren('Alerts', alerts > 0 ? h('span', { class: 'res-count' }, String(alerts)) : '');
    });
    this.notice.hidden = !store.hasSimulatedData;
    if (!this.notice.hidden && this.notice.childElementCount === 0) {
      this.notice.append(
        h('strong', null, 'Simulated demonstration data. '),
        'Names, quantities, lots and storage notes are made up to show the module working. They are not a recommended kit for any mission.',
        ' ',
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
    // Keep what the reader was typing: rebuild the results, not the search box they are in.
    const active = document.activeElement as HTMLInputElement | null;
    const focusId = active && this.body.contains(active) ? active.id : '';
    const caret = focusId && 'selectionStart' in active! ? active!.selectionStart : null;
    const scroll = this.body.scrollTop;
    const views: Record<SectionId, () => HTMLElement[]> = { overview: () => this.overview(), inventory: () => this.inventory(), movements: () => this.movementsSection(), crew: () => this.crewSection(), alerts: () => this.alertsSection() };
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
    const count = (category: ResourceCategory, usable: boolean): number => active.filter((r) => r.category === category && (!usable || conditionOf(r, now).level !== 'critical')).length;
    const alerts = store.alerts;
    const kinds = (...list: string[]): number => new Set(alerts.filter((a) => list.includes(a.kind)).map((a) => a.subjectId)).size;
    const card = (label: string, value: number, detail: string, level: Level, onOpen: () => void, iconName?: Parameters<typeof icon>[0]): HTMLElement =>
      h(
        'button',
        { class: 'res-stat', type: 'button', dataset: { level: value > 0 || level === 'ok' ? level : 'ok' }, onclick: onOpen },
        h('span', { class: 'res-stat-label' }, iconName ? icon(iconName) : null, label),
        h('span', { class: 'res-stat-value' }, String(value)),
        h('span', { class: 'res-stat-detail' }, detail),
      );
    const of = (category: ResourceCategory): string => `of ${count(category, false)} registered`;

    const plan = this.health.medicalPlan;
    const readiness = store.readinessOfAll(plan);
    const activeRules = this.activeRuleIds();
    const ordered = [...readiness].sort((a, b) => Number(activeRules.has(b.ruleId)) - Number(activeRules.has(a.ruleId)));

    return [
      h(
        'section',
        { class: 'res-stats' },
        card('Resources registered', active.length, `${store.resources.length - active.length} deactivated`, 'ok', () => this.open('inventory', { category: 'all', condition: 'all' }), 'all'),
        card('Medications usable', count('pharmaceutical', true), of('pharmaceutical'), 'ok', () => this.open('inventory', { category: 'pharmaceutical', condition: 'all' }), 'pharmaceutical'),
        card('Devices operational', count('device', true), of('device'), 'ok', () => this.open('inventory', { category: 'device', condition: 'all' }), 'device'),
        card('Consumables usable', count('consumable', true), of('consumable'), 'ok', () => this.open('inventory', { category: 'consumable', condition: 'all' }), 'consumable'),
        card('Low stock', kinds('low_stock', 'out_of_stock', 'all_reserved'), 'at or below the minimum', 'attention', () => this.open('alerts')),
        card('Expiring or expired', kinds('expiring_soon', 'expired'), 'within 30 days, or past', 'attention', () => this.open('alerts')),
        card('Equipment needing work', kinds('out_of_service', 'needs_attention', 'calibration_overdue', 'calibration_due', 'maintenance_overdue', 'maintenance_due', 'inspection_overdue', 'inspection_due', 'battery_low'), 'service, calibration, inspection', 'attention', () => this.open('alerts')),
        card('Open alerts', alerts.length, `${alerts.filter((a) => a.level === 'critical').length} critical`, alerts.some((a) => a.level === 'critical') ? 'critical' : 'attention', () => this.open('alerts'), 'alert'),
      ),
      h(
        'section',
        { class: 'res-card' },
        h('div', { class: 'res-card-head' }, h('h3', null, 'Can the protocols be carried out?'), h('p', null, 'Each approved protocol checked against what is on board and who is trained. A protocol that is active now is listed first.')),
        h(
          'div',
          { class: 'res-table-wrap' },
          h(
            'table',
            { class: 'res-table' },
            h('thead', null, h('tr', null, h('th', null, 'Protocol'), h('th', null, 'Readiness'), h('th', { class: 'num' }, 'Steps ready'), h('th', null, 'What limits it'))),
            h(
              'tbody',
              null,
              ...ordered.map((r) =>
                h(
                  'tr',
                  { class: activeRules.has(r.ruleId) ? 'is-active' : '' },
                  h('td', null, h('strong', null, r.condition), activeRules.has(r.ruleId) ? h('span', { class: 'res-active-tag' }, 'Active now') : null),
                  h('td', null, protocolBadge(r)),
                  h('td', { class: 'num' }, `${r.executable.length} / ${r.steps.length}`),
                  h('td', { class: 'res-limit' }, r.steps.find((s) => s.readiness === 'blocked')?.limitations[0] ?? r.limitations[0] ?? '—'),
                ),
              ),
            ),
          ),
        ),
        h('p', { class: 'res-field-hint' }, 'This is a check of logistics. That something is on board does not mean using it is appropriate: that is decided by the protocol and the responsible medical staff. Open a protocol in Monitoring to see the full check, step by step.'),
      ),
      h(
        'section',
        { class: 'res-two' },
        h(
          'div',
          { class: 'res-card' },
          h('div', { class: 'res-card-head' }, h('h3', null, 'Needs attention first')),
          alerts.length === 0
            ? h('p', { class: 'empty' }, 'Nothing needs attention.')
            : h('ul', { class: 'res-alert-list' }, ...alerts.slice(0, 5).map((a) => h('li', { dataset: { level: a.level } }, h('strong', null, a.subjectName), h('span', null, a.message)))),
          alerts.length > 5 ? h('button', { class: 'link-button', type: 'button', onclick: () => this.open('alerts') }, `See all ${alerts.length} alerts →`) : null,
        ),
        h(
          'div',
          { class: 'res-card' },
          h('div', { class: 'res-card-head' }, h('h3', null, 'State by category')),
          ...RESOURCE_CATEGORIES.map((category) => {
            const items = active.filter((r) => r.category === category);
            const by = (level: Level): number => items.filter((r) => conditionOf(r, now).level === level).length;
            const parts: [Level, number, string][] = [
              ['ok', by('ok'), 'ready'],
              ['attention', by('attention'), 'need attention'],
              ['critical', by('critical'), 'not usable'],
            ];
            return h(
              'div',
              { class: 'res-bar-row' },
              h('span', { class: 'res-bar-label' }, CATEGORY_LABEL[category]),
              h('span', { class: 'res-bar', 'aria-hidden': 'true' }, ...parts.filter(([, n]) => n > 0).map(([level, n]) => h('span', { dataset: { level }, style: `flex:${n}` }))),
              h('span', { class: 'res-bar-text' }, parts.map(([, n, text]) => `${n} ${text}`).join(' · ')),
            );
          }),
        ),
      ),
    ];
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

  // ---------- Inventory ----------

  private inventory(): HTMLElement[] {
    const { store, filters } = this;
    const now = store.today;
    const term = filters.search.trim().toLowerCase();
    const rows = store.resources
      .filter((r) => filters.category === 'all' || r.category === filters.category)
      .filter((r) => !term || r.name.toLowerCase().includes(term) || r.id.toLowerCase().includes(term) || (r.lot ?? '').toLowerCase().includes(term))
      .map((r) => ({ r, condition: conditionOf(r, now) }))
      .filter(({ condition }) => (filters.condition === 'all' ? condition.level !== 'inactive' || filters.search !== '' : condition.level === filters.condition))
      .sort((a, b) => {
        if (filters.sort === 'quantity') return freeUnits(a.r) - freeUnits(b.r) || a.r.name.localeCompare(b.r.name);
        if (filters.sort === 'expiry') return (a.r.expiresOn ?? '9999').localeCompare(b.r.expiresOn ?? '9999') || a.r.name.localeCompare(b.r.name);
        return a.r.name.localeCompare(b.r.name);
      });

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

    const search = h('input', { id: 'res-search', class: 'res-input res-search', type: 'search', placeholder: 'Search by name, identifier or lot', value: filters.search, 'aria-label': 'Search the inventory' });
    search.addEventListener('input', () => {
      filters.search = search.value;
      this.render();
    });
    const select = <K extends 'condition' | 'sort'>(key: K, label: string, options: [Filters[K], string][]): HTMLElement => {
      const control = h('select', { class: 'res-input', 'aria-label': label }, ...options.map(([value, text]) => h('option', { value }, text)));
      control.value = filters[key];
      control.addEventListener('change', () => {
        filters[key] = control.value as Filters[K];
        this.render();
      });
      return control;
    };

    return [
      h(
        'div',
        { class: 'res-chips', role: 'group', 'aria-label': 'Category' },
        ...(['all', ...RESOURCE_CATEGORIES] as const).map((c) =>
          h(
            'button',
            {
              class: 'res-chip',
              type: 'button',
              'aria-pressed': String(filters.category === c),
              onclick: () => {
                filters.category = c;
                this.render();
              },
            },
            icon(c),
            c === 'all' ? 'All' : CATEGORY_LABEL[c],
            h('span', { class: 'res-chip-count' }, String(store.activeResources.filter((r) => c === 'all' || r.category === c).length)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'res-toolbar' },
        search,
        select('condition', 'Filter by state', [
          ['all', 'All active'],
          ['ok', 'Ready'],
          ['attention', 'Needs attention'],
          ['critical', 'Not usable'],
          ['inactive', 'Deactivated'],
        ]),
        select('sort', 'Sort by', [
          ['name', 'Sort: name'],
          ['quantity', 'Sort: lowest quantity'],
          ['expiry', 'Sort: earliest expiry'],
        ]),
        h('button', { class: 'button button-quiet', type: 'button', onclick: () => openImportDialog(store) }, 'Import / export'),
      ),
      rows.length === 0
        ? h('p', { class: 'empty res-empty' }, store.resources.length === 0 ? 'No resources registered yet. Use “Register resource” or import a file.' : 'No resources match. Clear the search or change the filters.')
        : h(
            'div',
            { class: 'res-table-wrap res-card' },
            h(
              'table',
              { class: 'res-table' },
              h('thead', null, h('tr', null, ...columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.head)), h('th', null, 'State'), h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
              h(
                'tbody',
                null,
                ...rows.map(({ r, condition }) =>
                  h(
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
                  ),
                ),
              ),
            ),
          ),
      h('p', { class: 'res-field-hint' }, `${rows.length} shown. “Free” is what can be used now: units on board minus units reserved.`),
    ];
  }

  // ---------- Movements ----------

  private movementsSection(): HTMLElement[] {
    const { store, filters } = this;
    const term = filters.movementSearch.trim().toLowerCase();
    const rows = store.movements.filter((m) => (filters.movementType === 'all' || m.type === filters.movementType) && (!term || `${m.resourceName} ${m.resourceId} ${m.user} ${m.reason}`.toLowerCase().includes(term)));
    const search = h('input', { id: 'res-move-search', class: 'res-input res-search', type: 'search', placeholder: 'Search by resource, person or reason', value: filters.movementSearch, 'aria-label': 'Search movements' });
    search.addEventListener('input', () => {
      filters.movementSearch = search.value;
      this.render();
    });
    const type = h('select', { class: 'res-input', 'aria-label': 'Filter by type' }, h('option', { value: 'all' }, 'All movements'), ...MOVEMENT_TYPES.map((t) => h('option', { value: t }, MOVEMENT_LABEL[t])));
    type.value = filters.movementType;
    type.addEventListener('change', () => {
      filters.movementType = type.value as Filters['movementType'];
      this.render();
    });
    const sign = (t: MovementType): string => (t === 'entry' || t === 'restock' || t === 'return' ? '+' : t === 'reservation' ? '' : '−');
    return [
      h('div', { class: 'res-toolbar' }, search, type, h('button', { class: 'button', type: 'button', onclick: () => openMovementForm(store, this.user()) }, 'Record movement')),
      rows.length === 0
        ? h('p', { class: 'empty res-empty' }, store.movements.length === 0 ? 'No movements recorded yet.' : 'No movements match.')
        : h(
            'div',
            { class: 'res-table-wrap res-card' },
            h(
              'table',
              { class: 'res-table' },
              h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Resource'), h('th', null, 'Movement'), h('th', { class: 'num' }, 'Quantity'), h('th', { class: 'num' }, 'On board after'), h('th', null, 'Recorded by'), h('th', null, 'Reason'))),
              h(
                'tbody',
                null,
                ...rows.slice(0, 300).map((m) =>
                  h(
                    'tr',
                    null,
                    h('td', null, formatDateTime(m.at)),
                    h('td', null, h('button', { class: 'link-button', type: 'button', onclick: () => openResourceDetail(store, this.user(), m.resourceId) }, m.resourceName), h('span', { class: 'res-id' }, m.resourceId)),
                    h('td', null, h('span', { class: 'res-move', dataset: { type: m.type } }, MOVEMENT_LABEL[m.type])),
                    h('td', { class: 'num' }, `${sign(m.type)}${m.quantity}`),
                    h('td', { class: 'num' }, String(m.balance.quantity), m.balance.reserved > 0 ? h('span', { class: 'res-id' }, `${m.balance.reserved} reserved`) : null),
                    h('td', null, m.user),
                    h('td', null, m.reason, m.notes ? h('span', { class: 'res-note' }, ` — ${m.notes}`) : null),
                  ),
                ),
              ),
            ),
          ),
      h('p', { class: 'res-field-hint' }, `${rows.length} movement${rows.length === 1 ? '' : 's'}, newest first. The history is a record: movements are added, never edited or removed. To correct a mistake, record the opposite movement and say why.`),
    ];
  }

  // ---------- Crew ----------

  private crewSection(): HTMLElement[] {
    const { store, filters } = this;
    const now = store.today;
    const crew = store.crew;
    const lookup = h('select', { class: 'res-input', id: 'res-procedure', 'aria-label': 'Procedure' }, h('option', { value: '' }, 'Choose a procedure…'), ...PROCEDURES.map((p) => h('option', { value: p.code }, p.name)));
    lookup.value = filters.procedure;
    lookup.addEventListener('change', () => {
      filters.procedure = lookup.value;
      this.render();
    });
    const inDate = (expiresOn?: string): boolean => !expiresOn || daysUntil(expiresOn, now) >= 0;
    const holders = filters.procedure
      ? crew
          .map((member) => ({ member, cert: member.certifications.find((c) => c.procedureCode === filters.procedure) }))
          .filter((entry): entry is { member: (typeof crew)[number]; cert: NonNullable<typeof entry.cert> } => Boolean(entry.cert))
          .sort((a, b) => TRAINING_RANK[b.cert.level] - TRAINING_RANK[a.cert.level])
      : [];

    return [
      h(
        'section',
        { class: 'res-card' },
        h('div', { class: 'res-card-head' }, h('h3', null, 'Who can do it?'), h('p', null, 'Pick a procedure to see who holds a certification for it, at what level, and whether they are available now.')),
        h('div', { class: 'res-toolbar' }, lookup),
        !filters.procedure
          ? null
          : holders.length === 0
            ? h('p', { class: 'res-none' }, levelBadge('critical', 'Nobody'), ` No one on the roster holds a certification for “${procedureName(filters.procedure)}”.`)
            : h(
                'ul',
                { class: 'res-holder-list' },
                ...holders.map(({ member, cert }) => {
                  const current = inDate(cert.expiresOn);
                  const ok = current && member.availability === 'available';
                  return h(
                    'li',
                    null,
                    h('strong', null, member.name),
                    h('span', null, `${member.role} · ${TRAINING_LABEL[cert.level]}`),
                    levelBadge(ok ? 'ok' : current ? 'attention' : 'critical', !current ? `Certification expired ${formatDate(cert.expiresOn)}` : member.availability === 'available' ? 'Available now' : AVAILABILITY_LABEL[member.availability]),
                  );
                }),
              ),
      ),
      h('div', { class: 'res-toolbar' }, h('h3', { class: 'res-subhead' }, `Roster (${crew.length})`), h('span', { class: 'res-spacer' }), h('button', { class: 'button', type: 'button', onclick: () => openCrewForm(store) }, '+ Add crew member')),
      crew.length === 0
        ? h('p', { class: 'empty res-empty' }, 'No crew members registered.')
        : h(
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
                  h('div', null, h('h4', null, member.name), h('p', null, `${member.role} · ${member.id}`, member.simulated ? ' · simulated' : '')),
                  levelBadge(member.availability === 'available' ? 'ok' : member.availability === 'off_duty' ? 'attention' : 'inactive', AVAILABILITY_LABEL[member.availability]),
                ),
                member.certifications.length === 0
                  ? h('p', { class: 'empty' }, 'No medical training on record.')
                  : h(
                      'ul',
                      { class: 'res-cert-list' },
                      ...member.certifications.map((cert) => {
                        const days = cert.expiresOn ? daysUntil(cert.expiresOn, now) : null;
                        const level: Level = days === null ? 'ok' : days < 0 ? 'critical' : days <= 30 ? 'attention' : 'ok';
                        return h(
                          'li',
                          { dataset: { level } },
                          h('span', { class: 'res-cert-name' }, procedureName(cert.procedureCode)),
                          h('span', { class: 'res-cert-meta' }, `${TRAINING_LABEL[cert.level].split(':')[0]} · ${cert.expiresOn ? `${days! < 0 ? 'expired' : 'valid until'} ${formatDate(cert.expiresOn)}` : 'does not lapse'}`),
                        );
                      }),
                    ),
                findings.length > 0 ? h('p', { class: 'res-crew-flag' }, `${findings.length} certification${findings.length === 1 ? '' : 's'} expired or expiring`) : null,
                h('button', { class: 'button button-quiet button-small', type: 'button', 'aria-label': `Edit ${member.name}`, onclick: () => openCrewForm(store, member) }, 'Edit'),
              );
            }),
          ),
    ];
  }

  // ---------- Alerts ----------

  private alertsSection(): HTMLElement[] {
    const { store, filters } = this;
    const all = store.allAlerts;
    const shown = filters.showAcknowledged ? all : all.filter((a) => !store.isAcknowledged(a.id));
    const acknowledged = all.length - store.alerts.length;
    const toggle = h('input', { type: 'checkbox', id: 'res-show-ack', checked: filters.showAcknowledged });
    toggle.addEventListener('change', () => {
      filters.showAcknowledged = toggle.checked;
      this.render();
    });
    const group = (level: 'critical' | 'attention', title: string, lead: string): HTMLElement | null => {
      const items = shown.filter((a) => a.level === level).sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
      if (items.length === 0) return null;
      return h(
        'section',
        { class: 'res-card' },
        h('div', { class: 'res-card-head' }, h('h3', null, `${title} (${items.length})`), h('p', null, lead)),
        h(
          'ul',
          { class: 'res-alerts' },
          ...items.map((alert) => {
            const seen = store.isAcknowledged(alert.id);
            return h(
              'li',
              { dataset: { level: alert.level }, class: seen ? 'is-seen' : '' },
              h('span', { class: 'res-alert-icon', 'aria-hidden': 'true' }, alert.level === 'critical' ? '◆' : '▲'),
              h('div', { class: 'res-alert-text' }, h('strong', null, `${alert.label}: ${alert.subjectName}`), h('span', null, alert.message), h('span', { class: 'res-id' }, alert.subject === 'crew' ? 'Crew certification' : `${alert.subjectId} · ${CATEGORY_LABEL[alert.category!]}`)),
              h(
                'div',
                { class: 'res-actions' },
                alert.subject === 'resource' ? h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => openResourceDetail(store, this.user(), alert.subjectId) }, 'Open') : h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => this.open('crew') }, 'Open roster'),
                h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => void store.acknowledge(alert.id, !seen) }, seen ? 'Mark as open' : 'Acknowledge'),
              ),
            );
          }),
        ),
      );
    };
    return [
      h(
        'div',
        { class: 'res-toolbar' },
        h('p', { class: 'res-field-hint' }, 'One alert per problem. An acknowledged alert stays quiet until the problem is fixed; if the same problem comes back later, it is shown again.'),
        h('span', { class: 'res-spacer' }),
        h('label', { class: 'check', for: 'res-show-ack' }, toggle, `Show acknowledged (${acknowledged})`),
      ),
      shown.length === 0 ? h('p', { class: 'empty res-empty' }, all.length === 0 ? 'No alerts. Everything registered is in date, in stock and in service.' : 'No open alerts. All have been acknowledged.') : null,
      group('critical', 'Critical', 'Not usable as it stands: expired, out of stock, out of service or past calibration.'),
      group('attention', 'Needs attention', 'Still usable, but something is coming due or running low.'),
    ].filter((el): el is HTMLElement => el !== null);
  }
}

export { typeLabel };
