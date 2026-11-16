import { gsap } from 'gsap';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

type FrameListener = (dt: number, elapsed: number) => void;

const FOV = 34;
const HOME_TARGET = new THREE.Vector3(0, 0.9, 0);
const BODY_HEIGHT = 1.95;
const BODY_WIDTH = 1.05;

/** Owns everything WebGL: renderer, camera, controls, post-processing and the frame loop. */
export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly composer: EffectComposer;
  private readonly listeners = new Set<FrameListener>();
  private readonly resizeObserver: ResizeObserver;
  private focus: { target: THREE.Vector3; distance: number } | null = null;
  /** What the camera is framing: a region, the whole body (null), or nothing because the user took over (undefined). */
  private framing: THREE.Box3 | null | undefined = null;
  private frame = 0;
  private cameraTween: object = {};
  /** Reused every frame while the camera eases to a focus: nothing is allocated in the loop. */
  private readonly focusOffset = new THREE.Vector3();
  private lastTime = 0;
  private elapsed = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Above 1.5 the extra pixels cost far more than they show, with bloom on top.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.classList.add('viewport-canvas');
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#0b0c0d');
    // Kept moderate on purpose: brighter lights wash the status colors toward white.
    this.scene.add(new THREE.HemisphereLight(0xece8df, 0x111315, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(1.6, 2.6, 2.6);
    const rim = new THREE.DirectionalLight(0xdcd6c9, 0.55);
    rim.position.set(-2, 1.4, -2.2);
    this.scene.add(key, rim);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 9;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = Math.PI - 0.15;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.target.copy(HOME_TARGET);
    // As soon as the user takes the camera, stop moving it for them.
    this.controls.addEventListener('start', () => {
      gsap.killTweensOf(this.cameraTween);
      this.controls.autoRotate = false;
      this.focus = null;
      this.framing = undefined;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.26, 0.4, 0.5));
    this.composer.addPass(new OutputPass());

    this.resize();
    this.camera.position.copy(HOME_TARGET).add(new THREE.Vector3(0.55, 0.12, 1).normalize().multiplyScalar(this.homeDistance()));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Smoothly frames a region of the body, or the whole body when `box` is null. */
  focusOn(box: THREE.Box3 | null): void {
    gsap.killTweensOf(this.cameraTween);
    this.framing = box;
    if (!box) {
      this.focus = { target: HOME_TARGET.clone(), distance: this.homeDistance() };
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.y, size.x, size.z);
    const distance = THREE.MathUtils.clamp(
      (extent * 1.9) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))),
      0.75,
      this.homeDistance(),
    );
    this.focus = { target: box.getCenter(new THREE.Vector3()), distance };
  }

  /**
   * Swings the camera round to face the figure from the front, framing the whole body.
   * The camera travels around the body (never through it); GSAP only eases the angles.
   */
  faceFront(duration: number): void {
    this.controls.autoRotate = false;
    this.focus = null;
    this.framing = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = new THREE.Spherical().setFromVector3(offset);
    const startTarget = this.controls.target.clone();
    // Take the short way round.
    const theta = Math.atan2(Math.sin(from.theta), Math.cos(from.theta));
    const orbit = { theta, phi: from.phi, radius: from.radius, t: 0 };
    const place = (): void => {
      this.controls.target.lerpVectors(startTarget, HOME_TARGET, orbit.t);
      this.camera.position.setFromSphericalCoords(orbit.radius, orbit.phi, orbit.theta).add(this.controls.target);
    };
    gsap.killTweensOf(this.cameraTween);
    this.cameraTween = orbit;
    const to = { theta: 0, phi: Math.PI / 2 - 0.06, radius: this.homeDistance(), t: 1 };
    if (duration <= 0) {
      Object.assign(orbit, to);
      place();
      return;
    }
    gsap.to(orbit, { ...to, duration, ease: 'power2.inOut', onUpdate: place });
  }

  start(): void {
    this.lastTime = performance.now();
    const loop = (time: number): void => {
      this.frame = requestAnimationFrame(loop);
      // Nothing to draw while the tab is in the background or the 3D view is not on screen.
      if (document.hidden || this.container.offsetParent === null) {
        this.lastTime = time;
        return;
      }
      const dt = Math.min((time - this.lastTime) / 1000, 0.1);
      this.lastTime = time;
      this.elapsed += dt;
      this.stepFocus(dt);
      this.listeners.forEach((l) => l(dt, this.elapsed));
      this.controls.update();
      this.composer.render(dt);
    };
    this.frame = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    gsap.killTweensOf(this.cameraTween);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Distance at which the whole body fits, whatever the shape of the viewport. */
  private homeDistance(): number {
    const half = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const forHeight = BODY_HEIGHT / 2 / half;
    const forWidth = BODY_WIDTH / 2 / (half * Math.max(this.camera.aspect, 0.3));
    return Math.max(forHeight, forWidth) * 1.08;
  }

  private stepFocus(dt: number): void {
    if (!this.focus) return;
    const ease = 1 - Math.exp(-dt * 4.5);
    const offset = this.focusOffset.copy(this.camera.position).sub(this.controls.target);
    const distance = offset.length();
    const nextDistance = distance + (this.focus.distance - distance) * ease;
    this.controls.target.lerp(this.focus.target, ease);
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), nextDistance);
    const settled =
      Math.abs(nextDistance - this.focus.distance) < 0.004 && this.controls.target.distanceTo(this.focus.target) < 0.004;
    if (settled) this.focus = null;
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    // Keep the subject framed when the viewport changes shape, unless the user moved the camera.
    if (this.framing !== undefined) this.focusOn(this.framing);
  }
}
