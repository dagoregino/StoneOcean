import type { AppActions } from './app/actions';
import { APP_TITLE, HISTORY_DAYS, MISSION_START_MINUTES, VOSK_MODEL_PATH } from './config';
import { GroundLink } from './data/GroundLink';
import { HealthStore } from './data/HealthStore';
import { IndexedDbResourceRepository } from './data/resources/IndexedDbResourceRepository';
import { MemoryResourceRepository } from './data/resources/ResourceRepository';
import { ResourceStore } from './data/resources/ResourceStore';
import { MissionClock } from './data/MissionClock';
import { scenarioById } from './data/sources/scenarios';
import { SimulatedSource } from './data/sources/SimulatedSource';
import { loadSpaceWeather, snapshotSpaceWeather } from './data/spaceWeather';
import { isLinkUp } from './domain/link';
import { STATUS_GLYPH, STATUS_LABEL } from './domain/status';
import { buildSymptomGuidance, GUIDANCE_TIER_TITLE } from './domain/symptomGuidance';
import type { SymptomReport } from './domain/symptoms';
import { MissionTour } from './demo/MissionTour';
import type { IntroOptions } from './intro/IntroExperience';
import { environmentFor, loadProfile, type CrewProfile } from './intro/profile';
import type { HealthStatus } from './domain/types';
import { BodyViewport } from './scene/BodyViewport';
import { DictationController } from './speech/DictationController';
import { DailyCheckIn } from './ui/DailyCheckIn';
import type { Dialog } from './ui/dialog';
import { h } from './ui/dom';
import { MissionTourStage } from './ui/MissionTourStage';
import { EarthLink } from './ui/EarthLink';
import './ui/resources/resources.css';
import { SidePanel } from './ui/SidePanel';
import { SimulatorBar, type SimulatorState } from './ui/SimulatorBar';
import { openSymptomGuidance } from './ui/SymptomGuidanceDialog';
import { SymptomReporter } from './ui/SymptomReporter';
import './ui/styles.css';
import { SystemList } from './ui/SystemList';
import { TopBar } from './ui/TopBar';
import { TwinViewControl } from './ui/TwinViewControl';

/**
 * Composition root: the only file that knows every layer.
 *
 *   sources (simulator, manual log)  ->  HealthStore  ->  rules engine (domain/)
 *                                             |
 *                         'data' / 'selection' / 'hover' events
 *                                             v
 *                         3D body (scene/)  and  panels (ui/)
 */
function bootstrap(profile: CrewProfile): void {
  const store = new HealthStore(environmentFor(profile));
  const clock = new MissionClock(MISSION_START_MINUTES);
  const simulator = new SimulatedSource(clock, () => store.environment);
  simulator.connect(store);
  // The simulated link to the ground: consultations reach Earth and come back on time.
  const groundLink = new GroundLink(store);

  // Real space weather: the bundled snapshot first (works offline), then the live feed.
  const offline = snapshotSpaceWeather();
  store.setSpaceWeather(offline);
  simulator.setQuietFlux(offline.now.latest?.value ?? null);
  void loadSpaceWeather().then((weather) => {
    if (weather.origin !== 'live') return;
    store.setSpaceWeather(weather);
    simulator.setQuietFlux(weather.now.latest?.value ?? null);
  });

  simulator.seedHistory(HISTORY_DAYS);

  const simulatorState: SimulatorState = { scenarioId: 'nominal', speed: clock.speed, autoLog: true };

  const actions: AppActions = {
    logReading(id, value) {
      const reading = { indicatorId: id, value, t: clock.now, source: 'manual' as const };
      simulator.absorb(reading);
      store.ingest([reading], clock.now);
    },
    setScenario: (id) => simulator.setScenario(scenarioById(id)),
    setSpeed: (minutesPerSecond) => clock.setSpeed(minutesPerSecond),
    setAutoLog: (enabled) => (simulator.autoLogSelfChecks = enabled),
    resetMission() {
      clock.now = MISSION_START_MINUTES;
      store.reset(clock.now);
      simulator.seedHistory(HISTORY_DAYS);
    },
    startIntervention(id, stepText, authorityLevel) {
      store.startIntervention(id, stepText, authorityLevel);
      // In the demo the countermeasure works: the simulated physiology starts to recover.
      simulator.applyCountermeasure(id);
    },
    setDrugsPreauthorized: (enabled) => store.setDrugsPreauthorized(enabled),
    reportSymptom: (input) => void store.reportSymptom(input),
    removeSymptom: (id) => store.removeSymptom(id),
    // With Earth unreachable the same button queues the report on board instead of sending it.
    sendToFlightSurgeon: () => void (isLinkUp(store.link) ? store.requestConsult(Date.now()) : store.queueConsult()),
    advanceMission(minutes) {
      const STEP = 60;
      for (let left = minutes; left > 0; left -= STEP) {
        const previous = clock.now;
        clock.now = previous + Math.min(STEP, left);
        store.ingest(simulator.advance(previous, clock.now), clock.now);
      }
    },
    setLossOfSignal: (seconds) => (seconds === null ? groundLink.restore() : groundLink.beginLoss(seconds * 1000)),
  };

  // Medical resources live in the browser's own database: they stay on this device and need no connection.
  const resources = new ResourceStore(IndexedDbResourceRepository.isSupported() ? new IndexedDbResourceRepository() : new MemoryResourceRepository(), { currentUser: () => profile.name });
  void resources.init();

  new TopBar($('topbar'), store);

  // Main navigation: the monitoring console and the medical resources share the top bar.
  type View = 'monitoring' | 'resources';
  let resourcesView: Promise<unknown> | undefined;
  let onMonitoringShown = (): void => {};
  const alertCount = h('span', { class: 'nav-count', hidden: true });
  const navButtons: Record<View, HTMLButtonElement> = {
    monitoring: h('button', { class: 'nav-item', type: 'button', onclick: () => showView('monitoring') }, 'Monitoring'),
    resources: h('button', { class: 'nav-item', type: 'button', onclick: () => showView('resources') }, 'Medical Resources', alertCount),
  };
  function showView(view: View): void {
    $('app').dataset.view = view;
    $('resources').hidden = view !== 'resources';
    for (const [name, button] of Object.entries(navButtons)) {
      if (name === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (location.hash !== (view === 'resources' ? '#resources' : '')) history.replaceState(null, '', view === 'resources' ? '#resources' : location.pathname + location.search);
    if (view === 'monitoring') onMonitoringShown();
    if (view === 'resources') {
      $('resources').scrollTop = 0;
      // The screens load the first time they are opened; the inventory itself is already in memory.
      resourcesView ??= import('./ui/resources/ResourcesView').then(({ ResourcesView }) => new ResourcesView($('resources'), resources, store, () => profile.name));
    }
  }
  $('topbar').querySelector('.brand')!.after(h('nav', { class: 'main-nav', 'aria-label': 'Main' }, navButtons.monitoring, navButtons.resources));
  resources.events.on('change', () => {
    const open = resources.ready && !resources.error ? resources.alerts.length : 0;
    alertCount.hidden = open === 0;
    alertCount.textContent = String(open);
    alertCount.setAttribute('aria-label', `${open} open alerts`);
  });
  showView(location.hash === '#resources' ? 'resources' : 'monitoring');
  // The crew member's name doubles as the way back to the introduction.
  $('topbar').append(
    h(
      'button',
      {
        class: 'crew-chip',
        type: 'button',
        title: 'Replay the introduction',
        'aria-label': `${profile.name}: replay the introduction`,
        onclick: () => playIntro({ profile, behind: $('app'), onEnter: () => {} }),
      },
      h('span', { class: 'crew-chip-initial', 'aria-hidden': 'true' }, profile.name.charAt(0).toUpperCase()),
      h('span', { class: 'crew-chip-name' }, profile.name),
    ),
  );
  new SystemList($('systems'), store, $('hud'));
  const sidePanel = new SidePanel($('panel'), store, actions, resources, () => showView('resources'));
  onMonitoringShown = () => sidePanel.refresh();

  // A saved discomfort report is answered at once with "what should I do now?".
  let reportCount = store.symptoms.length;
  store.events.on('symptoms', (reports) => {
    const added = reports.length > reportCount;
    reportCount = reports.length;
    // The guided demo shows the guidance itself, at its own moment.
    if (!added || tour?.active) return;
    showGuidance(reports[reports.length - 1]);
  });
  const showGuidance = (report: SymptomReport, modal = true): Dialog => {
    const guidance = buildSymptomGuidance({ report, evaluation: store.evaluation, environment: store.environment, plan: store.medicalPlan, consultReason: store.consultReason });
    store.logEvent({ kind: 'guidance', source: 'protocol', systemId: report.systemId, text: `Guidance displayed: ${GUIDANCE_TIER_TITLE[guidance.tier].toLowerCase()}` });
    return openSymptomGuidance(
      guidance,
      {
        startGuidedCheck: (ids) => sidePanel.startGuidedCheck(ids),
        startProtocol: (id) => sidePanel.openProtocol(id),
        // The existing consultation flow does the sending; nothing about the link is repeated here.
        sendToFlightSurgeon: store.activeConsult ? null : actions.sendToFlightSurgeon,
      },
      { modal },
    );
  };

  // "Play the Mission": the guided demo. It only calls the actions above; see demo/MissionTour.ts.
  let tour: MissionTour | null = null;
  const playMission = (): void => {
    if (tour?.active) return;
    showView('monitoring');
    tour = new MissionTour({
      actions,
      store,
      stage: new MissionTourStage((report) => {
        const dialog = showGuidance(report, false);
        return () => dialog.close();
      }),
      suspendSimulator() {
        const before = { ...simulatorState };
        actions.setSpeed(0);
        return () => {
          actions.setLossOfSignal(null);
          actions.setScenario('nominal');
          actions.resetMission();
          actions.setSpeed(before.speed);
          simulatorBar.sync({ scenarioId: 'nominal', speed: before.speed });
        };
      },
    });
    void tour.start();
  };
  $('topbar')
    .querySelector('.main-nav')!
    .after(h('button', { class: 'play-mission', type: 'button', onclick: playMission }, h('span', { class: 'play-mission-icon', 'aria-hidden': 'true' }, '▶'), 'Play the Mission'));
  if (new URLSearchParams(location.search).has('demo')) playMission();
  const simulatorBar = new SimulatorBar($('simulator'), actions, simulatorState);
  store.events.on('link', (link) => simulatorBar.setLinkDown(!isLinkUp(link)));
  // Offline dictation for the report notes. Vosk and its model load on the first press only,
  // and the store never sees anything but the text the crew member chose to save.
  const dictation = new DictationController(async () => {
    const { VoskEngine } = await import('./speech/vosk/VoskEngine');
    return new VoskEngine({ modelUrl: `${import.meta.env.BASE_URL}${VOSK_MODEL_PATH}` });
  });
  new SymptomReporter($('viewport-tools'), $('symptom-form'), $('hint'), store, actions, dictation);
  new TwinViewControl($('viewport-tools'), $('hint'), store);
  new DailyCheckIn($('viewport-tools'), store);
  // A small Earth in the corner of the 3D view, and the signal of each consultation to it.
  new EarthLink($('stage'), store);

  const statuses: HealthStatus[] = ['nominal', 'caution', 'critical', 'unknown'];
  $('legend').append(
    ...statuses.map((status) =>
      h('span', { class: 'legend-item', dataset: { status } }, h('span', { class: 'status-glyph', 'aria-hidden': 'true' }, STATUS_GLYPH[status]), STATUS_LABEL[status]),
    ),
  );

  try {
    new BodyViewport($('stage'), store, {
      modelUrl: `${import.meta.env.BASE_URL}models/body.glb`,
      suitUrl: `${import.meta.env.BASE_URL}models/astronaut.glb`,
    });
  } catch (error) {
    console.error(error);
    $('stage').append(
      h('p', { class: 'viewport-fallback' }, '3D view unavailable: this browser could not start WebGL. The system list and panels still work.'),
    );
  }

  clock.start();
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/**
 * First visit: the introduction, then the app. Later visits go straight to the app
 * (add `?intro` to the address, or use the name in the top bar, to watch it again).
 */
function start(): void {
  document.title = APP_TITLE;
  const profile = loadProfile();
  const replay = new URLSearchParams(location.search).has('intro');
  if (profile && !replay) {
    bootstrap(profile);
    return;
  }
  if (profile) bootstrap(profile);
  playIntro({ profile, behind: $('app'), onEnter: profile ? () => {} : bootstrap });
}

/** The introduction (and GSAP) load on demand: returning crew members never download them. */
function playIntro(options: IntroOptions): void {
  import('./intro/IntroExperience')
    .then(({ runIntro }) => runIntro(options))
    .catch((error: unknown) => {
      // The introduction is optional; the health console is not.
      console.error(error);
      options.onEnter(options.profile ?? { name: 'Crew', habitat: null });
    });
}

start();
