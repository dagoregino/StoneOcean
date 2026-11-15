import { doseThresholds, MISSION_DOSE_BUDGET_MSV } from '../radiation/budget';
import type { IndicatorDef, IndicatorId, SystemId } from '../types';

const INF = Number.POSITIVE_INFINITY;

/**
 * Health indicators, as data.
 *
 * Only two indicators carry an official NASA limit: ppCO2 (NASA-STD-3001 Vol. 2 [V2 6004])
 * and retinal thickness (NASA SANS clinical criteria). Proton flux uses the NOAA S-scale.
 * Every other range here is an ILLUSTRATIVE terrestrial range, used only until an individual
 * baseline is available, and it is never a NASA limit. `evidence/indicatorRules.ts` records
 * the basis of each one, and the dashboard shows it next to every alert.
 * This is decision support for training and concept work, not a medical device.
 */
export const INDICATORS: Record<IndicatorId, IndicatorDef> = {
  heartRate: {
    id: 'heartRate',
    systemId: 'cardiovascular',
    name: 'Resting heart rate',
    unit: 'bpm',
    decimals: 0,
    acquisition: 'sensor',
    cadenceHours: 1,
    display: { min: 35, max: 135 },
    plausible: { min: 20, max: 250 },
    thresholds: { nominal: { min: 50, max: 100 }, caution: { min: 40, max: 120 } },
    whyItMatters:
      'A resting rate that drifts up over days can signal deconditioning, dehydration, infection or poor sleep before you feel it.',
    howToMeasure: 'Read continuously by the chest strap or wrist wearable. Compare values taken at rest only.',
    guidance: {
      caution: [
        'Rest for 5 minutes and check the reading again.',
        'Drink water and review last night’s sleep and today’s workload.',
        'Mention the trend at your next private medical conference.',
      ],
      critical: [
        'Stop the current task and rest, secured in place.',
        'Take blood pressure and SpO₂ now and log both.',
        'Tell the Crew Medical Officer: this needs a flight surgeon’s review.',
      ],
    },
    reference: 'Adult resting heart rate 60–100 bpm (American Heart Association); fit adults are often lower.',
  },
  systolicBP: {
    id: 'systolicBP',
    systemId: 'cardiovascular',
    name: 'Systolic blood pressure',
    unit: 'mmHg',
    decimals: 0,
    acquisition: 'self-check',
    cadenceHours: 24,
    display: { min: 70, max: 190 },
    plausible: { min: 50, max: 260 },
    thresholds: { nominal: { min: 90, max: 129 }, caution: { min: 85, max: 159 } },
    whyItMatters:
      'Fluid shifts and vessel changes alter blood pressure in flight. Low values also predict fainting when gravity returns.',
    howToMeasure:
      'Use the automatic cuff on your upper arm after 5 minutes at rest. Keep the arm relaxed at heart level and do not talk during the reading.',
    guidance: {
      caution: [
        'Repeat the measurement after 5 minutes of rest.',
        'Check salt and fluid intake against today’s plan.',
        'Log a second reading tomorrow at the same time.',
      ],
      critical: [
        'Repeat once to confirm, then stop strenuous activity.',
        'If you have headache, chest pain or vision changes, treat it as an emergency.',
        'Tell the Crew Medical Officer and request a flight surgeon consult.',
      ],
    },
    reference: 'ACC/AHA blood pressure categories (normal below 120, stage 1 from 130, crisis above 180 mmHg).',
  },
  resistiveExercise: {
    id: 'resistiveExercise',
    systemId: 'skeletal',
    name: 'Resistive exercise',
    unit: 'min/day',
    decimals: 0,
    acquisition: 'sensor',
    cadenceHours: 24,
    display: { min: 0, max: 100 },
    plausible: { min: 0, max: 600 },
    thresholds: { nominal: { min: 45, max: INF }, caution: { min: 20, max: INF } },
    whyItMatters:
      'Loading the skeleton is the main defense against bone loss. Missed sessions cannot be made up later in the mission.',
    howToMeasure:
      'Logged automatically by the resistive exercise device. Counts loaded time only (squats, deadlifts, heel raises), averaged over 7 days.',
    guidance: {
      caution: [
        'Reschedule the missed session within 48 hours.',
        'Prioritize squats, deadlifts and heel raises: they load the hip and spine.',
        'Check calcium and vitamin D intake in your nutrition log.',
      ],
      critical: [
        'Flag the exercise device status: is a repair or workaround needed?',
        'Switch to the backup loading protocol (elastic bands, isometrics) today.',
        'Report the gap so ground teams can adjust the countermeasure plan.',
      ],
    },
    reference: 'Illustrative target, not a NASA limit. NASA publishes no alert threshold: compare with the prescribed programme and your own baseline.',
  },
  aerobicExercise: {
    id: 'aerobicExercise',
    systemId: 'muscular',
    name: 'Aerobic exercise',
    unit: 'min/day',
    decimals: 0,
    acquisition: 'sensor',
    cadenceHours: 24,
    display: { min: 0, max: 80 },
    plausible: { min: 0, max: 600 },
    thresholds: { nominal: { min: 30, max: INF }, caution: { min: 15, max: INF } },
    whyItMatters:
      'Muscle and aerobic fitness fade fast without load. You need both for spacewalks and to walk unaided after landing.',
    howToMeasure:
      'Detected by the wearable accelerometer plus treadmill and cycle logs. Counts minutes above moderate intensity, averaged over 7 days.',
    guidance: {
      caution: [
        'Add a 20-minute treadmill or cycle block today.',
        'Break long seated tasks with a few minutes of movement.',
        'Protect tomorrow’s exercise slot when replanning the day.',
      ],
      critical: [
        'Treat exercise as a mission task today: schedule it before anything optional.',
        'Do a short functional check: sit-to-stand and a hand-grip test.',
        'Tell the Crew Medical Officer so workload can be rebalanced.',
      ],
    },
    reference: 'Illustrative target, not a NASA limit. NASA publishes no alert threshold: compare with the prescribed programme and your own baseline.',
  },
  spo2: {
    id: 'spo2',
    systemId: 'respiratory',
    name: 'Blood oxygen (SpO₂)',
    unit: '%',
    decimals: 0,
    acquisition: 'sensor',
    cadenceHours: 1,
    display: { min: 84, max: 100 },
    plausible: { min: 50, max: 100 },
    thresholds: { nominal: { min: 95, max: 100 }, caution: { min: 90, max: 100 } },
    whyItMatters:
      'Falling oxygen saturation can be the first sign of a cabin atmosphere problem or of a lung issue.',
    howToMeasure: 'Read by the fingertip or wrist pulse oximeter. Keep the hand still and warm for a stable value.',
    guidance: {
      caution: [
        'Warm your hand, reseat the sensor and measure again.',
        'Check the cabin CO₂ and O₂ readings on the environmental panel.',
        'Move to a better-ventilated module and re-check in 15 minutes.',
      ],
      critical: [
        'Start supplemental oxygen following the onboard procedure.',
        'Alert the whole crew: confirm cabin atmosphere readings now.',
        'Tell the Crew Medical Officer and request a flight surgeon consult.',
      ],
    },
    reference: 'Normal pulse oximetry at sea-level pressure is 95–100%.',
  },
  sleepHours: {
    id: 'sleepHours',
    systemId: 'neuro',
    name: 'Sleep',
    unit: 'h/night',
    decimals: 1,
    acquisition: 'sensor',
    cadenceHours: 24,
    display: { min: 2, max: 10 },
    plausible: { min: 0, max: 24 },
    thresholds: { nominal: { min: 7, max: 10 }, caution: { min: 5, max: 12 } },
    whyItMatters:
      'Sleep loss in flight is common but not inevitable: Standard Measures data on 19 station crew members show 7.33 h in flight against 7.87 h before. Judge your sleep against your own baseline and trend.',
    howToMeasure: 'Estimated overnight by the wrist wearable (actigraphy). Confirm with a one-tap sleep diary on waking.',
    guidance: {
      caution: [
        'Dim cabin lights and avoid screens for 1 hour before sleep.',
        'No caffeine in the 6 hours before your sleep period.',
        'Take a 20-minute nap before any safety-critical task.',
      ],
      critical: [
        'Ask to move or hand over safety-critical tasks today.',
        'Protect a full 8.5-hour sleep opportunity tonight.',
        'Talk to the Crew Medical Officer about fatigue countermeasures.',
      ],
    },
    reference: 'Illustrative range (adults: 7 hours or more, AASM/SRS consensus). Not a NASA limit: NASA publishes no sleep alert threshold.',
  },
  mood: {
    id: 'mood',
    systemId: 'neuro',
    name: 'Mood self-rating',
    unit: '/10',
    decimals: 1,
    acquisition: 'self-check',
    cadenceHours: 24,
    display: { min: 1, max: 10 },
    plausible: { min: 1, max: 10 },
    thresholds: { nominal: { min: 6, max: 10 }, caution: { min: 4, max: 10 } },
    whyItMatters:
      'Months of isolation and confinement affect mood and motivation. A daily rating makes slow changes visible early.',
    howToMeasure: 'Once a day, rate how you feel overall from 1 (very low) to 10 (very good). Answer quickly: first impression.',
    guidance: {
      caution: [
        'Schedule something restorative today: a call home, music, the window.',
        'Do today’s exercise session: it reliably lifts mood.',
        'Share how you feel with a crewmate you trust.',
      ],
      critical: [
        'Do not carry this alone: tell the Crew Medical Officer today.',
        'Request a private psychological conference with ground support.',
        'Ask to lighten your task load for the next 24 hours.',
      ],
    },
    reference: 'Illustrative self-report scale; trends matter more than any single value.',
  },
  visionChange: {
    id: 'visionChange',
    systemId: 'sensory',
    name: 'Vision change score',
    unit: '/10',
    decimals: 1,
    acquisition: 'self-check',
    cadenceHours: 72,
    display: { min: 0, max: 10 },
    plausible: { min: 0, max: 10 },
    thresholds: { nominal: { min: 0, max: 2 }, caution: { min: 0, max: 5 } },
    whyItMatters:
      'SANS can blur near vision and swell the optic nerve head. Catching a change early leaves time for countermeasures.',
    howToMeasure:
      'Run the onboard near-vision and grid test for each eye. The score is 0 (no change from your baseline) to 10 (severe change).',
    guidance: {
      caution: [
        'Repeat the test tomorrow, one eye at a time, in good light.',
        'Use your adjustable “space anticipation” glasses if near vision is blurred.',
        'Report the change at your next private medical conference.',
      ],
      critical: [
        'Schedule an onboard eye exam (optical coherence tomography or ultrasound).',
        'Note any headache, and whether one eye is worse.',
        'Tell the Crew Medical Officer and send the test results to flight surgeons.',
      ],
    },
    reference: 'Illustrative score relative to the crew member’s own pre-flight baseline.',
  },
  dizziness: {
    id: 'dizziness',
    systemId: 'sensory',
    name: 'Dizziness & motion sickness',
    unit: '/10',
    decimals: 1,
    acquisition: 'self-check',
    cadenceHours: 24,
    display: { min: 0, max: 10 },
    plausible: { min: 0, max: 10 },
    thresholds: { nominal: { min: 0, max: 2 }, caution: { min: 0, max: 5 } },
    whyItMatters:
      'The balance system must readapt after every gravity change. Disorientation makes piloting, driving and spacewalks unsafe.',
    howToMeasure: 'Rate dizziness, nausea and disorientation today from 0 (none) to 10 (unable to work).',
    guidance: {
      caution: [
        'Move slowly and keep your head movements small.',
        'Fix your gaze on a stable visual reference when symptoms rise.',
        'Avoid piloting or driving tasks until the score is back under 3.',
      ],
      critical: [
        'Stop vehicle operation and spacewalk preparation.',
        'Take anti-motion-sickness medication following the onboard procedure.',
        'Tell the Crew Medical Officer and hand over critical tasks.',
      ],
    },
    reference: 'Illustrative self-report scale.',
  },
  bodyTemp: {
    id: 'bodyTemp',
    systemId: 'immune',
    name: 'Body temperature',
    unit: '°C',
    decimals: 1,
    acquisition: 'sensor',
    cadenceHours: 2,
    display: { min: 34.5, max: 40 },
    plausible: { min: 30, max: 44 },
    thresholds: { nominal: { min: 36, max: 37.5 }, caution: { min: 35, max: 38.4 } },
    whyItMatters:
      'Fever is often the first measurable sign of infection or of a reactivated virus, and infections spread fast in a closed habitat.',
    howToMeasure: 'Read by the skin-patch sensor. Confirm any high value with the ear or oral thermometer.',
    guidance: {
      caution: [
        'Confirm with the handheld thermometer.',
        'Rest, hydrate and re-check in 2 hours.',
        'Check your skin for rashes or sores and log anything new.',
      ],
      critical: [
        'Limit contact with crewmates and wear a mask in shared modules.',
        'Take a fever reducer following the onboard procedure.',
        'Tell the Crew Medical Officer and request a flight surgeon consult.',
      ],
    },
    reference: 'Typical adult range about 36.1–37.2 °C; fever is commonly defined from 38 °C.',
  },
  glucose: {
    id: 'glucose',
    systemId: 'metabolic',
    name: 'Blood glucose',
    unit: 'mg/dL',
    decimals: 0,
    acquisition: 'self-check',
    cadenceHours: 24,
    display: { min: 40, max: 280 },
    plausible: { min: 20, max: 600 },
    thresholds: { nominal: { min: 70, max: 140 }, caution: { min: 54, max: 250 } },
    whyItMatters:
      'Glucose shows whether energy intake matches demand. Inactivity and stress can also reduce insulin sensitivity in flight.',
    howToMeasure: 'Fingerstick with the onboard meter before breakfast. Wash and dry the finger first.',
    guidance: {
      caution: [
        'If low: eat 15 g of fast carbohydrate and re-check in 15 minutes.',
        'If high: drink water, take a short exercise block and re-check before the next meal.',
        'Log what and when you last ate.',
      ],
      critical: [
        'If low: take fast carbohydrate now and do not work alone.',
        'If high: check for ketones if strips are available and hydrate.',
        'Tell the Crew Medical Officer and request a flight surgeon consult.',
      ],
    },
    reference: 'American Diabetes Association: hypoglycemia below 70 mg/dL (level 2 below 54); marked hyperglycemia above 250.',
  },
  calorieIntake: {
    id: 'calorieIntake',
    systemId: 'metabolic',
    name: 'Energy intake',
    unit: '% of target',
    decimals: 0,
    acquisition: 'self-check',
    cadenceHours: 24,
    display: { min: 40, max: 140 },
    plausible: { min: 0, max: 300 },
    thresholds: { nominal: { min: 90, max: 115 }, caution: { min: 70, max: 130 } },
    whyItMatters:
      'Eating below your requirement speeds up muscle and bone loss and weakens immunity. Appetite often drops in flight.',
    howToMeasure: 'Scan each food package in the meal tracker. The app compares the day’s total with your personal target.',
    guidance: {
      caution: [
        'Add a snack between meals today.',
        'Pick energy-dense items you actually like from the pantry.',
        'Eat with the crew: shared meals raise intake.',
      ],
      critical: [
        'Log body mass today and compare with last week.',
        'Review the menu with the Crew Medical Officer.',
        'Ask ground nutrition support for an adjusted meal plan.',
      ],
    },
    reference: 'Illustrative band around the individual energy requirement. Not a NASA limit.',
  },
  radiationDose: {
    id: 'radiationDose',
    systemId: 'radiation',
    name: 'Mission radiation dose',
    unit: 'mSv',
    decimals: 1,
    acquisition: 'sensor',
    cadenceHours: 6,
    display: { min: 0, max: 650 },
    plausible: { min: 0, max: 5000 },
    thresholds: doseThresholds(MISSION_DOSE_BUDGET_MSV),
    whyItMatters:
      'Dose only goes up. Tracking it against the mission budget tells you when shielding and schedule changes are worth their cost.',
    howToMeasure: 'Read from your personal active dosimeter. Keep it on your body at all times, including during sleep.',
    guidance: {
      caution: [
        'Spend rest and sleep periods in the best-shielded module.',
        'Check the space weather forecast before planning any spacewalk.',
        'Confirm your dosimeter is charged and worn correctly.',
      ],
      critical: [
        'Move to the storm shelter during any solar particle event.',
        'Postpone spacewalks and surface excursions.',
        'Report cumulative dose so mission planners can adjust your exposure.',
      ],
    },
    reference: 'Tracked against a mission budget set by the program (none set). NASA publishes no yellow or red limit for daily or cumulative dose on exploration missions.',
  },
  ppCO2: {
    id: 'ppCO2',
    systemId: 'respiratory',
    name: 'Cabin CO₂ (1-hour average)',
    unit: 'mmHg',
    decimals: 1,
    acquisition: 'sensor',
    cadenceHours: 1,
    display: { min: 0, max: 8 },
    plausible: { min: 0, max: 40 },
    // Official limit: 3 mmHg. Off-nominal limits are set per program, so exceeding 3 is
    // "caution" and nothing here is "critical" until a program limit is configured.
    thresholds: { nominal: { min: 0, max: 3 }, caution: { min: 0, max: INF } },
    whyItMatters:
      'CO₂ builds up in a closed cabin and in pockets of still air. On the station, the odds of headache roughly doubled for each extra 1 mmHg.',
    howToMeasure: 'Read by the cabin atmosphere monitor nearest to you. The value shown is the average of the last hour.',
    guidance: {
      caution: [
        'Increase CO₂ scrubbing and ventilation in this module.',
        'Move out of still-air pockets and point a fan at your work area.',
        'Reduce exertion and re-check the one-hour average.',
      ],
      critical: [
        'Follow the cabin atmosphere off-nominal procedure.',
        'Alert the whole crew and move to a module with lower CO₂.',
        'Report to mission control as soon as communications allow.',
      ],
    },
    reference: 'NASA-STD-3001 Vol. 2 [V2 6004]: one-hour average ppCO₂ of 3 mmHg or less. Off-nominal limits are set per program.',
  },
  retinalThickness: {
    id: 'retinalThickness',
    systemId: 'sensory',
    name: 'Retinal thickness change (OCT)',
    unit: 'µm',
    decimals: 0,
    acquisition: 'self-check',
    cadenceHours: 336,
    display: { min: -20, max: 90 },
    plausible: { min: -150, max: 300 },
    thresholds: { nominal: { min: -20, max: 19 }, caution: { min: -20, max: 54 } },
    whyItMatters:
      'Swelling of the optic nerve head is the earliest measurable sign of SANS and can appear before you notice any change in vision.',
    howToMeasure:
      'Run the OCT scan of both eyes. The value is the change in total peripapillary retinal thickness against your pre-flight scan; the worse eye counts.',
    guidance: {
      caution: [
        'Repeat the OCT scan to confirm the change.',
        'Review cabin CO₂, your sleep and the fluid-shift countermeasures.',
        'Report the change at your next private medical conference.',
      ],
      critical: [
        'Stop vision-critical tasks if you notice any visual deficit.',
        'Run the full vision test set: acuity, grid and refraction.',
        'Tell the Crew Medical Officer and send the scans to the flight surgeons.',
      ],
    },
    reference: 'NASA SANS clinical criteria: 20 µm or more is an early indication; 55 µm or more and/or Frisén grade 1 or higher is clinically concerning.',
  },
  protonFlux: {
    id: 'protonFlux',
    systemId: 'radiation',
    name: 'Solar proton flux (≥10 MeV)',
    unit: 'pfu',
    decimals: 1,
    acquisition: 'sensor',
    cadenceHours: 1,
    display: { min: 0, max: 2500 },
    plausible: { min: 0, max: 1000000 },
    // NOAA S-scale: S1 from 10 pfu, S3 from 1,000 pfu.
    thresholds: { nominal: { min: 0, max: 9.99 }, caution: { min: 0, max: 999.99 } },
    whyItMatters:
      'A solar particle event can deliver in hours the dose of many ordinary days. Flux rises before the dose does, which leaves time to take shelter.',
    howToMeasure: 'Read from the space weather feed and the vehicle particle detector. Values are protons at 10 MeV or more.',
    guidance: {
      caution: [
        'Check the space weather alert and the forecast.',
        'Postpone or end spacewalks and surface excursions.',
        'Be ready to move to the storm shelter.',
      ],
      critical: [
        'Move to the storm shelter now.',
        'Reconfigure water and stowage mass as shielding.',
        'Keep your personal dosimeter on and log the dose.',
      ],
    },
    reference: 'NOAA Space Weather Scale for solar radiation storms: S1 from 10 pfu, S2 from 100, S3 from 1,000. An operational scale, not a NASA limit.',
  },
};

export const INDICATOR_LIST: IndicatorDef[] = Object.values(INDICATORS);

export const indicatorsOf = (systemId: SystemId): IndicatorDef[] =>
  INDICATOR_LIST.filter((d) => d.systemId === systemId);
