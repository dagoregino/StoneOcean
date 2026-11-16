import * as THREE from 'three';
import type { BodyPoint } from '../domain/symptoms';

/** One pin on the body. Positions are in the body's own frame. */
export interface SymptomMarkerSpec {
  key: string;
  position: BodyPoint;
  /** 1..10: a stronger discomfort gets a slightly larger pin. */
  intensity: number;
  /** A spot that has been picked but not yet saved. */
  draft: boolean;
}

/** Not a status color: status colors are reserved for the health status of a body system. */
const REPORTED = 0xc98e9e;
const DRAFT = 0xece8df;
const PULSE_SECONDS = 2.4;

interface Marker {
  group: THREE.Group;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  coreMaterial: THREE.MeshBasicMaterial;
  phase: number;
}

/**
 * Pins where the crew member reported discomfort: a small core and a ring that faces the
 * viewer and pulses slowly. They are drawn over the anatomy, so a pin is never lost inside it.
 */
export class SymptomMarkers {
  readonly object = new THREE.Group();
  private readonly coreGeometry = new THREE.SphereGeometry(0.007, 16, 12);
  private readonly ringGeometry = new THREE.RingGeometry(0.013, 0.016, 40);
  private readonly markers = new Map<string, Marker>();
  private readonly still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    this.object.name = 'symptom-markers';
  }

  /** Replaces the set of pins. Pins that stay keep their pulse. */
  set(specs: readonly SymptomMarkerSpec[]): void {
    const keep = new Set(specs.map((spec) => spec.key));
    for (const [key, marker] of this.markers) {
      if (keep.has(key)) continue;
      this.remove(marker);
      this.markers.delete(key);
    }
    for (const spec of specs) {
      const marker = this.markers.get(spec.key) ?? this.create(spec.key);
      const color = spec.draft ? DRAFT : REPORTED;
      marker.coreMaterial.color.setHex(color);
      marker.ringMaterial.color.setHex(color);
      marker.group.position.set(spec.position.x, spec.position.y, spec.position.z);
      marker.group.scale.setScalar(0.8 + 0.06 * spec.intensity);
    }
  }

  update(elapsed: number, camera: THREE.Camera): void {
    for (const marker of this.markers.values()) {
      marker.ring.quaternion.copy(camera.quaternion);
      if (this.still) continue;
      const cycle = (elapsed / PULSE_SECONDS + marker.phase) % 1;
      marker.ring.scale.setScalar(1 + 1.3 * cycle);
      marker.ringMaterial.opacity = 0.95 * (1 - cycle) ** 1.5;
    }
  }

  dispose(): void {
    this.markers.forEach((marker) => this.remove(marker));
    this.markers.clear();
    this.coreGeometry.dispose();
    this.ringGeometry.dispose();
  }

  private create(key: string): Marker {
    const material = (opacity: number): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({ transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const coreMaterial = material(1);
    const ringMaterial = material(0.9);
    const core = new THREE.Mesh(this.coreGeometry, coreMaterial);
    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    core.renderOrder = ring.renderOrder = 1000;
    const group = new THREE.Group();
    group.add(core, ring);
    this.object.add(group);
    const marker: Marker = { group, ring, ringMaterial, coreMaterial, phase: Math.random() };
    this.markers.set(key, marker);
    return marker;
  }

  private remove(marker: Marker): void {
    this.object.remove(marker.group);
    marker.coreMaterial.dispose();
    marker.ringMaterial.dispose();
  }
}
