import { formatDelay } from '../../domain/catalog/environments';
import { CONSULT_PHASE_LABEL, formatRoundTrip, type FlightSurgeonConsult } from '../../domain/consult';
import { INDICATORS } from '../../domain/catalog/indicators';
import { HAZARDS } from '../../domain/catalog/systems';
import type { Intervention } from '../../domain/engine/verify';
import { INDICATOR_RULES, provenanceOf } from '../../domain/evidence/indicatorRules';
import { PROVENANCE_LABEL } from '../../domain/evidence/types';
import { offerSteps } from '../../domain/medicalPlan';
import { severity, STATUS_GLYPH } from '../../domain/status';
import { SYMPTOM_TYPE_LABEL, type SymptomReport } from '../../domain/symptoms';
import type { Evaluation, IndicatorEvaluation, SystemEvaluation } from '../../domain/types';
import { h, setText, syncList } from '../dom';
import { formatValue, formatWhen } from '../format';
import { SpaceWeatherCard } from '../SpaceWeatherCard';
import type { PanelContext, PanelTab } from './context';
import { helpToggle } from './help';
import { KpiCard } from './KpiCard';

const OUTCOME_VIEW = {
  pending: { glyph: '○', label: 'Waiting for a measured response', status: 'unknown' },
  verified: { glyph: '●', label: 'Verified', status: 'nominal' },
  not_verified: { glyph: '◆', label: 'Not verified', status: 'critical' },
} as const;

/**
 * Tab 1: how the crew member is doing, at a glance. Active alerts first, then one compact
 * card per indicator, then what was reported, what is due and what was done. Background
 * about the mission is folded away at the bottom.
 */
export class OverviewTab implements PanelTab {
  readonly element = h('div', { class: 'tab-view' });
  private readonly attention = h('div', { class: 'row-list' });
  private readonly attentionSection = h('section', { hidden: true }, h('h3', null, 'Needs attention'), this.attention);
  private readonly kpis = h('div', { class: 'kpi-grid' });
  private readonly cards = new Map<string, KpiCard>();
  private readonly symptoms = h('div', { class: 'row-list' });
  private readonly symptomsEmpty = h('p', { class: 'empty' }, 'Nothing reported. Use “Report discomfort” above the 3D body to mark where something hurts or feels off.');
  private readonly due = h('div', { class: 'row-list' });
  private readonly dueSection = h('section', { hidden: true }, h('h3', null, 'Self-checks due'), this.due);
  private readonly treatments = h('div', { class: 'row-list' });
  private readonly treatmentsSection = h('section', { hidden: true }, h('h3', null, 'Treatments and their verification'), this.treatments);
  private readonly consults = h('div', { class: 'row-list' });
  private readonly consultsSection = h('section', { hidden: true }, h('h3', null, 'Flight surgeon consultations'), this.consults);
  private readonly environment = h('div', { class: 'facts' });
  private readonly drugsToggle: HTMLInputElement;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly context: PanelContext) {
    const { store, actions, system } = context;
    const evaluation = store.evaluation;
    const indicators = system ? evaluation.systems[system].indicators : Object.values(evaluation.systems).flatMap((s) => s.indicators);
    for (const indicator of indicators) {
      const card = new KpiCard(indicator.def, actions, !system, () => context.openTrend(indicator.def.id), () => context.openProtocol(indicator.def.id));
      this.cards.set(indicator.def.id, card);
      this.kpis.append(card.element);
    }

    this.drugsToggle = h('input', { type: 'checkbox', id: 'drugs-preauthorized', onchange: () => actions.setDrugsPreauthorized(this.drugsToggle.checked) });

    if (system) this.element.append(this.systemIntro());
    this.element.append(
      this.attentionSection,
      ...(system === 'radiation' && store.spaceWeather ? [new SpaceWeatherCard(store.spaceWeather).element] : []),
      h('section', null, h('h3', null, system ? 'Indicators' : 'Vital summary'), this.kpis),
      h('section', null, h('h3', null, 'Reported discomfort'), this.symptoms, this.symptomsEmpty),
      this.dueSection,
      this.treatmentsSection,
      this.consultsSection,
    );
    if (!system) this.element.append(this.missionContext());

    this.unsubscribe = [store.events.on('symptoms', () => this.renderSymptoms()), store.events.on('consults', () => this.renderConsults())];
    this.renderSymptoms();
    this.renderConsults();
  }

  update(evaluation: Evaluation): void {
    const { store, system } = this.context;
    const now = evaluation.missionTime;
    const systems = system ? [evaluation.systems[system]] : Object.values(evaluation.systems);
    for (const indicator of systems.flatMap((s) => s.indicators)) this.cards.get(indicator.def.id)?.update(indicator, store.history(indicator.def.id), now);

    const flagged = systems.filter((s) => severity(s.status) >= severity('caution')).sort((a, b) => severity(b.status) - severity(a.status));
    this.attentionSection.hidden = flagged.length === 0;
    syncList<SystemEvaluation>(
      this.attention,
      flagged,
      (s) => s.def.id,
      (s) =>
        h(
          'button',
          { class: 'row', type: 'button', onclick: () => (s.driver ? this.context.openProtocol(s.driver.def.id) : store.select(s.def.id)) },
          h('span', { class: 'status-glyph', 'aria-hidden': 'true' }),
          h('span', { class: 'row-text' }, h('strong', null, s.def.name), h('span', { class: 'row-sub' }), h('span', { class: 'row-action' }), h('span', { class: 'row-resources' }), h('span', { class: 'row-provenance' })),
        ),
      (el, s) => {
        el.dataset.status = s.status;
        setText(el.querySelector('.status-glyph')!, STATUS_GLYPH[s.status]);
        const driver = s.driver;
        setText(el.querySelector('.row-sub')!, driver?.latest ? `${driver.def.name}: ${formatValue(driver.latest.value, driver.def)} ${driver.def.unit}` : '');
        const steps = s.status === 'critical' ? driver?.def.guidance.critical : driver?.def.guidance.caution;
        const first = steps ? offerSteps(steps, store.medicalPlan).find((step) => !step.withheld) : undefined;
        setText(el.querySelector('.row-action')!, first ? `First step: ${first.text}` : '');
        // Can the protocol behind this alert be carried out with what is on board?
        const { resources } = this.context;
        const readiness = driver && resources.ready && !resources.error ? resources.readiness(INDICATOR_RULES[driver.def.id].ruleId, store.medicalPlan) : null;
        const blocked = readiness?.steps.filter((step) => step.readiness === 'blocked').length ?? 0;
        const resourceLine = el.querySelector<HTMLElement>('.row-resources')!;
        setText(resourceLine, readiness ? `Resources: ${readiness.executable.length} of ${readiness.steps.length} protocol steps can be carried out now${blocked > 0 ? ` · ${blocked} blocked` : ''}` : '');
        resourceLine.dataset.level = blocked > 0 ? 'critical' : 'ok';
        // No alert without its provenance: basis of the threshold and class of evidence.
        const provenance = driver ? provenanceOf(driver.def.id, Boolean(driver.drift)) : undefined;
        setText(el.querySelector('.row-provenance')!, provenance ? `${provenance.basisLabel} · ${PROVENANCE_LABEL[provenance.evidence.provenanceClass]}` : '');
      },
    );

    const due = evaluation.due.filter((i) => !system || i.def.systemId === system);
    this.dueSection.hidden = due.length === 0;
    syncList<IndicatorEvaluation>(
      this.due,
      due,
      (i) => i.def.id,
      (i) =>
        h(
          'button',
          { class: 'row', type: 'button', onclick: () => this.revealLog(i) },
          h('span', { class: 'status-glyph', 'aria-hidden': 'true' }, '○'),
          h('span', { class: 'row-text' }, h('strong', null, i.def.name), h('span', { class: 'row-sub' }, `Due every ${i.def.cadenceHours} h · open to log it`)),
        ),
      () => undefined,
    );

    const recent = store.interventions
      .filter((i) => !system || INDICATORS[i.indicatorId].systemId === system)
      .slice(-4)
      .reverse();
    this.treatmentsSection.hidden = recent.length === 0;
    syncList<Intervention>(
      this.treatments,
      recent,
      (i) => String(i.id),
      (i) =>
        h(
          'button',
          { class: 'row', type: 'button', onclick: () => this.context.openProtocol(i.indicatorId) },
          h('span', { class: 'status-glyph', 'aria-hidden': 'true' }),
          h('span', { class: 'row-text' }, h('strong', null, i.stepText), h('span', { class: 'row-sub' }), h('span', { class: 'row-action' })),
        ),
      (el, i) => {
        const def = INDICATORS[i.indicatorId];
        const view = OUTCOME_VIEW[i.outcome];
        el.dataset.status = view.status;
        setText(el.querySelector('.status-glyph')!, view.glyph);
        const before = i.valueBefore === null ? 'no value' : `${formatValue(i.valueBefore, def)} ${def.unit}`;
        const after = i.valueAfter === null ? '' : `, now ${formatValue(i.valueAfter, def)} ${def.unit}`;
        setText(el.querySelector('.row-sub')!, `${view.label} · ${def.name}: ${before} before${after}`);
        setText(el.querySelector('.row-action')!, `Authority level ${i.authorityLevel} · done at ${formatWhen(i.startedAt)}`);
      },
    );

    if (!system) {
      this.drugsToggle.checked = store.medicalPlan.drugsPreauthorized;
      this.renderEnvironment();
    }
  }

  dispose(): void {
    this.unsubscribe.forEach((off) => off());
  }

  /** A due self-check: go to its card and open the logging form. */
  private revealLog(indicator: IndicatorEvaluation): void {
    const { store, system } = this.context;
    if (system !== indicator.def.systemId && system !== null) store.select(indicator.def.systemId);
    const input = document.getElementById(`log-${indicator.def.id}`) as HTMLInputElement | null;
    const form = input?.closest('form');
    if (!input || !form) return;
    form.hidden = false;
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
  }

  private systemIntro(): HTMLElement {
    const def = this.context.store.evaluation.systems[this.context.system!].def;
    const help = helpToggle(
      `About the ${def.name.toLowerCase()} system in space`,
      h('p', null, h('strong', null, 'In space: '), def.spaceflightEffect),
      h('div', { class: 'chips' }, ...def.hazards.map((hazard) => h('a', { class: 'chip', href: HAZARDS[hazard].url, target: '_blank', rel: 'noopener' }, `Hazard: ${HAZARDS[hazard].name}`))),
      h('ul', { class: 'links' }, ...def.risks.map((risk) => h('li', null, h('a', { href: risk.url, target: '_blank', rel: 'noopener' }, risk.name)))),
    );
    return h('section', { class: 'system-intro' }, h('p', null, def.role, ' ', help.button), help.content);
  }

  /** Mission history of the consultations with the ground: what was sent, when, and the answer. */
  private renderConsults(): void {
    const consults = [...this.context.store.consults].reverse();
    this.consultsSection.hidden = consults.length === 0;
    syncList<FlightSurgeonConsult>(
      this.consults,
      consults,
      (c) => `${c.id}:${c.status}`,
      (c) =>
        h(
          'div',
          { class: 'row row-consult' },
          h('span', { class: 'consult-glyph', 'aria-hidden': 'true' }, '◉'),
          h(
            'span',
            { class: 'row-text' },
            h('strong', null, `${CONSULT_PHASE_LABEL[c.status]} · ${c.environmentName}`),
            h('span', { class: 'row-sub' }, `${c.events.map((e) => `${e.label} ${formatWhen(e.t)}`).join(' → ')} · round trip ${formatRoundTrip(c.latency.roundTripSec)}`),
            h(
              'details',
              { class: 'fold' },
              h('summary', null, c.response ? 'Summary sent and answer' : 'Summary sent'),
              h('ul', { class: 'consult-lines' }, ...c.request.summary.map((line) => h('li', null, line))),
              c.response ? h('p', { class: 'row-action' }, 'Answer from Earth:') : null,
              c.response ? h('ul', { class: 'consult-lines' }, ...c.response.lines.map((line) => h('li', null, line))) : null,
            ),
          ),
        ),
      () => undefined,
    );
  }

  private renderSymptoms(): void {
    const { store, actions, system } = this.context;
    const reports = store.symptoms.filter((report) => !system || report.systemId === system).reverse();
    this.symptomsEmpty.hidden = reports.length > 0;
    syncList<SymptomReport>(
      this.symptoms,
      reports,
      (report) => String(report.id),
      (report) => {
        const systemName = store.evaluation.systems[report.systemId].def.name;
        const related = report.relatedSelfChecks.map((id) => INDICATORS[id].name);
        return h(
          'div',
          { class: 'row row-symptom' },
          h('span', { class: 'symptom-glyph', 'aria-hidden': 'true' }, '✚'),
          h(
            'span',
            { class: 'row-text' },
            h('strong', null, `${SYMPTOM_TYPE_LABEL[report.type]} · ${report.intensity}/10`),
            h('span', { class: 'row-sub' }, `${systemName} · ${formatWhen(report.t)}`),
            report.notes ? h('span', { class: 'row-note' }, report.notes) : null,
            related.length > 0 ? h('span', { class: 'row-action' }, `Related self-check${related.length > 1 ? 's' : ''}: ${related.join(', ')}`) : null,
            h(
              'span',
              { class: 'row-buttons' },
              system ? null : h('button', { class: 'link-button', type: 'button', onclick: () => store.select(report.systemId) }, `Open ${systemName.toLowerCase()}`),
              h('button', { class: 'link-button', type: 'button', 'aria-label': `Remove report: ${SYMPTOM_TYPE_LABEL[report.type]}, ${formatWhen(report.t)}`, onclick: () => actions.removeSymptom(report.id) }, 'Remove'),
            ),
          ),
        );
      },
      () => undefined,
    );
  }

  /** Mission-level background, folded away: useful to know, not needed every minute. */
  private missionContext(): HTMLElement {
    const { store } = this.context;
    const fold = (title: string, ...content: (HTMLElement | null)[]): HTMLElement => h('details', { class: 'fold' }, h('summary', null, title), h('div', { class: 'fold-body' }, ...content));
    return h(
      'section',
      { class: 'folds' },
      h('h3', null, 'Mission context'),
      store.spaceWeather ? fold('Space weather now', new SpaceWeatherCard(store.spaceWeather).element) : null,
      fold(
        'Mission medical plan',
        h('label', { class: 'check', for: 'drugs-preauthorized' }, this.drugsToggle, 'Drugs are pre-authorized in the medical plan'),
        h('p', { class: 'reference' }, 'Off by default. While it is off, every medication step is withheld: this tool supports decisions, it does not prescribe.'),
      ),
      fold('Mission environment', this.environment),
      fold(
        'About this prototype',
        h(
          'div',
          { class: 'about' },
          h(
            'p',
            null,
            'All readings come from a built-in simulator. Only two thresholds are NASA limits: cabin CO₂ (NASA-STD-3001) and retinal thickness (SANS clinical criteria). Every other range is illustrative and labeled as such. This is a concept for crew decision support, not a medical device.',
          ),
          h('p', null, 'Body systems and risks follow the NASA Human Research Program. Built for the NASA Space Apps Challenge 2026; source code written with AI assistance.'),
          h(
            'p',
            null,
            '3D anatomy: ',
            h('a', { href: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html', target: '_blank', rel: 'noopener' }, 'BodyParts3D'),
            ', © The Database Center for Life Science, licensed under CC Attribution 4.0 International. Meshes were simplified and grouped by body system; lung outlines, lymph nodes and inner ears were added.',
          ),
        ),
      ),
    );
  }

  private renderEnvironment(): void {
    const env = this.context.store.environment;
    if (this.environment.dataset.env === env.id) return;
    this.environment.dataset.env = env.id;
    this.environment.replaceChildren(
      h('p', null, h('strong', null, env.name), ` ${env.description}`),
      h(
        'dl',
        null,
        h('dt', null, 'Gravity'),
        h('dd', null, env.gravityG === 0 ? 'Microgravity' : `${env.gravityG} g`),
        h('dt', null, 'Signal delay'),
        h('dd', null, `${formatDelay(env.commsDelaySec)} one way`),
        h('dt', null, 'Radiation'),
        h('dd', null, `${env.radiationMSvPerDay} mSv/day`),
      ),
      h('p', { class: 'reference' }, `${env.radiationReference} Observed environment, not an alert threshold.`),
    );
  }
}
