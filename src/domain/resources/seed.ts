import { addDays } from './dates';
import type { CrewInput, MovementType, ResourceInput } from './types';

/**
 * SIMULATED DEMONSTRATION DATA.
 *
 * A small, made-up medical kit and roster so the module can be seen working. Names,
 * quantities, lots and storage notes are illustrative only: they are not a recommended
 * manifest for any mission and say nothing about what should be given to anyone.
 *
 * Dates are set relative to today, so the demonstration always has something expiring
 * soon, something overdue and something healthy, whenever it is opened.
 */
export interface SeedMovement {
  resourceId: string;
  type: MovementType;
  quantity: number;
  reason: string;
  notes?: string;
  daysAgo: number;
  user: string;
}

export interface Seed {
  resources: (ResourceInput & { id: string })[];
  crew: (CrewInput & { id: string })[];
  movements: SeedMovement[];
}

export function demoSeed(now: Date): Seed {
  const d = (days: number): string => addDays(now, days);
  const med = (id: string, name: string, typeCode: string, quantity: number, unit: string, minStock: number, lot: string, expires: number, extra: Partial<ResourceInput> = {}): Seed['resources'][number] => ({
    id,
    category: 'pharmaceutical',
    name,
    typeCode,
    quantity,
    unit,
    minStock,
    location: 'Medical locker A1',
    state: 'available',
    lot,
    expiresOn: d(expires),
    storage: 'Room temperature, dry, away from light',
    ...extra,
  });
  const con = (id: string, name: string, typeCode: string, quantity: number, unit: string, minStock: number, expires: number | null, extra: Partial<ResourceInput> = {}): Seed['resources'][number] => ({
    id,
    category: 'consumable',
    name,
    typeCode,
    quantity,
    unit,
    minStock,
    location: 'Medical locker A2',
    state: 'available',
    expiresOn: expires === null ? undefined : d(expires),
    ...extra,
  });
  const dev = (id: string, name: string, typeCode: string, brandModel: [string, string], extra: Partial<ResourceInput> = {}): Seed['resources'][number] => ({
    id,
    category: 'device',
    name,
    typeCode,
    quantity: 1,
    unit: 'units',
    minStock: null,
    location: 'Medical bay',
    state: 'operational',
    brand: brandModel[0],
    model: brandModel[1],
    lastMaintenance: d(-40),
    nextMaintenance: d(140),
    nextCalibration: d(120),
    ...extra,
  });
  const emr = (id: string, name: string, typeCode: string, quantity: number, extra: Partial<ResourceInput> = {}): Seed['resources'][number] => ({
    id,
    category: 'emergency',
    name,
    typeCode,
    quantity,
    unit: 'units',
    minStock: null,
    location: 'Emergency rack, node 1',
    state: 'operational',
    lastInspection: d(-20),
    nextInspection: d(70),
    ...extra,
  });

  return {
    resources: [
      med('MED-0001', 'Analgesic tablets', 'analgesic', 48, 'tablets', 12, 'DEMO-AN-2291', 410),
      med('MED-0002', 'Sleep aid tablets', 'sleep-aid', 6, 'tablets', 8, 'DEMO-SL-1044', 250),
      med('MED-0003', 'Antiviral tablets', 'antiviral', 20, 'tablets', 6, 'DEMO-AV-0387', 18),
      med('MED-0004', 'Vitamin D capsules', 'vitamin-d', 180, 'capsules', 30, 'DEMO-VD-7712', 520),
      med('MED-0005', 'Bisphosphonate tablets', 'bisphosphonate', 12, 'tablets', 4, 'DEMO-BP-5530', -12, { location: 'Medical locker A1, shelf 3' }),
      med('MED-0006', 'Salt tablets', 'salt-tablets', 60, 'tablets', 10, 'DEMO-NA-9002', 300, { location: 'Galley medical drawer' }),
      con('CON-0001', 'Sterile wound dressings', 'wound-dressing', 24, 'dressings', 8, 600, { lot: 'DEMO-WD-118' }),
      con('CON-0002', 'Antiseptic wipes', 'antiseptic-wipes', 20, 'wipes', 10, 240, { lot: 'DEMO-AW-552' }),
      con('CON-0003', 'Examination gloves', 'exam-gloves', 120, 'gloves', 20, null),
      con('CON-0004', 'Disinfectant wipes', 'disinfectant-wipes', 60, 'wipes', 12, 330, { lot: 'DEMO-DW-077', location: 'Hygiene station' }),
      con('CON-0005', 'Face masks', 'face-mask', 30, 'masks', 6, null, { location: 'Hygiene station' }),
      con('CON-0006', 'Compression garments', 'compression-garment', 3, 'garments', 1, null, { location: 'Crew quarters locker' }),
      dev('DEV-0001', 'Blood pressure monitor', 'blood-pressure-monitor', ['Demo Instruments', 'BP-200'], { batteryPct: 82 }),
      dev('DEV-0002', 'Pulse oximeter', 'pulse-oximeter', ['Demo Instruments', 'OX-10'], { batteryPct: 14, quantity: 2 }),
      dev('DEV-0003', 'Thermometer', 'thermometer', ['Demo Instruments', 'T-5'], { batteryPct: 67, quantity: 2 }),
      dev('DEV-0004', 'OCT retinal scanner', 'oct-scanner', ['Demo Optics', 'OCT-S2'], { nextCalibration: d(-6), batteryPct: null }),
      dev('DEV-0005', 'Lower body negative pressure device', 'lbnp-device', ['Demo Aerospace', 'LBNP-1'], { location: 'Exercise module', nextMaintenance: d(9), batteryPct: null }),
      dev('DEV-0006', 'Resistive exercise device', 'resistive-exercise-device', ['Demo Aerospace', 'RED-3'], { location: 'Exercise module', nextCalibration: undefined, batteryPct: null }),
      dev('DEV-0007', 'Treadmill', 'treadmill', ['Demo Aerospace', 'TM-2'], { location: 'Exercise module', state: 'out_of_service', nextCalibration: undefined, batteryPct: null, notes: 'Belt drive fault reported. Awaiting repair.' }),
      dev('DEV-0008', 'Cycle ergometer', 'cycle-ergometer', ['Demo Aerospace', 'CE-4'], { location: 'Exercise module', nextCalibration: undefined, batteryPct: null }),
      dev('DEV-0009', 'Personal dosimeters', 'personal-dosimeter', ['Demo Radiation', 'PD-7'], { quantity: 4, location: 'Worn by the crew', batteryPct: 91 }),
      emr('EMR-0001', 'Automated external defibrillator', 'defibrillator', 1, { batteryPct: 96, brand: 'Demo Cardiac', model: 'AED-9' }),
      emr('EMR-0002', 'Emergency oxygen bottles', 'emergency-oxygen', 2, { nextInspection: d(6) }),
      emr('EMR-0003', 'Airway kit', 'airway-kit', 1),
      emr('EMR-0004', 'Eye wash station', 'eye-wash', 1, { nextInspection: d(-3), location: 'Lab module' }),
    ],
    crew: [
      {
        id: 'CREW-01',
        name: 'A. Okafor',
        role: 'Crew Medical Officer',
        availability: 'available',
        certifications: [
          { procedureCode: 'cmo-checklist', level: 'advanced', certifiedOn: d(-200), expiresOn: d(530) },
          { procedureCode: 'vital-signs', level: 'advanced', certifiedOn: d(-200) },
          { procedureCode: 'medication-administration', level: 'advanced', certifiedOn: d(-200), expiresOn: d(530) },
          { procedureCode: 'basic-life-support', level: 'advanced', certifiedOn: d(-340), expiresOn: d(25) },
          { procedureCode: 'airway-management', level: 'operator', certifiedOn: d(-200), expiresOn: d(530) },
          { procedureCode: 'wound-care', level: 'advanced', certifiedOn: d(-200) },
          { procedureCode: 'oct-exam', level: 'operator', certifiedOn: d(-200), expiresOn: d(165) },
        ],
      },
      {
        id: 'CREW-02',
        name: 'M. Lindqvist',
        role: 'Flight engineer',
        availability: 'available',
        certifications: [
          { procedureCode: 'vital-signs', level: 'operator', certifiedOn: d(-180) },
          { procedureCode: 'basic-life-support', level: 'operator', certifiedOn: d(-180), expiresOn: d(185) },
          { procedureCode: 'exercise-device-setup', level: 'advanced', certifiedOn: d(-180) },
          { procedureCode: 'lbnp-operation', level: 'operator', certifiedOn: d(-400), expiresOn: d(-35) },
          { procedureCode: 'wound-care', level: 'awareness', certifiedOn: d(-180) },
        ],
      },
      {
        id: 'CREW-03',
        name: 'R. Tanaka',
        role: 'Pilot',
        availability: 'off_duty',
        certifications: [
          { procedureCode: 'vital-signs', level: 'awareness', certifiedOn: d(-180) },
          { procedureCode: 'basic-life-support', level: 'operator', certifiedOn: d(-180), expiresOn: d(185) },
          { procedureCode: 'oct-exam', level: 'operator', certifiedOn: d(-180), expiresOn: d(185) },
        ],
      },
      {
        id: 'CREW-04',
        name: 'S. Haddad',
        role: 'Mission specialist',
        availability: 'available',
        certifications: [{ procedureCode: 'exercise-device-setup', level: 'operator', certifiedOn: d(-150) }],
      },
    ],
    movements: [
      { resourceId: 'MED-0002', type: 'consumption', quantity: 2, reason: 'Given per the medical protocol', daysAgo: 9, user: 'A. Okafor' },
      { resourceId: 'CON-0002', type: 'consumption', quantity: 15, reason: 'Minor wound care', daysAgo: 6, user: 'A. Okafor' },
      { resourceId: 'CON-0001', type: 'consumption', quantity: 4, reason: 'Minor wound care', daysAgo: 6, user: 'A. Okafor' },
      { resourceId: 'CON-0001', type: 'reservation', quantity: 6, reason: 'Set aside for the surface excursion kit', daysAgo: 3, user: 'M. Lindqvist' },
      { resourceId: 'MED-0006', type: 'restock', quantity: 20, reason: 'Transferred from the logistics module', daysAgo: 2, user: 'M. Lindqvist' },
    ],
  };
}
