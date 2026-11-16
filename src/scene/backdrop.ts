import * as THREE from 'three';

/** Distant stars and the projection pad under the figure. Decorative only. */
export function createBackdrop(): { object: THREE.Group; update(elapsed: number): void } {
  const group = new THREE.Group();

  const STARS = 900;
  const positions = new Float32Array(STARS * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < STARS; i++) {
    p.randomDirection().multiplyScalar(40 + Math.random() * 40);
    positions.set([p.x, p.y, p.z], i * 3);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  group.add(
    new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xb9b4a9, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.5 }),
    ),
  );

  const padMaterial = (opacity: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      color: 0x8fb3c7,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  const pad = new THREE.Group();
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = -0.002;
  pad.add(new THREE.Mesh(new THREE.CircleGeometry(0.46, 64), padMaterial(0.05)));
  for (const [inner, width, opacity] of [
    [0.46, 0.004, 0.55],
    [0.56, 0.002, 0.3],
    [0.7, 0.0015, 0.16],
  ]) {
    pad.add(new THREE.Mesh(new THREE.RingGeometry(inner, inner + width, 96), padMaterial(opacity)));
  }
  // A broken ring that turns slowly, so the pad reads as "live".
  const sweep = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.512, 64, 1, 0, Math.PI * 0.5), padMaterial(0.4));
  pad.add(sweep);
  group.add(pad);

  return {
    object: group,
    update(elapsed) {
      sweep.rotation.z = elapsed * 0.5;
    },
  };
}
