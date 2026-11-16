import type { HealthStore } from '../../data/HealthStore';
import type { ResourceStore } from '../../data/resources/ResourceStore';
import { INDICATOR_RULES } from '../../domain/evidence/indicatorRules';
import { daysUntil } from '../../domain/resources/dates';
import { conditionOf, freeUnits } from '../../domain/resources/findings';
import { PROCEDURES, procedureName } from '../../domain/resources/protocols';
import type { ProtocolReadiness, StepReadiness } from '../../domain/resources/readiness';
import {
  AVAILABILITY_LABEL,
  CATEGORY_SHORT,
  isStock,
  LEVEL_RANK,
  TRAINING_LABEL,
  TRAINING_RANK,
  type Level,
  type Resource,
  type ResourceCategory,
} from '../../domain/resources/types';
import { severity } from '../../domain/status';
import type { IndicatorId } from '../../domain/types';
import { h } from '../dom';
import { openCrewForm, openImportDialog, openMovementForm, openResourceDetail, openResourceForm, typeLabel } from './dialogs';
import { confirmDialog, formatDate, levelBadge, toast } from './kit';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'crew', label: 'Who can help' },
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
  procedure: string;
  showAcknowledged: boolean;
  stateFilter: 'all' | Level;
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
  private readonly filters: Filters = { category: 'all', procedure: '', showAcknowledged: false, stateFilter: 'all' };

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
        h('div', null, h('h2', null, 'Medical Supplies'), h('p', { class: 'res-head-sub' }, 'What is on board and who can help.')),
        h(
          'div',
          { class: 'res-head-actions' },
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => openMovementForm(store, this.user()) }, 'Record movement'),
          h('button', { class: 'button', type: 'button', onclick: () => openResourceForm(store, undefined, undefined) }, '+ Register resource'),
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
    const views: Record<SectionId, () => HTMLElement[]> = { overview: () => this.overview(), inventory: () => this.inventory(), crew: () => this.crewSection(), alerts: () => this.alertsSection() };
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
    const alerts = store.alerts;

    const plan = this.health.medicalPlan;
    const readiness = store.readinessOfAll(plan);
    const activeRules = this.activeRuleIds();
    const ordered = [...readiness].sort((a, b) => Number(activeRules.has(b.ruleId)) - Number(activeRules.has(a.ruleId)));

    return [
      this.readinessRing(readiness),
      h(
        'section',
        { class: 'res-card' },
        h('div', { class: 'res-card-head' }, h('h3', null, 'Can I do these treatments?'), h('p', null, 'Each treatment checked against what is on board and who is trained. Active ones first.')),
        h(
          'details',
          { class: 'fold' },
          h('summary', null, `All protocols (${ordered.length})`),
          h(
            'div',
            { class: 'res-table-wrap' },
            h(
              'table',
              { class: 'res-table' },
              h('thead', null, h('tr', null, h('th', null, 'Treatment'), h('th', null, 'Ready?'), h('th', { class: 'num' }, 'Steps I can do'), h('th', null, 'What is blocking?'))),
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
          h('p', { class: 'res-field-hint' }, 'Being on board does not mean it can be used. See the treatment details for the full check.'),
        ),
      ),
      h(
        'section',
        { class: 'res-card' },
        h('div', { class: 'res-card-head' }, h('h3', null, 'Needs attention first')),
        alerts.length === 0
          ? h('p', { class: 'empty' }, 'Nothing needs attention.')
          : h('ul', { class: 'res-alert-list' }, ...alerts.slice(0, 3).map((a) => h('li', { dataset: { level: a.level } }, h('strong', null, a.subjectName), h('span', null, a.message)))),
      ),
    ];
  }

  /** A single dependency-free ring showing protocol readiness. */
  private readinessRing(readiness: readonly ProtocolReadiness[]): HTMLElement {
    let total = 0;
    let ready = 0;
    for (const r of readiness) {
      total += r.steps.length;
      ready += r.steps.filter((s) => s.readiness === 'ready').length;
    }
    const pct = total === 0 ? 100 : Math.round((ready / total) * 100);
    const tone: Level = pct >= 80 ? 'ok' : pct >= 50 ? 'attention' : 'critical';
    const circumference = 2 * Math.PI * 28;
    const offset = circumference * (1 - pct / 100);

    const ring = h('div', { class: 'res-readiness-ring', style: `--tone: var(--${tone === 'ok' ? 'good' : tone === 'attention' ? 'warning' : 'critical'})` });
    ring.innerHTML = `<svg viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="28"></circle><circle cx="36" cy="36" r="28" class="prog" style="stroke-dashoffset:${offset.toFixed(1)}" stroke-dasharray="${circumference.toFixed(1)}"></circle></svg>`;
    ring.dataset.level = tone;

    const wrap = h('div', { class: 'res-readiness' });
    wrap.append(ring);
    wrap.append(h('div', null, h('div', { class: 'res-readiness-value' }, String(pct), h('span', null, '%')), h('div', { class: 'res-readiness-label' }, `${ready} of ${total} treatment steps ready`)));
    return wrap;
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
    const { store } = this;
    const now = store.today;
    const rows = store.resources
      .map((r) => ({ r, condition: conditionOf(r, now) }))
      .filter(({ condition }) => this.filters.stateFilter === 'all' || condition.level === this.filters.stateFilter)
      .sort((a, b) => a.r.name.localeCompare(b.r.name));

    const columns: { head: string; num?: boolean; cell: (r: Resource) => string | HTMLElement }[] = [
      { head: 'Name', cell: (r) => h('span', { class: 'res-name' }, h('strong', null, r.name), h('span', { class: 'res-id' }, r.id, r.simulated ? ' · simulated' : '')) },
      { head: 'Category', cell: (r) => CATEGORY_SHORT[r.category] },
      { head: 'Free / on board', num: true, cell: (r) => (isStock(r.category) ? `${freeUnits(r)} / ${r.quantity} ${r.unit}` : `${r.quantity}`) },
    ];

    const filterChip = (label: string, value: 'all' | Level, tone?: string): HTMLElement =>
      h('button', {
        class: 'res-chip',
        type: 'button',
        'aria-pressed': String(this.filters.stateFilter === value),
        onclick: () => { this.filters.stateFilter = value; this.render(); },
        style: tone ? `--tone: var(--${tone})` : '',
      }, label);

    return [
      h('div', { class: 'res-toolbar' }, filterChip('All', 'all'), filterChip('Ready', 'ok', 'good'), filterChip('Needs attention', 'attention', 'warning'), filterChip('Not usable', 'critical', 'critical'), h('span', { class: 'res-spacer' }), h('button', { class: 'button button-quiet', type: 'button', onclick: () => openImportDialog(store) }, 'Import / export'), h('button', { class: 'button', type: 'button', onclick: () => openResourceForm(store, undefined, undefined) }, '+ Register resource')),
      rows.length === 0
        ? h('p', { class: 'empty res-empty' }, store.resources.length === 0 ? 'No resources registered yet. Use “Register resource” to add one.' : 'No resources match.')
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
      h('p', { class: 'res-field-hint' }, `${rows.length} shown. “Free” = on board minus reserved.`),
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
        h('div', { class: 'res-card-head' }, h('h3', null, 'Who can help?'), h('p', null, 'Pick a treatment to see who is trained and available.')),
        h('div', { class: 'res-toolbar' }, lookup),
        !filters.procedure
          ? null
          : holders.length === 0
            ? h('p', { class: 'res-none' }, levelBadge('critical', 'Nobody'), ` No one on the crew is trained for “${procedureName(filters.procedure)}”.`)
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
                    levelBadge(ok ? 'ok' : current ? 'attention' : 'critical', !current ? `Training expired ${formatDate(cert.expiresOn)}` : member.availability === 'available' ? 'Available now' : AVAILABILITY_LABEL[member.availability]),
                  );
                }),
              ),
      ),
      h('div', { class: 'res-toolbar' }, h('span', { class: 'res-subhead' }, `Roster: ${crew.length} crew members`), h('span', { class: 'res-spacer' }), h('button', { class: 'button', type: 'button', onclick: () => openCrewForm(store) }, '+ Add crew member')),
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
              h('div', { class: 'res-alert-text' }, h('strong', null, `${alert.label}: ${alert.subjectName}`), h('span', null, alert.message)),
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
        h('p', { class: 'res-field-hint' }, 'Acknowledged alerts stay quiet until fixed.'),
        h('span', { class: 'res-spacer' }),
        h('label', { class: 'check', for: 'res-show-ack' }, toggle, `Show acknowledged (${acknowledged})`),
      ),
      shown.length === 0 ? h('p', { class: 'empty res-empty' }, all.length === 0 ? 'No alerts. Everything registered is in date, in stock and in service.' : 'No open alerts. All have been acknowledged.') : null,
      group('critical', 'Critical', 'Expired, out of stock, out of service or past calibration.'),
      group('attention', 'Needs attention', 'Still usable, but something is coming due or running low.'),
    ].filter((el): el is HTMLElement => el !== null);
  }
}

export { typeLabel };
