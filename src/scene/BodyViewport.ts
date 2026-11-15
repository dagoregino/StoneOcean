import * as THREE from 'three';
import type { HealthStore } from '../data/HealthStore';
import { SYSTEMS } from '../domain/catalog/systems';
import { STATUS_COLOR, STATUS_GLYPH, STATUS_LABEL } from '../domain/status';
import type { TwinView } from '../domain/twinView';
import { SYSTEM_IDS, type Evaluation, type SystemId } from '../domain/types';
import { createBackdrop } from './backdrop';
import type { BodyModel, Vitals } from './BodyModel';
import { HealthTwin, SCAN_SECONDS } from './HealthTwin';
import { Picker } from './Picker';
import { RadiationField } from './RadiationField';
import { SceneManager } from './SceneManager';
import { SymptomMarkers } from './SymptomMarkers';
import { SystemVisuals } from './SystemVisuals';

const MINUTES_PER_DAY = 1440;
/** Systems that span the whole figure keep the full-body view when selected. */
const WHOLE_BODY_HEIGHT = 1.1;

export interface BodyViewportOptions {
  /** URL of the anatomical model (GLB). */
  modelUrl: string;
  /** URL of the astronaut model (GLB). While the file does not exist, the astronaut modelled in code is used. */
  suitUrl: string;
}

/**
 * The 3D view. It reads the store and reports clicks back to it; it holds no health logic.
 * Store -> (status, selection, hover, visibility) -> SystemVisuals -> materials.
 *
 * The anatomical model loads in the background. If it cannot be loaded (offline, blocked
 * download), the view falls back to a body generated in code, so the app always works.
 */
export class BodyViewport {
  private readonly scene: SceneManager;
  private readonly visuals = new SystemVisuals();
  private readonly twin = new HealthTwin(this.visuals);
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly picker: Picker;
  private readonly radiation = new RadiationField();
  private readonly symptomMarkers = new SymptomMarkers();
  private readonly tooltip: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly scanCaption: HTMLDivElement;
  private scanTimers: number[] = [];
  private readonly bounds = new Map<SystemId, THREE.Box3>();
  private readonly vitals: Vitals = { heartRateBpm: 62, breathsPerMinute: 14 };
  private readonly unsubscribe: (() => void)[] = [];
  private model: BodyModel | null = null;
  private readonly overall = new THREE.Color();

  constructor(
    private readonly container: HTMLElement,
    private readonly store: HealthStore,
    options: BodyViewportOptions,
  ) {
    this.scene = new SceneManager(container);
    const backdrop = createBackdrop();
    this.scene.scene.add(backdrop.object, this.radiation.object, this.symptomMarkers.object, this.twin.root);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'viewport-tooltip';
    this.tooltip.hidden = true;
    this.notice = document.createElement('div');
    this.notice.className = 'viewport-notice';
    this.notice.setAttribute('role', 'status');
    this.scanCaption = document.createElement('div');
    this.scanCaption.className = 'scan-caption';
    this.scanCaption.setAttribute('role', 'status');
    this.scanCaption.hidden = true;
    container.append(this.tooltip, this.notice, this.scanCaption);

    this.picker = new Picker(
      this.scene.renderer.domElement,
      this.scene.camera,
      // The suit while the astronaut is on show, the anatomy once it is revealed.
      () => this.twin.pickTarget,
      (id) => store.hidden.has(id),
      {
        onHover: (stack, x, y) => this.showHover(stack, x, y),
        onPick: (stack, surface) => this.pick(stack, surface),
      },
    );

    this.unsubscribe.push(
      store.events.on('data', (evaluation) => this.applyEvaluation(evaluation)),
      store.events.on('selection', (id) => this.applySelection(id)),
      store.events.on('hover', (id) => this.visuals.setHovered(id)),
      store.events.on('visibility', (hidden) => this.visuals.setHidden(hidden)),
      store.events.on('symptoms', () => this.applySymptoms()),
      store.events.on('symptomDraft', () => this.applySymptoms()),
      store.events.on('reportMode', () => this.applyReportMode()),
      store.events.on('twinView', (view) => this.applyView(view)),
      store.events.on('environment', (env) => this.twin.setWeightless(env.gravityG === 0)),
      this.scene.onFrame((dt, elapsed) => {
        this.picker.update();
        this.visuals.update(dt, elapsed);
        this.model?.update(elapsed, this.vitals);
        this.twin.update(dt, elapsed, this.vitals);
        this.radiation.setColor(this.visuals.colorOf('radiation'));
        this.radiation.update(dt);
        this.symptomMarkers.update(elapsed, this.scene.camera);
        backdrop.update(elapsed);
      }),
    );

    this.applyEvaluation(store.evaluation);
    this.visuals.setSelected(store.selected);
    this.applySymptoms();
    this.applyReportMode();
    this.twin.setWeightless(store.environment.gravityG === 0);
    this.twin.setView(store.twinView);
    this.scene.start();
    void this.loadModel(options.modelUrl);
    void this.loadSuit(options.suitUrl);
  }

  dispose(): void {
    this.unsubscribe.forEach((off) => off());
    this.picker.dispose();
    this.symptomMarkers.dispose();
    this.twin.dispose();
    this.model?.dispose();
    this.scene.dispose();
    this.scanTimers.forEach((timer) => window.clearTimeout(timer));
    this.tooltip.remove();
    this.notice.remove();
    this.scanCaption.remove();
  }

  private async loadModel(url: string): Promise<void> {
    this.notice.textContent = 'Loading anatomical model…';
    try {
      // Loaded on demand: the loader and the model are the heaviest part of the app.
      const { GltfBody } = await import('./gltf/GltfBody');
      this.setModel(
        await GltfBody.load(url, (fraction) => {
          this.notice.textContent = `Loading anatomical model… ${Math.round(fraction * 100)}%`;
        }),
      );
      this.notice.hidden = true;
    } catch (error) {
      console.warn('Anatomical model unavailable, using the simplified body.', error);
      const { ProceduralBody } = await import('./procedural/ProceduralBody');
      this.setModel(new ProceduralBody());
      this.notice.textContent = 'Detailed anatomy could not be loaded. Showing a simplified body.';
      window.setTimeout(() => (this.notice.hidden = true), 6000);
    }
  }

  private setModel(model: BodyModel): void {
    const previous = this.model;
    this.model = model;
    this.twin.setBody(model, previous);
    previous?.dispose();
    // Pins are stored in the body's frame: they follow whichever model is shown.
    model.root.add(this.symptomMarkers.object);
    this.visuals.setModel(model);
    this.bounds.clear();
    for (const [id, layer] of model.layers) this.bounds.set(id, new THREE.Box3().setFromObject(layer.group));
    this.symptomMarkers.object.visible = this.store.twinView !== 'astronaut';
    this.applySelection(this.store.selected);
  }

  private applyEvaluation(evaluation: Evaluation): void {
    for (const id of SYSTEM_IDS) this.visuals.setStatus(id, evaluation.systems[id].status);
    this.twin.setStatusColor(this.overall.set(STATUS_COLOR[evaluation.triage.status]));

    const heartRate = evaluation.systems.cardiovascular.indicators.find((i) => i.def.id === 'heartRate')?.latest?.value;
    if (heartRate) this.vitals.heartRateBpm = heartRate;

    // Dose rate from the last two dosimeter readings; falls back to the environment's typical rate.
    const dose = this.store.history('radiationDose');
    let rate = this.store.environment.radiationMSvPerDay;
    if (dose.length >= 2) {
      const a = dose[dose.length - 2];
      const b = dose[dose.length - 1];
      if (b.t > a.t) rate = ((b.value - a.value) / (b.t - a.t)) * MINUTES_PER_DAY;
    }
    this.radiation.setDoseRate(rate);
  }

  private applySelection(id: SystemId | null): void {
    this.visuals.setSelected(id);
    const box = id ? this.bounds.get(id) : null;
    const wholeBody = !box || box.isEmpty() || box.getSize(new THREE.Vector3()).y > WHOLE_BODY_HEIGHT;
    this.scene.focusOn(wholeBody ? null : box);
  }

  /** Clicking the same spot again steps to the next system underneath ("go deeper"). */
  private pick(stack: SystemId[], surface: THREE.Vector3 | null): void {
    if (this.store.twinView === 'astronaut') {
      // A click on the astronaut scans it and opens the anatomy: no stop in between.
      if (stack.length > 0) this.store.setTwinView('anatomy');
      return;
    }
    if (this.store.reportMode) {
      // Reporting discomfort: the click marks a spot instead of selecting a system.
      if (!surface || stack.length === 0 || !this.model) return;
      const { x, y, z } = this.model.root.worldToLocal(surface.clone());
      // Radiation exposure surrounds the whole figure: it is a dose, not a place that can hurt.
      const anatomical = stack.filter((id) => id !== 'radiation');
      this.store.setSymptomDraft({ position: { x, y, z }, systems: anatomical.length > 0 ? anatomical : stack });
      return;
    }
    if (stack.length === 0) {
      this.store.select(null);
      return;
    }
    const current = this.store.selected ? stack.indexOf(this.store.selected) : -1;
    this.store.select(stack[(current + 1) % stack.length]);
  }

  /** The astronaut is the model at `url` when that file exists; otherwise the one modelled in code. */
  private async loadSuit(url: string): Promise<void> {
    const { GltfSuit } = await import('./suit/GltfSuit');
    const suit = await GltfSuit.load(url);
    if (suit) {
      this.twin.setSuit(suit);
      return;
    }
    const { ProceduralSuit } = await import('./suit/ProceduralSuit');
    this.twin.setSuit(new ProceduralSuit());
  }

  private applyView(view: TwinView): void {
    const scanned = this.twin.setView(view);
    this.symptomMarkers.object.visible = view !== 'astronaut';
    if (scanned) {
      this.captionScan();
      // Bring the figure round to face the viewer while the scanner passes, whole body in frame.
      if (!this.store.selected) this.scene.faceFront(this.reducedMotion ? 0 : SCAN_SECONDS);
    }
    if (view === 'astronaut') {
      this.tooltip.hidden = true;
      this.scene.focusOn(null);
    }
  }

  /** Says what the scanner is doing, then gets out of the way: two short lines, shown once. */
  private captionScan(): void {
    this.scanTimers.forEach((timer) => window.clearTimeout(timer));
    const scanMs = this.reducedMotion ? 0 : SCAN_SECONDS * 1000;
    const show = (text: string, done: boolean): void => {
      this.scanCaption.textContent = text;
      this.scanCaption.classList.toggle('is-done', done);
      this.scanCaption.hidden = false;
    };
    if (scanMs > 0) show('Scanning crew member…', false);
    this.scanTimers = [
      window.setTimeout(() => show('Body systems mapped', true), scanMs),
      window.setTimeout(() => this.scanCaption.classList.add('is-leaving'), scanMs + 650),
      window.setTimeout(() => {
        this.scanCaption.hidden = true;
        this.scanCaption.classList.remove('is-leaving', 'is-done');
      }, scanMs + 900),
    ];
  }

  private applySymptoms(): void {
    const draft = this.store.symptomDraft;
    this.symptomMarkers.set([
      ...this.store.symptoms.map((report) => ({ key: `report-${report.id}`, position: report.position, intensity: report.intensity, draft: false })),
      ...(draft ? [{ key: 'draft', position: draft.position, intensity: 5, draft: true }] : []),
    ]);
  }

  private applyReportMode(): void {
    const reporting = this.store.reportMode;
    this.container.classList.toggle('is-reporting', reporting);
    this.scene.renderer.domElement.style.cursor = reporting ? 'crosshair' : 'grab';
    // Hold the figure still while a spot is being chosen.
    if (reporting) this.scene.controls.autoRotate = false;
  }

  private showHover(stack: SystemId[], clientX: number, clientY: number): void {
    if (this.store.twinView === 'astronaut') {
      const over = stack.length > 0;
      this.twin.setPeek(over);
      this.scene.renderer.domElement.style.cursor = over ? 'pointer' : 'grab';
      this.tooltip.hidden = !over;
      if (!over) return;
      delete this.tooltip.dataset.status;
      this.tooltip.replaceChildren(
        Object.assign(document.createElement('span'), { className: 'status-glyph', textContent: '' }),
        Object.assign(document.createElement('strong'), { textContent: 'Explore my body' }),
        Object.assign(document.createElement('small'), { textContent: 'Click the astronaut to see inside' }),
      );
      this.placeTooltip(clientX, clientY);
      return;
    }
    const id = stack[0] ?? null;
    this.store.hover(id);
    const reporting = this.store.reportMode;
    this.scene.renderer.domElement.style.cursor = reporting ? 'crosshair' : id ? 'pointer' : 'grab';
    if (!id) {
      this.tooltip.hidden = true;
      return;
    }
    const status = this.store.evaluation.systems[id].status;
    this.tooltip.hidden = false;
    this.tooltip.dataset.status = status;
    this.tooltip.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'status-glyph', textContent: STATUS_GLYPH[status] }),
      Object.assign(document.createElement('strong'), { textContent: SYSTEMS[id].name }),
      Object.assign(document.createElement('span'), { className: 'tooltip-status', textContent: STATUS_LABEL[status] }),
    );
    if (reporting) {
      this.tooltip.appendChild(Object.assign(document.createElement('small'), { textContent: 'Click to mark the discomfort here' }));
    } else if (stack.length > 1) {
      this.tooltip.appendChild(
        Object.assign(document.createElement('small'), { textContent: `Click again for ${SYSTEMS[stack[1]].name.toLowerCase()}` }),
      );
    }
    this.placeTooltip(clientX, clientY);
  }

  private placeTooltip(clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect();
    const x = Math.min(clientX - rect.left + 16, rect.width - 220);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${clientY - rect.top + 16}px)`;
  }
}
