import * as THREE from 'three';

/**
 * A procedural Earth: no textures, so it works offline and weighs nothing.
 * The look is deliberately illustrated (soft coastlines, friendly palette) with a physical
 * touch on top: a day/night terminator, an ocean glint and a blue atmosphere.
 */

const NOISE = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }
  float fbm(vec3 p) {
    float amplitude = 0.5;
    float sum = 0.0;
    for (int i = 0; i < 5; i++) {
      sum += amplitude * noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      amplitude *= 0.5;
    }
    return sum;
  }
`;

const VERTEX = /* glsl */ `
  varying vec3 vObject;
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vObject = position;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPositionW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDim;
  uniform vec3 uSun;
  varying vec3 vObject;
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  ${NOISE}

  void main() {
    vec3 p = normalize(vObject);
    float latitude = abs(p.y);

    float height = fbm(p * 2.1 + vec3(3.1, 0.7, 5.3)) + 0.16 * fbm(p * 6.0 + 11.0);
    float land = smoothstep(0.585, 0.615, height);

    vec3 ocean = mix(vec3(0.02, 0.15, 0.42), vec3(0.07, 0.43, 0.80), smoothstep(0.40, 0.60, height));
    float dry = smoothstep(0.46, 0.62, fbm(p * 3.0 + 7.0)) * (1.0 - smoothstep(0.15, 0.55, latitude));
    vec3 ground = mix(vec3(0.22, 0.60, 0.36), vec3(0.84, 0.72, 0.46), dry);
    ground = mix(ground, vec3(0.50, 0.66, 0.38), smoothstep(0.66, 0.78, height));
    vec3 color = mix(ocean, ground, land);

    float ice = smoothstep(0.80, 0.90, latitude + 0.10 * (noise(p * 8.0) - 0.5));
    color = mix(color, vec3(0.93, 0.97, 1.0), ice);

    // Clouds drift a little faster than the ground turns.
    float angle = uTime * 0.012;
    vec3 cp = vec3(p.x * cos(angle) - p.z * sin(angle), p.y, p.x * sin(angle) + p.z * cos(angle));
    float clouds = smoothstep(0.50, 0.72, fbm(cp * 3.4 + vec3(0.0, uTime * 0.004, 0.0)) + 0.12 * fbm(cp * 9.0));
    color = mix(color, vec3(1.0), clouds * 0.88);

    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPositionW);
    float ndl = dot(n, uSun);
    float day = smoothstep(-0.20, 0.35, ndl);

    // Night side: deep blue, with a few warm lights where people live.
    vec3 night = color * vec3(0.05, 0.09, 0.19);
    float city = smoothstep(0.70, 0.82, noise(p * 46.0)) * smoothstep(0.45, 0.6, fbm(p * 5.0 + 2.0));
    night += vec3(1.0, 0.74, 0.42) * city * land * (1.0 - ice) * (1.0 - clouds) * 0.55;

    vec3 lit = color * (0.52 + 0.62 * clamp(ndl, 0.0, 1.0));
    float glint = pow(max(dot(n, normalize(v + uSun)), 0.0), 48.0) * (1.0 - land) * (1.0 - clouds);
    lit += vec3(1.0, 0.96, 0.86) * glint * 0.32;

    vec3 result = mix(night, lit, day);

    // The atmosphere seen edge-on, plus a warm line where day meets night.
    float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    result += vec3(0.30, 0.48, 0.64) * fresnel * (0.22 + 0.78 * day);
    result += vec3(1.0, 0.48, 0.22) * 0.07 * (1.0 - abs(day * 2.0 - 1.0));

    gl_FragColor = vec4(result * uDim, 1.0);
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform float uDim;
  uniform float uEdge;
  uniform vec3 uSun;
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPositionW);
    // Back faces only: 1 right at the planet's limb, falling to 0 at the edge of the shell.
    float halo = pow(clamp(-dot(n, v) / uEdge, 0.0, 1.0), 2.6);
    float sunward = 0.30 + 0.70 * smoothstep(-0.55, 0.55, dot(n, uSun));
    gl_FragColor = vec4(vec3(0.34, 0.54, 0.70) * halo * sunward * uDim, 1.0);
  }
`;

const ATMOSPHERE_RADIUS = 1.2;

export interface Earth {
  object: THREE.Group;
  /** 0..1 overall brightness, so the planet can step back behind the welcome card. */
  setDim(value: number): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createEarth(sun: THREE.Vector3): Earth {
  const uniforms = {
    uTime: { value: 0 },
    uDim: { value: 1 },
    uSun: { value: sun },
    uEdge: { value: Math.sqrt(1 - 1 / (ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS)) },
  };

  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const surfaceMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: SURFACE_FRAGMENT });
  const atmosphereMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    side: THREE.BackSide,
    // Additive, without touching the canvas alpha: the halo also glows over the CSS sky behind.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
  });

  const surface = new THREE.Mesh(geometry, surfaceMaterial);
  const atmosphere = new THREE.Mesh(geometry, atmosphereMaterial);
  atmosphere.scale.setScalar(ATMOSPHERE_RADIUS);

  const group = new THREE.Group();
  group.rotation.z = THREE.MathUtils.degToRad(23.4);
  group.add(surface, atmosphere);

  return {
    object: group,
    setDim(value) {
      uniforms.uDim.value = value;
    },
    update(elapsed) {
      uniforms.uTime.value = elapsed;
      surface.rotation.y = 0.6 + elapsed * 0.035;
    },
    dispose() {
      geometry.dispose();
      surfaceMaterial.dispose();
      atmosphereMaterial.dispose();
    },
  };
}
