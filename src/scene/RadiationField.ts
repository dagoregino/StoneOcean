import * as THREE from 'three';

/** Ambient, not a spectacle: few, faint, slow streaks that never compete with the figure. */
const MAX_PARTICLES = 24;
const PARTICLES_PER_MSV_DAY = 12;
const OPACITY = 0.08;
const SPEED_MIN = 0.12;
const SPEED_RANGE = 0.18;
const STREAK = 0.025;
const RADIUS = 2.4;
const RADIUS_SQ = RADIUS * RADIUS;
const CENTER = new THREE.Vector3(0, 0.9, 0);

/**
 * Energetic particles drifting through the cabin. Their number follows the current dose
 * rate, so a solar particle event is visible before the dose total crosses a threshold.
 *
 * Nothing is allocated per frame: every vector is created once and reused.
 */
export class RadiationField {
  readonly object: THREE.LineSegments;
  private readonly positions = new Float32Array(MAX_PARTICLES * 6);
  private readonly attribute: THREE.BufferAttribute;
  private readonly heads: THREE.Vector3[] = [];
  private readonly directions: THREE.Vector3[] = [];
  private readonly speeds = new Float32Array(MAX_PARTICLES);
  private readonly material: THREE.LineBasicMaterial;
  private readonly start = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private active = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.heads.push(new THREE.Vector3());
      this.directions.push(new THREE.Vector3());
      this.respawn(i, true);
    }
    const geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.attribute);
    geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({ transparent: true, opacity: OPACITY, blending: THREE.AdditiveBlending, depthWrite: false });
    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
  }

  /** @param mSvPerDay current dose rate */
  setDoseRate(mSvPerDay: number): void {
    this.active = Math.round(Math.min(MAX_PARTICLES, Math.max(0, mSvPerDay) * PARTICLES_PER_MSV_DAY));
    this.object.geometry.setDrawRange(0, this.active * 2);
    this.object.visible = this.active > 0;
  }

  setColor(color: THREE.Color): void {
    this.material.color.copy(color);
  }

  update(dt: number): void {
    if (this.active === 0) return;
    const positions = this.positions;
    for (let i = 0; i < this.active; i++) {
      const head = this.heads[i];
      const direction = this.directions[i];
      head.addScaledVector(direction, this.speeds[i] * dt);
      if (head.distanceToSquared(CENTER) > RADIUS_SQ) this.respawn(i, false);
      const o = i * 6;
      positions[o] = head.x;
      positions[o + 1] = head.y;
      positions[o + 2] = head.z;
      positions[o + 3] = head.x - direction.x * STREAK;
      positions[o + 4] = head.y - direction.y * STREAK;
      positions[o + 5] = head.z - direction.z * STREAK;
    }
    this.attribute.needsUpdate = true;
  }

  /** Places a particle on the boundary sphere, aimed at a random point near the body. */
  private respawn(i: number, anywhere: boolean): void {
    this.start.randomDirection().multiplyScalar(RADIUS * 0.98).add(CENTER);
    this.aim.randomDirection().multiplyScalar(Math.random() * 1.1).add(CENTER);
    this.directions[i].copy(this.aim).sub(this.start).normalize();
    this.speeds[i] = SPEED_MIN + Math.random() * SPEED_RANGE;
    this.heads[i].copy(this.start);
    if (anywhere) this.heads[i].addScaledVector(this.directions[i], Math.random() * RADIUS * 1.6);
  }
}
