import * as THREE from 'three';

/**
 * The astronaut is a silhouette: a dark suit built from simple volumes, outlined by the
 * sunlight and by the blue light coming off the Earth. It stays abstract on purpose, so
 * anyone can see themselves in it.
 */

const VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPositionW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uBase;
  uniform vec3 uRim;
  uniform float uGloss;
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPositionW);
    float sun = max(dot(n, uSun), 0.0);
    float fresnel = pow(1.0 - max(dot(n, v), 0.0), 2.4);
    // The Earth is behind the figure, so its light wraps around the edges.
    float earthLight = smoothstep(-0.3, 0.8, dot(n, normalize(-vPositionW)));
    vec3 color = uBase * (0.6 + 2.4 * sun);
    color += uRim * fresnel * (0.5 + 1.0 * sun + 0.6 * earthLight);
    color += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, normalize(v + uSun)), 0.0), 30.0) * uGloss;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface Astronaut {
  object: THREE.Group;
  update(elapsed: number): void;
  dispose(): void;
}

export function createAstronaut(sun: THREE.Vector3): Astronaut {
  const disposables: { dispose(): void }[] = [];
  const material = (base: number, rim: number, gloss: number): THREE.ShaderMaterial => {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: sun },
        uBase: { value: new THREE.Color(base) },
        uRim: { value: new THREE.Color(rim) },
        uGloss: { value: gloss },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });
    disposables.push(m);
    return m;
  };
  const suit = material(0x2a2e32, 0xdcd6c9, 0.08);
  const pack = material(0x181b1e, 0x8fb3c7, 0.03);
  const visor = material(0x0a0d10, 0xa9c7d8, 1.0);

  const figure = new THREE.Group();
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]): THREE.Mesh => {
    disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    figure.add(mesh);
    return mesh;
  };
  const up = new THREE.Vector3(0, 1, 0);
  /** A capsule between two points: one limb segment. */
  const limb = (from: THREE.Vector3, to: THREE.Vector3, radius: number): void => {
    const direction = to.clone().sub(from);
    const mesh = add(new THREE.CapsuleGeometry(radius, direction.length(), 6, 14), suit, [0, 0, 0]);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(up, direction.normalize());
  };
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  add(new THREE.SphereGeometry(0.165, 32, 24), suit, [0, 0.63, 0]);
  add(new THREE.SphereGeometry(0.125, 32, 24), visor, [0, 0.632, 0.078], [1, 0.86, 0.62]);
  add(new THREE.CapsuleGeometry(0.155, 0.2, 8, 20), suit, [0, 0.33, 0], [1.14, 1, 0.86]);
  add(new THREE.SphereGeometry(0.145, 24, 16), suit, [0, 0.13, 0], [1.1, 0.82, 0.88]);
  add(new THREE.BoxGeometry(0.31, 0.4, 0.15), pack, [0, 0.37, -0.165]);
  add(new THREE.BoxGeometry(0.17, 0.1, 0.05), pack, [0, 0.36, 0.135]);

  // Relaxed, weightless pose: one arm lifted in a small greeting, knees softly bent.
  const arms: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [V(0.2, 0.46, 0), V(0.35, 0.32, 0.07), V(0.41, 0.16, 0.19)],
    [V(-0.2, 0.46, 0), V(-0.37, 0.43, 0.08), V(-0.47, 0.58, 0.2)],
  ];
  for (const [shoulder, elbow, hand] of arms) {
    limb(shoulder, elbow, 0.068);
    limb(elbow, hand, 0.062);
    add(new THREE.SphereGeometry(0.07, 16, 12), suit, [hand.x, hand.y, hand.z]);
  }
  const legs: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [V(0.09, 0.1, 0), V(0.13, -0.14, 0.1), V(0.15, -0.4, -0.01)],
    [V(-0.09, 0.1, 0), V(-0.12, -0.16, 0.05), V(-0.14, -0.41, -0.1)],
  ];
  for (const [hip, knee, foot] of legs) {
    limb(hip, knee, 0.084);
    limb(knee, foot, 0.074);
    add(new THREE.SphereGeometry(0.082, 16, 12), suit, [foot.x, foot.y - 0.02, foot.z + 0.03], [1, 0.72, 1.45]);
  }
  figure.position.y = -0.12;

  const group = new THREE.Group();
  group.add(figure);

  return {
    object: group,
    update(elapsed) {
      // Slow, slightly irregular drift: weightlessness, not a loop.
      figure.rotation.set(
        0.18 + 0.1 * Math.sin(elapsed * 0.23),
        0.55 + 0.22 * Math.sin(elapsed * 0.17 + 1),
        -0.28 + 0.12 * Math.sin(elapsed * 0.13 + 2),
      );
      figure.position.y = -0.12 + 0.035 * Math.sin(elapsed * 0.5);
    },
    dispose() {
      disposables.forEach((item) => item.dispose());
    },
  };
}
