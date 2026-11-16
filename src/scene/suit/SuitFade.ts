import * as THREE from 'three';

/** Tint of the suit once it has become a hologram. */
export const HOLOGRAM_COLOR = 0xa9c7d8;

/**
 * Draw order of everything that is, or can become, see-through in the twin. Three.js draws
 * opaque objects first and then transparent ones in `renderOrder`:
 *
 *   1..3  anatomy (solid tissue, veils, outer shell)   - see GltfBody / ProceduralBody
 *   4     suit, depth only                             - SUIT_DEPTH_ORDER
 *   5     suit, color                                  - SUIT_COLOR_ORDER
 *   6     scan ring                                    - HealthTwin
 *   1000  discomfort pins (drawn over everything)      - SymptomMarkers
 */
export const SUIT_DEPTH_ORDER = 4;
export const SUIT_COLOR_ORDER = 5;

type Tinted = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color };

interface Entry {
  material: Tinted;
  color: THREE.Color | null;
  emissive: THREE.Color | null;
  side: THREE.Side;
  /** Kept at its own color whatever the opacity (a status light, for instance). */
  keepColor: boolean;
}

/**
 * Fades a suit between solid and hologram without the usual artifacts of transparency.
 *
 * A suit is many overlapping shells (helmet over collar, sleeve inside glove). Blended
 * naively, every hidden surface shows through and the overlaps add up to darker patches.
 * So while the suit is see-through it is drawn twice: first to the depth buffer only, then
 * in color where it matches that depth. Only the surface nearest the viewer is blended, and
 * the anatomy, already drawn, shows through it evenly.
 *
 * While the suit is solid none of this is active: it is an ordinary opaque object.
 */
export class SuitFade {
  private readonly entries: Entry[] = [];
  private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
  private readonly depthMeshes: THREE.Mesh[] = [];
  private readonly hologram = new THREE.Color(HOLOGRAM_COLOR);
  private translucent: boolean | null = null;

  /**
   * @param meshes    every mesh of the suit, each with materials that belong to this suit alone
   * @param keepColor materials that must not be tinted by the hologram
   */
  constructor(meshes: readonly THREE.Mesh[], keepColor: ReadonlySet<THREE.Material> = new Set()) {
    const seen = new Set<THREE.Material>();
    for (const mesh of meshes) {
      mesh.renderOrder = SUIT_COLOR_ORDER;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(material)) continue;
        seen.add(material);
        const tinted = material as Tinted;
        this.entries.push({ material: tinted, color: tinted.color?.clone() ?? null, emissive: tinted.emissive?.clone() ?? null, side: material.side, keepColor: keepColor.has(material) });
      }
      // A skinned mesh is posed by its skeleton; a plain copy would not follow it, so it goes without the depth pass.
      if (mesh instanceof THREE.SkinnedMesh || !mesh.parent) continue;
      const depth = new THREE.Mesh(mesh.geometry, this.depthOnly);
      depth.position.copy(mesh.position);
      depth.quaternion.copy(mesh.quaternion);
      depth.scale.copy(mesh.scale);
      depth.renderOrder = SUIT_DEPTH_ORDER;
      depth.visible = false;
      mesh.parent.add(depth);
      this.depthMeshes.push(depth);
    }
  }

  /** Remembers a new resting color for a material (a status light changing color). */
  setBaseColor(material: THREE.Material, color: THREE.Color): void {
    const entry = this.entries.find((e) => e.material === material);
    entry?.color?.copy(color);
    entry?.material.color?.copy(color);
  }

  /** How far the suit has turned into a hologram at this opacity: 0 = fabric, 1 = light. */
  hologramAt(opacity: number): number {
    return 1 - THREE.MathUtils.smoothstep(opacity, 0.3, 0.9);
  }

  setOpacity(opacity: number): void {
    const translucent = opacity < 0.98;
    const holo = this.hologramAt(opacity);
    if (translucent !== this.translucent) {
      this.translucent = translucent;
      for (const depth of this.depthMeshes) depth.visible = translucent;
      for (const { material, side } of this.entries) {
        material.transparent = translucent;
        // Solid: writes depth like any object. See-through: the depth pass has written it already.
        material.depthWrite = !translucent;
        // Back faces would be blended on top of the front ones.
        material.side = translucent ? THREE.FrontSide : side;
        material.needsUpdate = true;
      }
    }
    for (const { material, color, emissive, keepColor } of this.entries) {
      material.opacity = translucent ? opacity : 1;
      if (keepColor) continue;
      if (color && material.color) material.color.copy(color).lerp(this.hologram, holo);
      if (emissive && material.emissive) material.emissive.copy(emissive).lerp(this.hologram, 0.35 * holo);
    }
  }

  dispose(): void {
    for (const depth of this.depthMeshes) depth.parent?.remove(depth);
    this.depthOnly.dispose();
  }
}
