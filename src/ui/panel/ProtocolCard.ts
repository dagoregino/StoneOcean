import type { AppActions } from '../../app/actions';
import { MONITORING, usesIndividualBaseline } from '../../domain/engine/monitor';
import { verificationWindowMin, type Intervention } from '../../domain/engine/verify';
import { evidenceFor } from '../../domain/evidence/catalog';
import { BASIS_LABEL, provenanceOf, type AlertProvenance } from '../../domain/evidence/indicatorRules';
import { AUTHORITY_LABEL, PROVENANCE_LABEL, VERIFICATION_LABEL, type EvidenceWithSource } from '../../domain/evidence/types';
import { offerSteps, WITHHELD_STEP, type MedicalPlan } from '../../domain/medicalPlan';
import type { DriftSummary, DriftTrigger, HealthStatus, IndicatorDef, IndicatorEvaluation } from '../../domain/types';
import { READINESS_LABEL, type ProtocolReadiness, type StepCheck } from '../../domain/resources/readiness';
import { h, setText } from '../dom';
import { formatValue, formatWhen, statusBadge, updateBadge } from '../format';
import { helpToggle } from './help';

const TRIGGER_LABEL: Record<DriftTrigger, string> = {
  single_value: 'one value far from your baseline',
  ewma: 'a sustained drift (EWMA)',
  cusum: 'an accumulated change (CUSUM)',
};

/** What the card needs besides the readings: the medical plan and the latest intervention. */
export interface CardContext {
  /** Resource Intelligence: whether the protocol can be carried out with what is on board. Null until the inventory has loaded. */
  readiness: ProtocolReadiness | null;
  plan: MedicalPlan;
  intervention?: Intervention;
}

const sourceLink = (title: string, url: string | null): HTMLElement =>
  url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, title) : h('span', null, title);

function evidenceItem(e: EvidenceWithSource): HTMLElement {
  const facts = [
    PROVENANCE_LABEL[e.provenanceClass],
    e.n === null ? 'n not reported' : `n = ${e.n}`,
    e.effect,
    e.ci95 ? `95% CI ${e.ci95[0]} to ${e.ci95[1]}` : null,
    e.p ? `p ${e.p}` : null,
  ].filter(Boolean);
  return h(
    'li',
    { class: 'evidence-item' },
    h('p', null, e.claim),
    h('p', { class: 'evidence-facts' }, facts.join(' · ')),
    h('p', { class: 'evidence-source' }, sourceLink(e.source.matchedTitle ?? e.source.title, e.source.url), ` · ${VERIFICATION_LABEL[e.verification]}`),
    h('p', { class: 'evidence-limits' }, `Limits: ${e.limitations}`),
  );
}

/**
 * The clinical detail of one indicator, as the loop the crew member follows:
 * Detect (where the threshold comes from), Treat (what to do, by authority level) and
 * Verify (the measured response that closes the action), then the evidence behind the rule.
 * Each step is collapsible; the step that needs the reader opens by itself.
 */
export class ProtocolCard {
  readonly element: HTMLElement;
  private readonly provenance: AlertProvenance;
  private readonly value = h('span', { class: 'protocol-value' }, '–');
  private readonly badge = statusBadge('unknown');
  private readonly basis = h('span', { class: 'basis' });
  private readonly reference = h('p');
  private readonly baselineRules = h('p', { class: 'provenance', hidden: true });
  private readonly treat = h('div', { class: 'dtv-body' });
  private readonly verify = h('div', { class: 'dtv-body' });
  private readonly treatStep: HTMLDetailsElement;
  private readonly verifyStep: HTMLDetailsElement;
  private readonly resources = h('div', { class: 'dtv-body' });
  private readonly resourcesStep: HTMLDetailsElement;
  private resourcesSignature = '';
  private loopSignature = '';
  private flagged: boolean | null = null;

  constructor(private readonly def: IndicatorDef, private readonly actions: AppActions, onViewTrend: () => void, private readonly onOpenResources: () => void) {
    this.provenance = provenanceOf(def.id);
    const { provenance } = this;
    const evidence = evidenceFor(provenance.rule);
    const step = (title: string, body: HTMLElement, open = false): HTMLDetailsElement => h('details', { class: 'dtv-step', open }, h('summary', null, title), body);
    this.treatStep = step('Treat', this.treat);
    this.verifyStep = step('Verify', this.verify);
    this.resourcesStep = h('details', { class: 'dtv-step dtv-resources' }, h('summary', null, 'Resources and crew'), this.resources);
    const help = helpToggle(`About ${def.name}`, h('p', null, h('strong', null, 'Why it matters. '), def.whyItMatters), h('p', null, h('strong', null, 'How to measure. '), def.howToMeasure));

    this.element = h(
      'article',
      { class: 'protocol-card' },
      h(
        'header',
        { class: 'protocol-head' },
        h('h4', null, def.name),
        help.button,
        this.value,
        this.badge,
      ),
      help.content,
      h(
        'div',
        { class: 'dtv' },
        step(
          'Detect',
          h(
            'div',
            { class: 'dtv-body' },
            h('p', null, this.basis),
            this.reference,
            this.baselineRules,
            h(
              'p',
              { class: 'provenance' },
              `Evidence: ${PROVENANCE_LABEL[provenance.evidence.provenanceClass]} · `,
              sourceLink(provenance.source.matchedTitle ?? provenance.source.title, provenance.source.url),
            ),
          ),
          true,
        ),
        this.treatStep,
        this.verifyStep,
        this.resourcesStep,
        h(
          'details',
          { class: 'dtv-step dtv-evidence' },
          h('summary', null, `Evidence for this rule (${evidence.length})`),
          h('div', { class: 'dtv-body' }, h('p', { class: 'reference' }, `${provenance.rule.condition}. ${provenance.rule.incidence}`), h('ul', { class: 'evidence-list' }, ...evidence.map(evidenceItem))),
        ),
      ),
      h('button', { class: 'link-button', type: 'button', onclick: onViewTrend }, 'View trend →'),
    );
  }

  update(evaluation: IndicatorEvaluation, context: CardContext): void {
    const { def } = this;
    const { drift } = evaluation;
    setText(this.value, evaluation.latest ? `${formatValue(evaluation.latest.value, def)} ${def.unit}` : 'No reading');
    updateBadge(this.badge, evaluation.status);
    this.element.dataset.status = evaluation.status;
    this.renderBasis(drift);
    this.renderLoop(evaluation.status, context, Boolean(drift));
    this.renderResources(context.readiness);
    // When an indicator becomes flagged (or a treatment starts), open the step that now matters. After that the reader decides.
    const flagged = evaluation.status === 'caution' || evaluation.status === 'critical';
    if (flagged !== this.flagged) {
      this.flagged = flagged;
      this.treatStep.open = flagged;
      // With an alert open, what is on board matters as much as what to do.
      this.resourcesStep.open = flagged;
    }
    if (context.intervention && !this.verifyStep.dataset.opened) {
      this.verifyStep.dataset.opened = 'true';
      this.verifyStep.open = true;
    }
  }

  dispose(): void {}

  /** Detect: what the value is compared with. The individual baseline replaces the illustrative range once it exists. */
  private renderBasis(drift: DriftSummary | undefined): void {
    const { def, provenance } = this;
    setText(this.basis, drift ? BASIS_LABEL.baseline_individual : provenance.basisLabel);
    this.basis.classList.toggle('basis-nasa', !drift && provenance.nasaLimit);
    this.baselineRules.hidden = !drift;
    if (!drift) {
      const pending = usesIndividualBaseline(def.id) ? ` Your own baseline takes over once ${MONITORING.baselineDays} days have been recorded.` : '';
      setText(this.reference, `${def.reference}${pending}`);
      return;
    }
    const precise = (value: number): string => value.toFixed(def.decimals + 1);
    const signed = (value: number): string => value.toFixed(2).replace('-', '−');
    const sensor = def.cadenceHours <= 2;
    let now = 'No value since the baseline yet.';
    if (drift.awaitingFirstValue) now = 'Waiting for the first value since the treatment; until then the earlier status stands.';
    else if (drift.current) {
      const { value, z } = drift.current;
      const distance = Math.abs(z) < 0.05 ? 'at your baseline' : `${Math.abs(z).toFixed(1)} SD ${z > 0 ? 'above' : 'below'} your baseline`;
      now = `Now ${sensor ? precise(value) : formatValue(value, def)} ${def.unit}${sensor ? ' (mean of the last 24 h)' : ''}: ${distance}.`;
    }
    setText(this.reference, `Compared with your own baseline of ${drift.baselineDays} days: ${precise(drift.baselineMean)} ± ${precise(drift.baselineSd)} ${def.unit}. ${now}`);
    const sign = drift.direction === 'low' ? '−' : drift.direction === 'high' ? '' : '±';
    const flagged = drift.trigger ? ` Flagged by ${TRIGGER_LABEL[drift.trigger]}.` : '';
    setText(
      this.baselineRules,
      `Flag rules: one value beyond ${drift.singleValueCautionLimit.toFixed(1)} SD (critical beyond ${drift.singleValueCriticalLimit.toFixed(1)}) · sustained drift, EWMA ${signed(drift.ewma)} (limit ${sign}${drift.ewmaCautionLimit.toFixed(2)}) · accumulated change, CUSUM ${drift.cusum.toFixed(1)} (limit ${drift.cusumCautionLimit.toFixed(1)}).${flagged}`,
    );
  }

  /** Treat and Verify are rebuilt only when something that affects them changes. */
  private renderLoop(status: HealthStatus, { plan, intervention, readiness }: CardContext, againstBaseline: boolean): void {
    const signature = `${status}|${plan.drugsPreauthorized}|${intervention?.id ?? 0}|${intervention?.outcome ?? ''}|${againstBaseline}|${readiness?.steps.map((s) => s.readiness).join() ?? ''}`;
    if (signature === this.loopSignature) return;
    this.loopSignature = signature;
    const { def, provenance } = this;
    const { rule } = provenance;
    const flagged = status === 'caution' || status === 'critical';

    // ---- Treat ----
    if (!flagged) {
      this.treat.replaceChildren(h('p', { class: 'quiet' }, status === 'nominal' ? 'No action needed.' : 'Waiting for a reading.'));
    } else {
      const immediate = offerSteps(def.guidance[status], plan);
      this.treat.dataset.status = status;
      this.treat.replaceChildren(
        h('p', { class: 'dtv-label' }, status === 'critical' ? 'Act now' : 'First steps'),
        h('ol', { class: 'steps' }, ...immediate.map((s) => h('li', { class: s.withheld ? 'withheld' : '' }, s.text))),
        h('p', { class: 'dtv-label' }, `Protocol: ${rule.condition}`),
        h(
          'ul',
          { class: 'protocol' },
          ...rule.treat.map((step, index) => {
            const withheld = step.requiresPreauthorization && !plan.drugsPreauthorized;
            const check = readiness?.steps[index];
            return h(
              'li',
              { class: withheld ? 'withheld' : '' },
              h('span', { class: 'level', title: AUTHORITY_LABEL[step.authorityLevel] }, `L${step.authorityLevel}`),
              h(
                'span',
                { class: 'protocol-text' },
                withheld ? WITHHELD_STEP : step.text,
                // What is on board decides whether the step can be done, so it is said on the step itself.
                check && !withheld && check.readiness !== 'no_resources' ? h('span', { class: 'step-readiness', dataset: { readiness: check.readiness } }, READINESS_LABEL[check.readiness]) : null,
              ),
              withheld
                ? null
                : h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => this.actions.startIntervention(def.id, step.text, step.authorityLevel) }, 'Done'),
            );
          }),
        ),
        ...rule.cautions.map((caution) => h('p', { class: 'caution-note' }, caution)),
      );
    }

    // ---- Verify ----
    const unit = def.unit;
    const shown = (value: number | null): string => (value === null ? 'no value' : `${formatValue(value, def)} ${unit}`);
    const target = againstBaseline ? 'within your usual range' : 'in range';
    const windowHours = Math.round(verificationWindowMin(def, againstBaseline) / 60);
    let state: HTMLElement;
    if (!intervention) {
      state = h('p', { class: 'quiet' }, flagged ? 'No treatment recorded yet. Press “Done” on a step once you have carried it out.' : 'Nothing to verify.');
    } else if (intervention.outcome === 'pending') {
      state = h(
        'p',
        { class: 'verify-state', dataset: { outcome: 'pending' } },
        h('strong', null, 'Waiting for a measured response. '),
        `“${intervention.stepText}” was done at ${formatWhen(intervention.startedAt)} with ${shown(intervention.valueBefore)}. It closes when this indicator is measured back ${target}, within ${windowHours} h.`,
      );
    } else if (intervention.outcome === 'verified') {
      state = h(
        'p',
        { class: 'verify-state', dataset: { outcome: 'verified' } },
        h('strong', null, '● Verified. '),
        `${shown(intervention.valueBefore)} before, ${shown(intervention.valueAfter)} at ${formatWhen(intervention.checkedAt ?? intervention.startedAt)}: back ${target} after “${intervention.stepText}”`,
      );
    } else {
      state = h(
        'p',
        { class: 'verify-state', dataset: { outcome: 'not_verified' } },
        h('strong', null, '◆ Not verified. '),
        `Still out of range (${shown(intervention.valueAfter)}) ${windowHours} h after “${intervention.stepText}”. Move to the next authority level.`,
      );
    }
    this.verify.replaceChildren(h('p', null, rule.verify.criterion), state);
  }

  /**
   * Resource Intelligence for this protocol: what it needs, what is on board and usable,
   * who is trained and available, and what has to go to the responsible medical staff.
   */
  private renderResources(readiness: ProtocolReadiness | null): void {
    const signature = readiness ? JSON.stringify([readiness.steps.map((s) => [s.readiness, s.limitations]), readiness.personnel.map((p) => p.detail)]) : 'none';
    if (signature === this.resourcesSignature) return;
    this.resourcesSignature = signature;
    if (!readiness) {
      this.resources.replaceChildren(h('p', { class: 'quiet' }, 'The inventory is still loading.'));
      return;
    }
    const list = (title: string, kind: string, items: string[]): HTMLElement | null =>
      items.length === 0 ? null : h('div', { class: 'ri-group', dataset: { kind } }, h('p', { class: 'dtv-label' }, title), h('ul', null, ...items.map((text) => h('li', null, text))));
    const stepLine = (s: StepCheck): string => `Step ${s.index + 1}: ${s.step.text}`;
    const checked = readiness.steps.filter((s) => s.readiness !== 'no_resources');
    const blocks = [
      list('Protocol steps that can be carried out now', 'ok', readiness.executable.map(stepLine)),
      list('On board and usable', 'ok', readiness.available.map((c) => `${c.alternative ? `${c.alternative.label} (accepted by the protocol in place of ${c.need.label})` : c.need.label}: ${c.freeUnits} usable, ${c.need.quantity} needed`)),
      list('Missing or not enough', 'critical', readiness.missing.map((c) => `${c.need.label}: ${c.detail}`)),
      list('On board but not usable', 'critical', readiness.nonOperational.map((c) => `${c.need.label}: ${c.detail}`)),
      list('Trained crew', 'neutral', readiness.personnel.map((p) => `${p.procedure}: ${p.detail}`)),
      list('Limits to keep in mind', 'attention', readiness.limitations),
      list('Goes to the responsible medical staff', 'critical', readiness.escalations),
    ].filter((el): el is HTMLElement => el !== null);
    this.resources.replaceChildren(
      ...(checked.length === 0 ? [h('p', { class: 'quiet' }, 'This protocol needs nothing from the medical inventory.')] : blocks),
      h('p', { class: 'provenance' }, 'A check of what is on board, not medical advice: an item being available does not make using it appropriate. Resource requirements are simulated mission configuration.'),
      h('button', { class: 'link-button', type: 'button', onclick: this.onOpenResources }, 'Open Medical Resources →'),
    );
  }
}
