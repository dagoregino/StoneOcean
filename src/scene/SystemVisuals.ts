import * as THREE from 'three';
import { STATUS_COLOR } from '../domain/status';
import { SYSTEM_IDS, type HealthStatus, type SystemId } from '../domain/types';
import type { BodyModel } from './BodyModel';

const COLORS: Record<HealthStatus, THREE.Color> = {
  unknown: new THREE.Color(STATUS_COLOR.unknown),
  nominal: new THREE.Color(STATUS_COLOR.nominal),
  caution: new THREE.Color(STATUS_COLOR.caution),
  critical: new THREE.Color(STATUS_COLOR.critical),
};

/** The body at rest: a calm grey-blue, so that only what matters carries a status color. */
const NEUTRAL = new THREE.Color(0x9a948a);
/** While the body is being scanned through the suit, everything but the selected system steps back. */
const SUBDUED_OPACITY = 0.2;
const SUBDUED_FLAGGED_OPACITY = 0.42;
const SUBDUED_HOVER_OPACITY = 0.6;
const DIMMED_OPACITY = 0.09;
const DIMMED_HOVER_OPACITY = 0.3;
/** The order in which the anatomy comes up when it is revealed: frame first, wrapping tissue last. */
const REVEAL_ORDER: SystemId[] = ['skeletal', 'cardiovascular', 'respiratory', 'metabolic', 'neuro', 'sensory', 'immune', 'muscular', 'radiation'];
const REVEAL_OVERLAP = 0.55;

interface LayerState {
  status: HealthStatus;
  color: THREE.Color;
  opacity: number;
  emphasis: number;
  focus: number;
}

/**
 * Turns application state (status, selection, hover, visibility) into what each body system
 * looks like. This is the only place where "status -> color" happens in 3D. It keeps its
 * state when the body model is swapped, so a model that loads late shows the right colors.
 */
export class SystemVisuals {
  private readonly state = new Map<SystemId, LayerState>();
  private model: BodyModel | null = null;
  private selected: SystemId | null = null;
  private hovered: SystemId | null = null;
  private hidden: ReadonlySet<SystemId> = new Set();
  private reveal = 1;
  private subdued = 0;

  constructor() {
    for (const id of SYSTEM_IDS) {
      this.state.set(id, { status: 'unknown', color: COLORS.unknown.clone(), opacity: 1, emphasis: 0, focus: 0 });
    }
  }

  setModel(model: BodyModel | null): void {
    this.model = model;
  }

  setStatus(id: SystemId, status: HealthStatus): void {
    const s = this.state.get(id);
    if (s) s.status = status;
  }

  setSelected(id: SystemId | null): void {
    this.selected = id;
  }

  setHovered(id: SystemId | null): void {
    this.hovered = id;
  }

  setHidden(hidden: ReadonlySet<SystemId>): void {
    this.hidden = hidden;
  }

  /** 0 = the anatomy is not shown at all, 1 = fully shown. In between, systems appear one after another. */
  setReveal(reveal: number): void {
    this.reveal = reveal;
  }

  /**
   * 0 = the anatomy as it normally looks; 1 = subdued, for the scan view: every system is
   * faint except the selected one. A system that needs attention keeps its status color,
   * a little stronger than the rest, but does not compete with the selection.
   */
  setSubdued(subdued: number): void {
    this.subdued = subdued;
  }

  /** The status color of a system, whether or not it is currently drawn in it. */
  statusColorOf(id: SystemId): THREE.Color {
    return COLORS[this.state.get(id)?.status ?? 'unknown'];
  }

  colorOf(id: SystemId): THREE.Color {
    return this.state.get(id)?.color ?? COLORS.unknown;
  }

  update(dt: number, elapsed: number): void {
    const ease = 1 - Math.exp(-dt * 7);
    for (const id of SYSTEM_IDS) {
      const s = this.state.get(id)!;
      const isSelected = this.selected === id;
      const isHovered = this.hovered === id;
      const dimmed = this.selected !== null && !isSelected;

      // Only what is selected or needs attention shows its status color; the rest stays neutral.
      const flagged = s.status === 'caution' || s.status === 'critical';
      const highlighted = isSelected || flagged;
      const mix = (normal: number, subdued: number): number => normal + (subdued - normal) * this.subdued;
      const resting = isSelected ? 1 : isHovered ? mix(1, SUBDUED_HOVER_OPACITY) : flagged ? mix(1, SUBDUED_FLAGGED_OPACITY) : mix(1, SUBDUED_OPACITY);
      const targetOpacity = dimmed ? (isHovered ? DIMMED_HOVER_OPACITY : DIMMED_OPACITY) : resting;
      // Alarm pulse: a second, non-color signal that something needs attention.
      const pulse =
        s.status === 'critical'
          ? 0.55 * (0.5 + 0.5 * Math.sin(elapsed * 6.5))
          : s.status === 'caution'
            ? 0.25 * (0.5 + 0.5 * Math.sin(elapsed * 2.6))
            : 0;
      // Systems that need attention glow more than healthy ones, so they stand out at a glance.
      const alert = (s.status === 'critical' ? 0.55 : s.status === 'caution' ? 0.35 : 0) * (isSelected ? 1 : 1 - 0.6 * this.subdued);
      const targetEmphasis = (isSelected ? 0.45 : 0) + (isHovered ? 0.35 : 0) + alert + pulse;

      s.color.lerp(highlighted ? COLORS[s.status] : NEUTRAL, ease);
      s.opacity += (targetOpacity - s.opacity) * ease;
      s.emphasis += (targetEmphasis - s.emphasis) * Math.min(1, ease * 2);
      s.focus += ((isSelected ? 1 : 0) - s.focus) * ease;

      const layer = this.model?.layers.get(id);
      if (!layer) continue;
      const order = REVEAL_ORDER.indexOf(id) / (REVEAL_ORDER.length - 1);
      const shown = THREE.MathUtils.clamp((this.reveal * (1 + REVEAL_OVERLAP) - order * REVEAL_OVERLAP) / 1, 0, 1) ** 1.5;
      layer.group.visible = !this.hidden.has(id) && shown > 0.01;
      if (!layer.group.visible) continue;
      for (const material of layer.materials) material.apply(s.color, s.emphasis, s.opacity * shown, elapsed, s.focus);
    }
  }
}
