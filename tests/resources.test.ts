import { describe, expect, it } from 'vitest';
import { MemoryResourceRepository } from '../src/data/resources/ResourceRepository';
import { ResourceStore } from '../src/data/resources/ResourceStore';
import { RULES, ruleById } from '../src/domain/evidence/catalog';
import { addDays, daysUntil, isDateString } from '../src/domain/resources/dates';
import { computeAlerts, conditionOf, findingsFor, isUsable } from '../src/domain/resources/findings';
import { CSV_TEMPLATE, parseCsv, parseInventoryFile } from '../src/domain/resources/importing';
import { applyMovement, nextId, ResourceError, validateResource } from '../src/domain/resources/inventory';
import { needsOf, procedureName } from '../src/domain/resources/protocols';
import { assessProtocol } from '../src/domain/resources/readiness';
import { demoSeed } from '../src/domain/resources/seed';
import type { CrewMember, Resource, ResourceInput } from '../src/domain/resources/types';

const NOW = new Date(2026, 10, 15, 12, 0, 0);
const d = (days: number): string => addDays(NOW, days);
const PLAN_OFF = { drugsPreauthorized: false };
const PLAN_ON = { drugsPreauthorized: true };

const stock = (over: Partial<Resource> = {}): Resource => ({
  id: 'MED-0001',
  category: 'pharmaceutical',
  typeCode: 'analgesic',
  name: 'Analgesic tablets',
  quantity: 20,
  reserved: 0,
  unit: 'tablets',
  minStock: 5,
  location: 'Locker A1',
  state: 'available',
  lot: 'L1',
  expiresOn: d(200),
  active: true,
  simulated: false,
  createdAt: '',
  updatedAt: '',
  ...over,
});
const device = (over: Partial<Resource> = {}): Resource => ({
  id: 'DEV-0001',
  category: 'device',
  typeCode: 'oct-scanner',
  name: 'OCT scanner',
  quantity: 1,
  reserved: 0,
  unit: 'units',
  minStock: null,
  location: 'Medical bay',
  state: 'operational',
  nextCalibration: d(100),
  active: true,
  simulated: false,
  createdAt: '',
  updatedAt: '',
  ...over,
});
const member = (over: Partial<CrewMember> = {}): CrewMember => ({
  id: 'CREW-01',
  name: 'A. Okafor',
  role: 'CMO',
  availability: 'available',
  certifications: [{ procedureCode: 'oct-exam', level: 'operator', certifiedOn: d(-100), expiresOn: d(200) }],
  simulated: false,
  updatedAt: '',
  ...over,
});
const input = (over: Partial<ResourceInput> = {}): ResourceInput => ({
  category: 'consumable',
  typeCode: 'wound-dressing',
  name: 'Sterile dressings',
  quantity: 10,
  unit: 'dressings',
  minStock: 2,
  location: 'Locker A2',
  state: 'available',
  ...over,
});
const newStore = async (): Promise<ResourceStore> => {
  const store = new ResourceStore(new MemoryResourceRepository(), { currentUser: () => 'Tester', now: () => NOW });
  await store.init();
  return store;
};

describe('dates', () => {
  it('validates and compares calendar dates', () => {
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('2026-11-15')).toBe(true);
    expect(daysUntil(d(0), NOW)).toBe(0);
    expect(daysUntil(d(-3), NOW)).toBe(-3);
  });
});

describe('movements', () => {
  const move = (resource: Resource, type: Parameters<typeof applyMovement>[1]['type'], quantity: number) => applyMovement(resource, { resourceId: resource.id, type, quantity, reason: 'test' });

  it('adds, consumes, reserves and returns', () => {
    expect(move(stock(), 'restock', 5).quantity).toBe(25);
    expect(move(stock(), 'consumption', 4).quantity).toBe(16);
    expect(move(stock(), 'reservation', 6)).toMatchObject({ quantity: 20, reserved: 6 });
    expect(move(stock({ reserved: 6 }), 'return', 4)).toMatchObject({ quantity: 20, reserved: 2 });
    expect(move(stock({ reserved: 2 }), 'return', 5)).toMatchObject({ quantity: 23, reserved: 0 });
  });

  it('never lets the count go below zero or takes what is not free', () => {
    expect(() => move(stock(), 'consumption', 21)).toThrow(ResourceError);
    expect(() => move(stock({ reserved: 18 }), 'consumption', 3)).toThrow(/reserved/);
    expect(() => move(stock({ reserved: 18 }), 'reservation', 3)).toThrow(ResourceError);
    expect(() => move(stock(), 'expired', 21)).toThrow(ResourceError);
    expect(() => move(stock(), 'consumption', 0)).toThrow(ResourceError);
    expect(() => move(stock(), 'consumption', 1.5)).toThrow(ResourceError);
    expect(() => move(stock({ active: false }), 'restock', 1)).toThrow(/deactivated/);
  });

  it('requires a reason', () => {
    expect(() => applyMovement(stock(), { resourceId: 'MED-0001', type: 'restock', quantity: 1, reason: ' ' })).toThrow(/why/);
  });

  it('marks equipment out of service when its last unit is damaged', () => {
    expect(move(device(), 'damaged', 1)).toMatchObject({ quantity: 0, state: 'out_of_service' });
    expect(move(stock(), 'expired', 20)).toMatchObject({ quantity: 0, state: 'expired' });
  });
});

describe('validation', () => {
  it('accepts a complete record and names what is wrong otherwise', () => {
    expect(validateResource(input(), [])).toEqual({});
    const errors = validateResource(input({ name: ' ', quantity: -1, unit: '', location: '', expiresOn: '2026-13-01' }), []);
    expect(Object.keys(errors).sort()).toEqual(['expiresOn', 'location', 'name', 'quantity', 'unit']);
  });

  it('refuses a duplicate identifier and a duplicate lot in the same place', () => {
    const existing = stock();
    expect(validateResource(input({ id: 'med-0001' }), [existing]).id).toMatch(/already in use/);
    expect(validateResource({ ...existing, id: undefined }, [existing]).lot).toMatch(/already registered/);
    expect(validateResource({ ...existing, id: undefined, lot: 'L2' }, [existing]).lot).toBeUndefined();
  });

  it('rejects a state that does not belong to the category', () => {
    expect(validateResource(input({ state: 'operational' }), []).state).toBeDefined();
  });

  it('hands out the next free identifier per category', () => {
    expect(nextId('pharmaceutical', ['MED-0001', 'MED-0007', 'DEV-0020'])).toBe('MED-0008');
    expect(nextId('emergency', [])).toBe('EMR-0001');
  });
});

describe('findings and alerts', () => {
  it('reads the condition from dates and counts', () => {
    expect(conditionOf(stock(), NOW)).toEqual({ level: 'ok', label: 'Available' });
    expect(conditionOf(stock({ expiresOn: d(-1) }), NOW).label).toBe('Expired');
    expect(conditionOf(stock({ expiresOn: d(10) }), NOW).label).toBe('Expires soon');
    expect(conditionOf(stock({ quantity: 4 }), NOW).label).toBe('Low stock');
    expect(conditionOf(stock({ quantity: 0 }), NOW).level).toBe('critical');
    expect(conditionOf(device({ nextCalibration: d(-2) }), NOW)).toEqual({ level: 'critical', label: 'Calibration overdue' });
    expect(conditionOf(device({ batteryPct: 10 }), NOW).label).toBe('Battery low');
    expect(conditionOf(stock({ active: false }), NOW).level).toBe('inactive');
  });

  it('knows what may be used for a protocol', () => {
    expect(isUsable(stock(), NOW)).toBe(true);
    expect(isUsable(stock({ expiresOn: d(-1) }), NOW)).toBe(false);
    expect(isUsable(stock({ state: 'quarantined' }), NOW)).toBe(false);
    expect(isUsable(stock({ expiresOn: d(5) }), NOW)).toBe(true);
    expect(isUsable(device({ nextCalibration: d(-1) }), NOW)).toBe(false);
    expect(isUsable(device({ state: 'out_of_service' }), NOW)).toBe(false);
    expect(isUsable(device({ nextMaintenance: d(-1) }), NOW)).toBe(true);
  });

  it('gives each problem one stable alert, worst first, and none for deactivated records', () => {
    const resources = [stock({ quantity: 3 }), device({ nextCalibration: d(-2) }), stock({ id: 'MED-0002', expiresOn: d(-5), active: false })];
    const crew = [member({ certifications: [{ procedureCode: 'oct-exam', level: 'operator', certifiedOn: d(-400), expiresOn: d(10) }] })];
    const first = computeAlerts(resources, crew, NOW, procedureName);
    const second = computeAlerts(resources, crew, NOW, procedureName);
    expect(first.map((a) => a.id)).toEqual(second.map((a) => a.id));
    expect(new Set(first.map((a) => a.id)).size).toBe(first.length);
    expect(first[0].level).toBe('critical');
    expect(first.map((a) => a.kind).sort()).toEqual(['calibration_overdue', 'certification_expiring', 'low_stock']);
    expect(findingsFor(resources[2], NOW)).toEqual([]);
  });
});

describe('protocol requirements', () => {
  it('has one entry per treatment step of every rule', () => {
    for (const rule of RULES) expect(needsOf(rule.id)).toHaveLength(rule.treat.length);
  });
});

describe('resource intelligence', () => {
  const sans = ruleById('R-SANS')!;
  const octStep = (resources: Resource[], crew: CrewMember[]) => assessProtocol(sans, resources, crew, PLAN_OFF, NOW).steps[1];

  it('reports a step as ready only when the item is usable and someone trained is available', () => {
    expect(octStep([device()], [member(), member({ id: 'CREW-02', name: 'B' })]).readiness).toBe('ready');
    expect(octStep([device()], [member()]).readiness).toBe('ready_with_limits');
    expect(octStep([], [member()]).readiness).toBe('blocked');
    expect(octStep([device({ nextCalibration: d(-1) })], [member()]).items[0].outcome).toBe('unusable');
    expect(octStep([device({ state: 'out_of_service' })], [member()]).readiness).toBe('blocked');
    expect(octStep([device()], []).readiness).toBe('blocked');
    expect(octStep([device()], [member({ availability: 'off_duty' })]).readiness).toBe('blocked');
  });

  it('does not count an expired certification or one below the level asked', () => {
    const expired = member({ certifications: [{ procedureCode: 'oct-exam', level: 'operator', certifiedOn: d(-400), expiresOn: d(-1) }] });
    const assistant = member({ certifications: [{ procedureCode: 'oct-exam', level: 'awareness', certifiedOn: d(-10) }] });
    expect(octStep([device()], [expired]).personnel[0].qualified).toHaveLength(0);
    expect(octStep([device()], [assistant]).personnel[0].qualified).toHaveLength(0);
  });

  it('keeps a medication step withheld without authorization, whatever is on board', () => {
    const co2 = ruleById('R-CO2')!;
    const nurse = member({ certifications: [{ procedureCode: 'medication-administration', level: 'operator', certifiedOn: d(-10) }] });
    expect(assessProtocol(co2, [stock()], [nurse, { ...nurse, id: 'CREW-02', name: 'B' }], PLAN_OFF, NOW).steps[3].readiness).toBe('needs_authorization');
    expect(assessProtocol(co2, [stock()], [nurse, { ...nurse, id: 'CREW-02', name: 'B' }], PLAN_ON, NOW).steps[3].readiness).toBe('ready');
    expect(assessProtocol(co2, [stock({ expiresOn: d(-1) })], [nurse], PLAN_ON, NOW).steps[3].readiness).toBe('blocked');
  });

  it('uses an alternative only when the protocol lists it', () => {
    const muscle = ruleById('R-MUSCLE')!;
    const setup = member({ certifications: [{ procedureCode: 'exercise-device-setup', level: 'operator', certifiedOn: d(-10) }] });
    const red = device({ id: 'DEV-0006', typeCode: 'resistive-exercise-device', name: 'RED', nextCalibration: undefined });
    const cycle = device({ id: 'DEV-0008', typeCode: 'cycle-ergometer', name: 'Cycle', nextCalibration: undefined });
    const broken = device({ id: 'DEV-0007', typeCode: 'treadmill', name: 'Treadmill', state: 'out_of_service', nextCalibration: undefined });
    const withCycle = assessProtocol(muscle, [red, broken, cycle], [setup], PLAN_OFF, NOW).steps[0];
    expect(withCycle.items[1].outcome).toBe('alternative');
    expect(withCycle.readiness).toBe('ready_with_limits');
    // An unrelated working device is never offered in place of a missing one.
    expect(assessProtocol(muscle, [red, broken, device()], [setup], PLAN_OFF, NOW).steps[0].readiness).toBe('blocked');
  });

  it('says so when the protocol does not specify resources, and escalates level 4 steps', () => {
    const result = assessProtocol(sans, [device()], [member()], PLAN_OFF, NOW);
    expect(result.steps[2].readiness).toBe('unspecified');
    expect(result.steps[3].escalate).toBe(true);
    expect(result.escalations.some((e) => e.includes('Step 4'))).toBe(true);
  });

  it('counts free units across lots and ignores reserved ones', () => {
    const ortho = ruleById('R-ORTHO')!;
    const salt = (id: string, quantity: number, reserved = 0): Resource => stock({ id, typeCode: 'salt-tablets', name: 'Salt', lot: id, quantity, reserved });
    expect(assessProtocol(ortho, [salt('A', 1), salt('B', 1)], [], PLAN_OFF, NOW).steps[0].items[0].outcome).toBe('available');
    expect(assessProtocol(ortho, [salt('A', 5, 4)], [], PLAN_OFF, NOW).steps[0].items[0].outcome).toBe('insufficient');
  });
});

describe('importing', () => {
  it('parses CSV with quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"two\nlines",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('accepts the template and reports bad rows with their number', () => {
    expect(parseInventoryFile(CSV_TEMPLATE, 'csv', []).valid).toHaveLength(1);
    const csv = 'category,name,quantity,unit,location\nconsumable,Gauze,10,pads,A2\nrocket,Thing,1,units,A2\nconsumable,,x,pads,A2\n';
    const result = parseInventoryFile(csv, 'csv', []);
    expect(result.valid).toHaveLength(1);
    expect(result.errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it('refuses duplicates against the inventory and inside the file', () => {
    const json = JSON.stringify([input({ id: 'CON-0009' }), input({ id: 'CON-0009', lot: 'B' }), input({ id: 'MED-0001', lot: 'C' })]);
    const result = parseInventoryFile(json, 'json', [stock()]);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
  });

  it('explains a file it cannot read', () => {
    expect(parseInventoryFile('{nope', 'json', []).errors[0].message).toMatch(/not valid JSON/);
    expect(parseInventoryFile('name,quantity\nx,1\n', 'csv', []).errors[0].message).toMatch(/Missing column/);
  });
});

describe('resource store', () => {
  it('loads the demonstration data once and marks it as simulated', async () => {
    const repository = new MemoryResourceRepository();
    const store = new ResourceStore(repository, { currentUser: () => 'Tester', now: () => NOW });
    await store.init();
    const seed = demoSeed(NOW);
    expect(store.resources).toHaveLength(seed.resources.length);
    expect(store.resources.every((r) => r.simulated)).toBe(true);
    expect(store.crew).toHaveLength(seed.crew.length);
    expect(store.alerts.length).toBeGreaterThan(0);
    const again = new ResourceStore(repository, { currentUser: () => 'Tester', now: () => NOW });
    await again.init();
    expect(again.resources).toHaveLength(seed.resources.length);
    expect(again.movements).toHaveLength(store.movements.length);
  });

  it('keeps every count equal to what its history adds up to', async () => {
    const store = await newStore();
    for (const resource of store.resources) {
      const history = store.movementsOf(resource.id);
      expect(history[0].balance).toEqual({ quantity: resource.quantity, reserved: resource.reserved });
    }
  });

  it('records a movement, updates the count and never rewrites history', async () => {
    const store = await newStore();
    const before = store.resource('MED-0001')!.quantity;
    const count = store.movements.length;
    const movement = await store.recordMovement({ resourceId: 'MED-0001', type: 'consumption', quantity: 3, reason: 'Headache protocol' });
    expect(store.resource('MED-0001')!.quantity).toBe(before - 3);
    expect(movement).toMatchObject({ user: 'Tester', balance: { quantity: before - 3 } });
    expect(store.movements).toHaveLength(count + 1);
    await expect(store.recordMovement({ resourceId: 'MED-0001', type: 'consumption', quantity: 9999, reason: 'x' })).rejects.toThrow(ResourceError);
    expect(store.resource('MED-0001')!.quantity).toBe(before - 3);
    expect(store.movements).toHaveLength(count + 1);
  });

  it('creates with an entry movement, edits details but not the count, and deactivates without deleting', async () => {
    const store = await newStore();
    const created = await store.createResource(input());
    expect(created.id).toMatch(/^CON-\d{4}$/);
    expect(store.movementsOf(created.id)).toHaveLength(1);
    const edited = await store.updateResource(created.id, input({ name: 'Large dressings', quantity: 999, location: 'Locker B' }));
    expect(edited).toMatchObject({ name: 'Large dressings', quantity: 10, location: 'Locker B' });
    await store.setActive(created.id, false);
    expect(store.resource(created.id)!.active).toBe(false);
    expect(store.movementsOf(created.id)).toHaveLength(1);
    expect(store.activeResources.some((r) => r.id === created.id)).toBe(false);
    await expect(store.createResource(input({ id: created.id }))).rejects.toThrow(/already in use/);
  });

  it('finds a record from a QR payload or a typed identifier', async () => {
    const store = await newStore();
    expect(store.findByCode('HELIOS:RES:DEV-0004')?.id).toBe('DEV-0004');
    expect(store.findByCode('  dev-0004 ')?.id).toBe('DEV-0004');
    expect(store.findByCode('NOPE-1')).toBeUndefined();
  });

  it('drops an acknowledged alert, and shows it again if the problem comes back', async () => {
    const store = await newStore();
    const alert = store.alerts.find((a) => a.id === 'CON-0002:low_stock')!;
    await store.acknowledge(alert.id);
    expect(store.alerts.some((a) => a.id === alert.id)).toBe(false);
    await store.recordMovement({ resourceId: 'CON-0002', type: 'restock', quantity: 50, reason: 'Resupply' });
    await store.acknowledge('unrelated', false);
    await store.recordMovement({ resourceId: 'CON-0002', type: 'consumption', quantity: 50, reason: 'Used' });
    expect(store.alerts.some((a) => a.id === alert.id)).toBe(true);
  });

  it('connects the inventory to the protocols: a fixed device unblocks its step', async () => {
    const store = await newStore();
    const before = store.readiness('R-SANS', PLAN_OFF)!;
    expect(before.steps[1].readiness).toBe('blocked');
    expect(before.nonOperational.map((c) => c.need.typeCode)).toContain('oct-scanner');
    await store.updateResource('DEV-0004', { ...store.resource('DEV-0004')!, nextCalibration: d(90) });
    expect(store.readiness('R-SANS', PLAN_OFF)!.steps[1].readiness).not.toBe('blocked');
  });

  it('imports valid rows together and validates crew certifications', async () => {
    const store = await newStore();
    const preview = store.previewImport(CSV_TEMPLATE, 'csv');
    expect(await store.importResources(preview.valid)).toBe(1);
    expect(store.previewImport(CSV_TEMPLATE, 'csv').valid).toHaveLength(0);
    await expect(
      store.saveCrewMember({ name: 'New Person', role: 'Engineer', availability: 'available', certifications: [{ procedureCode: 'wound-care', level: 'operator', certifiedOn: d(0), expiresOn: d(-5) }] }),
    ).rejects.toThrow(/before the certification date/);
    const saved = await store.saveCrewMember({ name: 'New Person', role: 'Engineer', availability: 'available', certifications: [] });
    expect(saved.id).toBe('CREW-05');
    await store.removeCrewMember(saved.id);
    expect(store.crew.some((c) => c.id === saved.id)).toBe(false);
  });
});
