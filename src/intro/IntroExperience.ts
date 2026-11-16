import { gsap } from 'gsap';
import { h } from '../ui/dom';
import { HABITATS } from './habitats';
import './intro.css';
import { saveProfile, type CrewProfile, type HabitatId } from './profile';
import { IntroScene, type IntroSceneState } from './scene/IntroScene';

export interface IntroOptions {
  /** The saved profile when the introduction is replayed; null on a first visit. */
  profile: CrewProfile | null;
  /** Elements to make inert while the introduction covers them. */
  behind?: HTMLElement | null;
  /**
   * Called once the crew member is known, while the introduction still covers the page:
   * the app can build itself underneath and be ready when the curtain lifts.
   */
  onEnter(profile: CrewProfile): void;
}

const LINES = [
  'In space, the body keeps a log.',
  'Bone density. Muscle. Sleep. The entries are quiet.',
  'HELIOS reads that log and shows you what is drifting.',
];
const MAX_NAME_LENGTH = 40;

/** Where the scene rests in each chapter. The opening values live in IntroScene. */
const SCENE: Record<'orbit' | 'welcome' | 'greeting', Partial<IntroSceneState>> = {
  orbit: { distance: 7.8, azimuth: 0.12, elevation: 0.05, earthY: 0.54, astronautX: -0.46, astronautY: 0.36, astronautScale: 0.56 },
  welcome: { distance: 11.5, azimuth: 0.3, earthX: 0.64, earthY: 0.54, earthLight: 0.6, astronautX: -0.66, astronautY: -0.42, astronautScale: 0.34 },
  greeting: { distance: 9.6, azimuth: 0.42, earthX: 0, earthY: 0.56, earthLight: 0.9, astronautX: -0.5, astronautY: 0.34, astronautScale: 0.46 },
};

/**
 * The first minutes with HELIOS: a short film about why the app exists, then a welcome
 * that asks only for a name (and, optionally, where the mission takes place).
 *
 * It is a full-screen layer over the app. Three.js draws the sky, GSAP directs both the
 * camera and the text, and the DOM carries everything that must be read or operated.
 */
export function runIntro(options: IntroOptions): void {
  new IntroExperience(options);
}

class IntroExperience {
  private readonly reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly root: HTMLElement;
  private readonly curtain = h('div', { class: 'intro-curtain', 'aria-hidden': 'true' });
  private readonly cinema: HTMLElement;
  private readonly lines: HTMLElement[];
  private readonly brand: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly welcome: HTMLElement;
  private readonly card = h('div', { class: 'intro-card' });
  private readonly greeting = h('section', { class: 'intro-greeting', 'aria-live': 'polite' });
  private scene: IntroScene | null = null;
  private film: gsap.core.Timeline | null = null;
  private chapter: 'film' | 'welcome' | 'leaving' = 'film';
  private entered = false;

  constructor(private readonly options: IntroOptions) {
    const canvas = h('canvas', { class: 'intro-canvas', 'aria-hidden': 'true' });

    this.lines = LINES.map((text) =>
      h(
        'p',
        { class: 'intro-line', 'aria-label': text },
        // Words animate one by one; a word and the space after it stay together when lines wrap.
        ...text.split(' ').map((word) => h('span', { class: 'intro-word', 'aria-hidden': 'true' }, `${word} `)),
      ),
    );
    this.brand = h(
      'div',
      { class: 'intro-brand' },
      h('h1', { class: 'intro-title' }, 'HELIOS'),
      h('p', { class: 'intro-subtitle' }, 'Health twin for long-duration crews'),
    );
    this.startButton = h('button', { class: 'intro-button intro-button-primary', type: 'button', onclick: () => this.leaveFilm() }, 'Start my mission');
    this.skipButton = h('button', { class: 'intro-button intro-button-quiet', type: 'button', onclick: () => this.leaveFilm() }, 'Skip introduction');
    this.cinema = h(
      'section',
      { class: 'intro-cinema' },
      h('div', { class: 'intro-lines' }, ...this.lines),
      this.brand,
      h('div', { class: 'intro-actions' }, this.startButton, this.skipButton),
    );
    this.welcome = h('section', { class: 'intro-welcome', hidden: true }, this.card);
    this.greeting.hidden = true;

    this.root = h(
      'div',
      { class: 'intro', lang: 'en', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'HELIOS introduction', tabIndex: -1 },
      canvas,
      h('div', { class: 'intro-scrim', 'aria-hidden': 'true' }),
      this.cinema,
      this.welcome,
      this.greeting,
      this.curtain,
    );
    if (this.reduceMotion) this.root.classList.add('is-still');
    document.body.append(this.root);
    if (options.behind) options.behind.inert = true;
    this.root.addEventListener('keydown', this.onKeyDown);

    try {
      this.scene = new IntroScene(canvas, !this.reduceMotion);
    } catch (error) {
      // No WebGL: the CSS night sky behind the canvas carries the scene, and the flow still works.
      console.warn('Intro: 3D scene unavailable, continuing without it.', error);
      canvas.remove();
    }

    if (this.reduceMotion) this.showStillFilm();
    else this.playFilm();
    this.scene?.start();
    // Focus rests on the layer itself: Enter or Escape move on, Tab reaches the buttons, and no ring is drawn until asked for.
    this.root.focus({ preventScroll: true });
  }

  // ---------- Chapter 1: the film ----------

  /** About five and a half seconds: leave the Earth, meet the astronaut, read the three lines, land on the name. */
  private playFilm(): void {
    const [first, second, third] = this.lines.map((line) => Array.from(line.children));
    const film = gsap.timeline({ defaults: { ease: 'power2.out' } });
    this.film = film;

    const reveal = (words: Element[], at: number): void => {
      film.fromTo(
        words,
        { autoAlpha: 0, y: 14, filter: 'blur(6px)' },
        { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.7, stagger: 0.06 },
        at,
      );
    };
    const dismiss = (line: HTMLElement, at: number): void => {
      film.to(line, { autoAlpha: 0, y: -10, duration: 0.5, ease: 'power1.in' }, at);
    };

    film.to(this.curtain, { autoAlpha: 0, duration: 1.2, ease: 'power1.inOut' }, 0);
    // Opacity only: the button must stay focusable from the first frame, so the film can always be skipped.
    film.from(this.skipButton, { opacity: 0, duration: 0.5 }, 0.3);

    if (this.scene) {
      const s = this.scene.state;
      const { distance, azimuth, elevation, earthY, ...astronaut } = SCENE.orbit;
      // One pull-back carries the whole film.
      film.to(s, { distance, azimuth, elevation, duration: 4.5, ease: 'sine.inOut' }, 0);
      film.to(s, { ...astronaut, duration: 3.4, ease: 'power2.out' }, 1.6);
      film.to(s, { earthY, duration: 2.0, ease: 'sine.inOut' }, 2.6);
    }

    // The first two lines sit low, like subtitles; the block rises once the name needs the room below.
    const stage = this.lines[0].parentElement!;
    film.set(stage, { y: () => this.brand.offsetHeight + this.startButton.offsetHeight * 0.6 }, 0);
    film.set(stage, { y: 0 }, 3.9);
    reveal(first, 0.5);
    dismiss(this.lines[0], 2.1);
    reveal(second, 2.4);
    dismiss(this.lines[1], 3.6);
    reveal(third, 4.0);
    const [title, subtitle] = Array.from(this.brand.children);
    // The name settles into place: wide letters drawing together.
    film.fromTo(title, { autoAlpha: 0, letterSpacing: '0.75em' }, { autoAlpha: 1, letterSpacing: '0.26em', duration: 1.0 }, 4.4);
    film.fromTo(subtitle, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 4.9);
    film.fromTo(this.startButton, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 5.1);
  }

  /** Reduced motion: the whole message at once, on a still frame of the final shot. */
  private showStillFilm(): void {
    // The three lines need more room than the last one alone: the Earth sits a little higher and farther.
    if (this.scene) Object.assign(this.scene.state, SCENE.orbit, { distance: 8.8, earthY: 0.64 });
    gsap.to(this.curtain, { autoAlpha: 0, duration: 0.4 });
  }

  private leaveFilm(): void {
    if (this.chapter !== 'film') return;
    this.film?.kill();
    if (this.options.profile) this.finish(this.options.profile);
    else this.showWelcome();
  }

  // ---------- Chapter 2: welcome ----------

  private showWelcome(): void {
    this.chapter = 'welcome';
    this.fade(this.cinema, false);
    gsap.to(this.curtain, { autoAlpha: 0, duration: 0.5 });
    this.moveScene(SCENE.welcome, 2);
    this.card.replaceChildren(this.nameStep());
    this.welcome.hidden = false;
    if (this.reduceMotion) gsap.fromTo(this.card, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 });
    else gsap.fromTo(this.card, { autoAlpha: 0, y: 26, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.9, delay: 0.5, ease: 'power2.out' });
    this.card.querySelector('input')?.focus({ preventScroll: true });
  }

  private nameStep(): HTMLElement {
    const input = h('input', {
      id: 'intro-name',
      class: 'intro-input',
      type: 'text',
      name: 'name',
      placeholder: 'Type your name',
      autocomplete: 'given-name',
      maxLength: MAX_NAME_LENGTH,
      enterKeyHint: 'next',
      'aria-describedby': 'intro-name-error',
    });
    const error = h('p', { id: 'intro-name-error', class: 'intro-error', role: 'alert' });
    input.addEventListener('input', () => {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    });
    return h(
      'form',
      {
        class: 'intro-step',
        noValidate: true,
        onsubmit: (event: Event) => {
          event.preventDefault();
          const name = input.value.replace(/\s+/g, ' ').trim();
          if (!name) {
            error.textContent = 'Type your name to continue.';
            input.setAttribute('aria-invalid', 'true');
            input.focus();
            return;
          }
          this.swapStep(this.habitatStep(name));
        },
      },
      h('h2', { class: 'intro-card-title' }, 'Welcome aboard.'),
      h('p', { class: 'intro-card-lead' }, 'Two questions, then the console is yours.'),
      h('label', { class: 'intro-label', for: 'intro-name' }, 'What is your name?'),
      input,
      error,
      h('div', { class: 'intro-card-actions' }, h('button', { class: 'intro-button intro-button-primary', type: 'submit' }, 'Continue')),
    );
  }

  private habitatStep(name: string): HTMLElement {
    const options = HABITATS.map((habitat) => {
      const icon = h('span', { class: 'intro-habitat-icon' });
      icon.innerHTML = habitat.icon;
      return h(
        'label',
        { class: 'intro-habitat' },
        h('input', { class: 'sr-only', type: 'radio', name: 'habitat', value: habitat.id }),
        icon,
        h('span', { class: 'intro-habitat-label' }, habitat.label),
      );
    });
    const done = (habitat: HabitatId | null): void => this.showGreeting({ name, habitat });
    return h(
      'form',
      {
        class: 'intro-step',
        onsubmit: (event: Event) => {
          event.preventDefault();
          const choice = new FormData(event.currentTarget as HTMLFormElement).get('habitat');
          done(typeof choice === 'string' ? (choice as HabitatId) : null);
        },
      },
      h('p', { class: 'intro-eyebrow' }, 'Optional'),
      h('h2', { class: 'intro-card-title', id: 'intro-habitat-title' }, 'Where does your mission take place?'),
      h('div', { class: 'intro-habitats', role: 'radiogroup', 'aria-labelledby': 'intro-habitat-title' }, ...options),
      h('p', { class: 'intro-card-note' }, 'Your environment can affect the risks to your health. You can change it whenever you like.'),
      h(
        'div',
        { class: 'intro-card-actions' },
        h('button', { class: 'intro-button intro-button-quiet', type: 'button', onclick: () => done(null) }, 'Not now'),
        h('button', { class: 'intro-button intro-button-primary', type: 'submit' }, 'Continue'),
      ),
    );
  }

  private swapStep(next: HTMLElement): void {
    const show = (): void => {
      this.card.replaceChildren(next);
      gsap.fromTo(next, { autoAlpha: 0, x: this.reduceMotion ? 0 : 18 }, { autoAlpha: 1, x: 0, duration: this.reduceMotion ? 0.2 : 0.5, ease: 'power2.out' });
      next.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    };
    const current = this.card.firstElementChild;
    if (!current) show();
    else gsap.to(current, { autoAlpha: 0, x: this.reduceMotion ? 0 : -18, duration: this.reduceMotion ? 0.15 : 0.3, ease: 'power1.in', onComplete: show });
  }

  // ---------- Chapter 3: greeting, then the app ----------

  private showGreeting(profile: CrewProfile): void {
    if (this.chapter !== 'welcome') return;
    this.chapter = 'leaving';
    saveProfile(profile);
    this.enter(profile);

    const hello = h('h2', { class: 'intro-greeting-title' }, `Welcome aboard, ${profile.name}.`);
    const next = h('p', { class: 'intro-greeting-text' }, 'Your console is live. The mission clock is running.');
    this.greeting.replaceChildren(hello, next);
    this.fade(this.welcome, false);
    this.moveScene(SCENE.greeting, 3);
    this.greeting.hidden = false;
    gsap
      .timeline({ onComplete: () => this.close() })
      .fromTo(
        [hello, next],
        { autoAlpha: 0, y: this.reduceMotion ? 0 : 16 },
        { autoAlpha: 1, y: 0, duration: this.reduceMotion ? 0.3 : 1, stagger: 0.45, ease: 'power2.out' },
        0.4,
      )
      // Long enough to read twice, short enough not to feel like waiting.
      .to({}, { duration: 2.2 });
  }

  /** Replay with a known crew member: straight back to the app. */
  private finish(profile: CrewProfile): void {
    this.chapter = 'leaving';
    this.enter(profile);
    this.close();
  }

  private enter(profile: CrewProfile): void {
    if (this.entered) return;
    this.entered = true;
    this.options.onEnter(profile);
  }

  private close(): void {
    if (this.options.behind) this.options.behind.inert = false;
    this.root.removeEventListener('keydown', this.onKeyDown);
    gsap.to(this.root, {
      autoAlpha: 0,
      duration: this.reduceMotion ? 0.3 : 1.1,
      ease: 'power1.inOut',
      onComplete: () => {
        gsap.killTweensOf(this.scene?.state ?? {});
        this.scene?.dispose();
        this.root.remove();
      },
    });
  }

  // ---------- Helpers ----------

  private moveScene(target: Partial<IntroSceneState>, duration: number): void {
    if (!this.scene) return;
    const state = this.scene.state;
    gsap.killTweensOf(state);
    if (this.reduceMotion) {
      Object.assign(state, target);
      this.scene.render();
    } else gsap.to(state, { ...target, duration, ease: 'power2.inOut' });
  }

  private fade(element: HTMLElement, visible: boolean): void {
    gsap.to(element, { autoAlpha: visible ? 1 : 0, duration: this.reduceMotion ? 0.2 : 0.6, ease: 'power1.out', onComplete: () => void (element.hidden = !visible) });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.chapter !== 'film') return;
    if (event.key === 'Escape' || (event.key === 'Enter' && event.target === this.root)) this.leaveFilm();
  };
}
