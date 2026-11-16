import * as THREE from 'three';
import type { AstronautSuit } from './AstronautSuit';
import { bellows, limb, loft, ring, soleShape } from './shapes';
import { SuitFade } from './SuitFade';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/**
 * The built-in astronaut: a modern pressure suit modelled in code, shown while no
 * `public/models/astronaut.glb` is provided (that file replaces it automatically).
 *
 * It is drawn as a person in a suit, not as an assembly of parts: a lofted torso that
 * narrows from shoulders to waist, limbs that taper, pleated joints, gloves with fingers,
 * broad boots, and the hardware a real suit carries (neck ring, life-support backpack,
 * chest control panel, wrist and ankle rings). Materials are sober: off-white fabric with
 * high roughness, a little brushed metal, a dark reflective visor.
 *
 * Frame: metres, feet at y = 0, facing +z, sized to enclose the 1.76 m anatomical body.
 */
export class ProceduralSuit implements AstronautSuit {
  readonly root = new THREE.Group();
  readonly pickables: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly torso = new THREE.Group();
  private readonly fabric = this.material({ color: 0xf1f2f4, roughness: 0.92, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.1 });
  private readonly pleat = this.material({ color: 0xdcdfe4, roughness: 0.95, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.06 });
  private readonly shell = this.material({ color: 0xf6f7f9, roughness: 0.55, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.1 });
  private readonly metal = this.material({ color: 0x9aa3b0, roughness: 0.42, metalness: 0.55 });
  private readonly blue = this.material({ color: 0x3d6b8a, roughness: 0.6, metalness: 0.1 });
  private readonly dark = this.material({ color: 0x353b47, roughness: 0.85, metalness: 0.05 });
  private readonly visor = this.track(
    new THREE.MeshPhysicalMaterial({ color: 0x101820, roughness: 0.1, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0x16262f, emissiveIntensity: 0.3 }),
  );
  private readonly glow = this.material({ color: 0xa9c7d8, roughness: 0.4, metalness: 0, emissive: 0x7f9db0, emissiveIntensity: 1.4 });
  private readonly lamp = this.material({ color: 0x8d897f, roughness: 0.4, metalness: 0 });
  private readonly fade: SuitFade;

  constructor() {
    this.root.name = 'astronaut-suit';
    this.torso.position.set(0, 1.2, 0);
    this.root.add(this.torso);

    this.buildHelmet();
    this.buildTorso();
    this.buildBackpack();
    this.buildChestPanel();
    for (const side of [1, -1]) {
      this.buildArm(side);
      this.buildLeg(side);
    }

    // Created last: it copies each mesh once it is in its final place.
    this.fade = new SuitFade(this.pickables, new Set([this.lamp, this.glow]));
  }

  setOpacity(opacity: number): void {
    this.root.visible = opacity > 0.01;
    this.fade.setOpacity(opacity);
    this.root.scale.setScalar(1 + 0.02 * this.fade.hologramAt(opacity));
  }

  setStatusColor(color: THREE.Color): void {
    this.fade.setBaseColor(this.lamp, color);
    this.lamp.emissive.copy(color);
    this.lamp.emissiveIntensity = 1.6;
  }

  update(_elapsed: number, breath: number): void {
    this.torso.scale.set(1 + 0.008 * breath, 1 + 0.004 * breath, 1 + 0.018 * breath);
  }

  dispose(): void {
    this.fade.dispose();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
  }

  // ---------- Parts ----------

  private buildHelmet(): void {
    const centre = V(0, 1.642, 0.012);
    const radius = 0.17;
    // The white outer shell, slightly taller than it is wide.
    this.add(this.root, new THREE.SphereGeometry(radius, 48, 32), this.shell, centre, [1, 1.05, 1.02]);
    // Visor: a band of a slightly larger sphere, wrapped around the face, inside a grey frame.
    const band = (r: number, halfWidth: number, top: number, height: number, material: THREE.Material): void => {
      this.add(this.root, new THREE.SphereGeometry(r, 48, 24, Math.PI / 2 - halfWidth, halfWidth * 2, top, height), material, centre, [1, 1.05, 1.02]);
    };
    band(radius + 0.0025, 1.3, 0.95, 1.2, this.metal);
    band(radius + 0.005, 1.22, 1.02, 1.06, this.visor);
    // A small blue light on the brow, and the communications caps at the sides.
    this.add(this.root, new THREE.CapsuleGeometry(0.006, 0.05, 4, 10), this.glow, V(0, 1.787, 0.092), [1, 1, 1], new THREE.Euler(0.55, 0, Math.PI / 2));
    for (const side of [1, -1]) {
      this.add(this.root, new THREE.CylinderGeometry(0.034, 0.04, 0.022, 24), this.metal, V(side * 0.172, 1.63, 0.0), [1, 1, 1], new THREE.Euler(0, 0, Math.PI / 2));
      this.add(this.root, new THREE.CylinderGeometry(0.018, 0.018, 0.026, 16), this.blue, V(side * 0.176, 1.63, 0.0), [1, 1, 1], new THREE.Euler(0, 0, Math.PI / 2));
    }
    // Neck ring: where the helmet locks onto the suit.
    this.add(this.root, ring(0.132, 0.034, 0.03), this.metal, V(0, 1.468, 0.008));
    this.add(this.root, ring(0.149, 0.007, 0.006), this.blue, V(0, 1.468, 0.008));
  }

  private buildTorso(): void {
    const y = (value: number): number => value - this.torso.position.y;
    // Shoulders wider than the waist, then out again over the hips: a person, not a box.
    this.add(
      this.torso,
      loft(
        [
          { y: y(1.475), rx: 0.118, rz: 0.11, cz: 0.006 },
          { y: y(1.445), rx: 0.172, rz: 0.125, cz: 0.004 },
          { y: y(1.405), rx: 0.238, rz: 0.142 },
          { y: y(1.34), rx: 0.252, rz: 0.158, cz: 0.004 },
          { y: y(1.24), rx: 0.24, rz: 0.158, cz: 0.006 },
          { y: y(1.13), rx: 0.218, rz: 0.148, cz: 0.004 },
          { y: y(1.045), rx: 0.2, rz: 0.138 },
          { y: y(1.0), rx: 0.198, rz: 0.136 },
        ],
        2.7,
      ),
      this.fabric,
      V(0, 0, 0),
    );
    // Waist bearing, then the pelvis: broad at the hips, closing between the legs.
    this.add(this.root, ring(0.196, 0.03, 0.022), this.metal, V(0, 0.995, 0), [1, 1, 0.7]);
    this.add(
      this.root,
      loft(
        [
          { y: 0.985, rx: 0.2, rz: 0.137 },
          { y: 0.93, rx: 0.218, rz: 0.146 },
          { y: 0.87, rx: 0.224, rz: 0.148 },
          { y: 0.81, rx: 0.205, rz: 0.138 },
          { y: 0.765, rx: 0.14, rz: 0.11 },
          { y: 0.745, rx: 0.06, rz: 0.07 },
        ],
        2.5,
      ),
      this.fabric,
      V(0, 0, 0),
    );
    // Seams: thin lines where the suit's panels meet.
    this.add(this.torso, ring(0.249, 0.004, 0.004), this.dark, V(0, y(1.3), 0.004), [1, 1, 0.635]);
    this.add(this.root, ring(0.222, 0.004, 0.004), this.dark, V(0, 0.9, 0), [1, 1, 0.66]);
  }

  /** The life-support backpack (PLSS). */
  private buildBackpack(): void {
    const y = (value: number): number => value - this.torso.position.y;
    this.add(
      this.torso,
      loft(
        [
          { y: y(1.545), rx: 0.15, rz: 0.062 },
          { y: y(1.52), rx: 0.172, rz: 0.08 },
          { y: y(1.1), rx: 0.176, rz: 0.086 },
          { y: y(1.02), rx: 0.17, rz: 0.08 },
          { y: y(1.0), rx: 0.15, rz: 0.062 },
        ],
        5,
      ),
      this.shell,
      V(0, 0, -0.2),
    );
    // Service panels and a blue stripe on the back.
    this.add(this.torso, new THREE.BoxGeometry(0.2, 0.012, 0.006), this.blue, V(0, y(1.47), -0.287));
    this.add(this.torso, new THREE.BoxGeometry(0.11, 0.15, 0.006), this.pleat, V(-0.075, y(1.32), -0.287));
    this.add(this.torso, new THREE.BoxGeometry(0.11, 0.15, 0.006), this.pleat, V(0.075, y(1.32), -0.287));
    this.add(this.torso, new THREE.BoxGeometry(0.2, 0.07, 0.006), this.metal, V(0, y(1.12), -0.287));
    // Shoulder harness that carries it.
    for (const side of [1, -1]) {
      const strap = limb(V(side * 0.13, y(1.3), 0.15), V(side * 0.15, y(1.46), -0.12), [0.02, 0.02], false);
      const mesh = this.add(this.torso, strap.geometry, this.pleat, strap.position, [1.5, 1, 0.5]);
      mesh.quaternion.copy(strap.quaternion);
    }
  }

  /** The chest control panel, with the health status light. */
  private buildChestPanel(): void {
    const y = (value: number): number => value - this.torso.position.y;
    this.add(
      this.torso,
      loft(
        [
          { y: y(1.335), rx: 0.094, rz: 0.03 },
          { y: y(1.325), rx: 0.1, rz: 0.036 },
          { y: y(1.215), rx: 0.1, rz: 0.036 },
          { y: y(1.205), rx: 0.094, rz: 0.03 },
        ],
        5,
      ),
      this.shell,
      V(0, 0, 0.158),
    );
    const face = 0.196;
    this.add(this.torso, new THREE.BoxGeometry(0.168, 0.036, 0.004), this.dark, V(0, y(1.295), face));
    this.add(this.torso, new THREE.BoxGeometry(0.07, 0.01, 0.005), this.blue, V(-0.04, y(1.295), face + 0.002));
    this.add(this.torso, new THREE.SphereGeometry(0.011, 16, 12), this.lamp, V(0.058, y(1.295), face + 0.002));
    for (const x of [-0.06, -0.03, 0]) this.add(this.torso, new THREE.CylinderGeometry(0.009, 0.009, 0.008, 14), this.metal, V(x, y(1.243), face), [1, 1, 1], new THREE.Euler(Math.PI / 2, 0, 0));
    this.add(this.torso, new THREE.BoxGeometry(0.036, 0.026, 0.006), this.metal, V(0.054, y(1.243), face));
  }

  private buildArm(side: number): void {
    const shoulder = V(side * 0.262, 1.378, 0);
    const elbow = V(side * 0.322, 1.118, 0.004);
    const wrist = V(side * 0.366, 0.885, 0.03);
    const along = (from: THREE.Vector3, to: THREE.Vector3, t: number): THREE.Vector3 => from.clone().lerp(to, t);

    // Shoulder bearing, then an upper arm that narrows toward the elbow.
    this.segment(shoulder, along(shoulder, elbow, 0.84), [0.078, 0.08, 0.072, 0.066], this.fabric);
    this.around(along(shoulder, elbow, 0.1), elbow, ring(0.083, 0.02, 0.012), this.metal);
    this.around(along(shoulder, elbow, 0.46), elbow, ring(0.0765, 0.016, 0.004), this.blue);
    this.around(along(shoulder, elbow, 0.52), elbow, ring(0.0755, 0.003, 0.004), this.dark);
    // Pleated elbow.
    this.around(elbow, wrist, bellows(0.085, 0.063, 4), this.pleat, along(shoulder, elbow, 0.86), along(elbow, wrist, 0.16));
    // Forearm: fuller below the elbow, slim at the wrist.
    this.segment(along(elbow, wrist, 0.12), wrist, [0.064, 0.067, 0.06, 0.052], this.fabric);
    // Wrist ring and glove.
    this.around(along(elbow, wrist, 0.93), wrist, ring(0.056, 0.022, 0.012), this.metal);
    this.around(along(elbow, wrist, 0.86), wrist, ring(0.058, 0.005, 0.005), this.blue);
    this.buildGlove(side, wrist, wrist.clone().sub(elbow).normalize());
  }

  /** A glove with a palm, four fingers and a thumb; the palm faces the thigh. */
  private buildGlove(side: number, wrist: THREE.Vector3, direction: THREE.Vector3): void {
    const hand = new THREE.Group();
    hand.position.copy(wrist);
    // The hand hangs along the forearm: its fingers point down the arm's axis.
    hand.quaternion.setFromUnitVectors(V(0, -1, 0), direction);
    // A gloved hand is noticeably larger than a bare one.
    hand.scale.setScalar(1.32);
    this.root.add(hand);

    // Cuff, flaring from the wrist ring over the back of the hand.
    this.add(hand, new THREE.CylinderGeometry(0.044, 0.04, 0.05, 24), this.pleat, V(0, -0.022, 0), [0.8, 1, 1]);
    // Palm: a flattened block, thin from front to back of the hand.
    this.add(
      hand,
      loft(
        [
          { y: -0.045, rx: 0.026, rz: 0.043 },
          { y: -0.07, rx: 0.029, rz: 0.049 },
          { y: -0.105, rx: 0.027, rz: 0.047 },
          { y: -0.122, rx: 0.02, rz: 0.04 },
        ],
        3.2,
        24,
      ),
      this.fabric,
      V(0, 0, 0),
    );
    // Fingers, gently curled, each a little different in length.
    const fingers: [number, number][] = [
      [0.031, 0.036],
      [0.011, 0.043],
      [-0.01, 0.04],
      [-0.03, 0.03],
    ];
    for (const [z, length] of fingers) {
      this.add(hand, new THREE.CapsuleGeometry(0.0115, length, 4, 12), this.fabric, V(-side * 0.006, -0.128 - length / 2, z), [1, 1, 1], new THREE.Euler(0, 0, side * 0.22));
      this.add(hand, new THREE.SphereGeometry(0.0118, 12, 8), this.pleat, V(-side * 0.012, -0.136 - length, z));
    }
    // Thumb, set forward and angled away from the palm.
    this.add(hand, new THREE.CapsuleGeometry(0.0135, 0.036, 4, 12), this.fabric, V(-side * 0.004, -0.086, 0.058), [1, 1, 1], new THREE.Euler(-0.6, 0, side * 0.15));
    // Knuckle guard on the back of the hand.
    this.add(hand, new THREE.BoxGeometry(0.005, 0.02, 0.05), this.pleat, V(side * 0.0285, -0.092, 0));
  }

  private buildLeg(side: number): void {
    const hip = V(side * 0.108, 0.84, 0);
    const knee = V(side * 0.114, 0.505, 0.012);
    const ankle = V(side * 0.114, 0.165, 0);
    const along = (from: THREE.Vector3, to: THREE.Vector3, t: number): THREE.Vector3 => from.clone().lerp(to, t);

    // Thigh: full at the hip, narrowing to the knee.
    this.segment(hip, along(hip, knee, 0.88), [0.106, 0.108, 0.096, 0.084], this.fabric);
    this.around(along(hip, knee, 0.5), knee, ring(0.1005, 0.016, 0.004), this.blue);
    this.around(along(hip, knee, 0.555), knee, ring(0.099, 0.003, 0.004), this.dark);
    // Pleated knee with a pad in front.
    this.around(knee, ankle, bellows(0.1, 0.08, 4), this.pleat, along(hip, knee, 0.9), along(knee, ankle, 0.16));
    this.add(this.root, new THREE.SphereGeometry(0.058, 20, 14), this.shell, V(knee.x, knee.y, knee.z + 0.058), [0.95, 1.1, 0.42]);
    // Shin with a slight calf, slim at the ankle.
    this.segment(along(knee, ankle, 0.12), ankle, [0.08, 0.085, 0.076, 0.066], this.fabric);
    this.around(along(knee, ankle, 0.5), ankle, ring(0.0805, 0.003, 0.004), this.dark);
    // Ankle ring and boot.
    this.around(along(knee, ankle, 0.95), ankle, ring(0.07, 0.024, 0.012), this.metal);
    this.around(along(knee, ankle, 0.87), ankle, ring(0.072, 0.005, 0.005), this.blue);
    this.buildBoot(V(ankle.x, 0, ankle.z));
  }

  /** A broad boot: thick tread, a rounded upper that rises to the ankle, a reinforced toe. */
  private buildBoot(at: THREE.Vector3): void {
    const boot = new THREE.Group();
    boot.position.copy(at);
    this.root.add(boot);
    const flat = new THREE.Euler(-Math.PI / 2, 0, 0);
    const extrude = (width: number, heel: number, toe: number, depth: number, bevel: number): THREE.BufferGeometry =>
      new THREE.ExtrudeGeometry(soleShape(width, heel, toe), { depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 16 });

    // Tread and midsole.
    this.add(boot, extrude(0.142, 0.1, 0.2, 0.022, 0.004), this.dark, V(0, 0.004, 0), [1, 1, 1], flat);
    this.add(boot, extrude(0.134, 0.096, 0.194, 0.016, 0.004), this.metal, V(0, 0.034, 0), [1, 1, 1], flat);
    // Upper: wide over the foot, drawn in toward the ankle.
    this.add(
      boot,
      loft(
        [
          { y: 0.175, rx: 0.066, rz: 0.068, cz: 0 },
          { y: 0.13, rx: 0.07, rz: 0.078, cz: 0.012 },
          { y: 0.095, rx: 0.072, rz: 0.118, cz: 0.045 },
          { y: 0.06, rx: 0.074, rz: 0.142, cz: 0.052 },
          { y: 0.048, rx: 0.072, rz: 0.144, cz: 0.052 },
        ],
        2.6,
        28,
      ),
      this.fabric,
      V(0, 0, 0),
    );
    // Toe cap.
    this.add(boot, new THREE.SphereGeometry(0.066, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), this.shell, V(0, 0.05, 0.132), [1.06, 0.72, 1.0]);
  }

  // ---------- Helpers ----------

  private add(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: THREE.Vector3,
    scale: [number, number, number] = [1, 1, 1],
    rotation?: THREE.Euler,
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.set(...scale);
    if (rotation) mesh.rotation.copy(rotation);
    parent.add(mesh);
    this.pickables.push(mesh);
    return mesh;
  }

  /** A tapered limb segment between two points. */
  private segment(from: THREE.Vector3, to: THREE.Vector3, radii: number[], material: THREE.Material): void {
    const shape = limb(from, to, radii);
    this.add(this.root, shape.geometry, material, shape.position).quaternion.copy(shape.quaternion);
  }

  /** Places a ring or sleeve at `at`, around the axis that runs toward `toward` (or from `from` to `to` when given). */
  private around(at: THREE.Vector3, toward: THREE.Vector3, geometry: THREE.BufferGeometry, material: THREE.Material, from?: THREE.Vector3, to?: THREE.Vector3): void {
    const axis = (to ?? toward).clone().sub(from ?? at);
    if (axis.lengthSq() === 0) axis.copy(UP);
    const position = from && to ? from.clone().lerp(to, 0.5) : at;
    this.add(this.root, geometry, material, position).quaternion.setFromUnitVectors(UP, axis.normalize());
  }

  private material(parameters: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.track(new THREE.MeshStandardMaterial(parameters));
  }

  private track<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}
