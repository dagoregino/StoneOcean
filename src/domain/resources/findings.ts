import { daysUntil, relativeDays } from './dates';
import { isStock, LEVEL_RANK, type CrewMember, type Finding, type Level, type Resource, type ResourceAlert } from './types';

/** How far ahead the module warns. One place, so every screen agrees. */
export const WARNING_DAYS = { expiry: 30, calibration: 14, maintenance: 14, inspection: 14, certification: 30 } as const;
export const LOW_BATTERY_PCT = 20;

/** Units free to use now. */
export const freeUnits = (resource: Resource): number => Math.max(0, resource.quantity - resource.reserved);

/**
 * Everything worth knowing about one record today. Screens, alerts and the protocol check
 * all read from here, so "expired" means the same thing everywhere.
 */
export function findingsFor(resource: Resource, now: Date): Finding[] {
  if (!resource.active) return [];
  const findings: Finding[] = [];
  const add = (kind: Finding['kind'], level: Finding['level'], label: string, message: string, blocksUse: boolean): void => {
    findings.push({ kind, level, label, message, blocksUse });
  };
  const free = freeUnits(resource);

  if (isStock(resource.category)) {
    const days = resource.expiresOn ? daysUntil(resource.expiresOn, now) : null;
    if (resource.state === 'expired' || (days !== null && days < 0)) {
      add('expired', 'critical', 'Expired', days !== null ? `Expired ${relativeDays(days)} (${resource.expiresOn}). Do not use; record it as expired to remove it from the count.` : 'Marked as expired. Do not use.', true);
    } else if (days !== null && days <= WARNING_DAYS.expiry) {
      add('expiring_soon', 'attention', 'Expires soon', `Expires ${relativeDays(days)} (${resource.expiresOn}).`, false);
    }
    if (resource.state === 'quarantined') add('quarantined', 'critical', 'Quarantined', 'Held in quarantine: not to be used until it is released.', true);
    if (resource.quantity === 0) add('out_of_stock', 'critical', 'Out of stock', 'None left on board.', true);
    else if (free === 0) add('all_reserved', 'attention', 'All reserved', `All ${resource.quantity} ${resource.unit} are reserved; none are free.`, true);
    else if (resource.minStock !== null && free <= resource.minStock) {
      add('low_stock', 'attention', 'Low stock', `${free} ${resource.unit} free, at or below the minimum of ${resource.minStock}.`, false);
    }
    return findings;
  }

  if (resource.state === 'out_of_service' || resource.quantity === 0) {
    add('out_of_service', 'critical', 'Out of service', resource.quantity === 0 ? 'No working unit on board.' : 'Marked out of service. Do not rely on it.', true);
  } else if (resource.state === 'needs_attention') {
    add('needs_attention', 'attention', 'Needs attention', 'Flagged by the crew as needing attention. Check the notes before use.', false);
  }
  const due = (date: string | undefined, soon: number, overdue: Finding['kind'], upcoming: Finding['kind'], what: string, blocks: boolean): void => {
    if (!date) return;
    const days = daysUntil(date, now);
    if (days < 0) add(overdue, blocks ? 'critical' : 'attention', `${what} overdue`, `${what} was due ${relativeDays(days)} (${date}).`, blocks);
    else if (days <= soon) add(upcoming, 'attention', `${what} due`, `${what} is due ${relativeDays(days)} (${date}).`, false);
  };
  // A reading from an uncalibrated device, or emergency gear past inspection, cannot be trusted.
  due(resource.nextCalibration, WARNING_DAYS.calibration, 'calibration_overdue', 'calibration_due', 'Calibration', true);
  due(resource.nextInspection, WARNING_DAYS.inspection, 'inspection_overdue', 'inspection_due', 'Inspection', true);
  due(resource.nextMaintenance, WARNING_DAYS.maintenance, 'maintenance_overdue', 'maintenance_due', 'Maintenance', false);
  if (typeof resource.batteryPct === 'number' && resource.batteryPct < LOW_BATTERY_PCT) {
    add('battery_low', 'attention', 'Battery low', `Battery at ${resource.batteryPct}%. Charge it before it is needed.`, false);
  }
  return findings;
}

export interface Condition {
  level: Level;
  label: string;
}

/** The one-word state shown in a badge: the worst finding, or the healthy default. */
export function conditionOf(resource: Resource, now: Date): Condition {
  if (!resource.active) return { level: 'inactive', label: 'Deactivated' };
  const worst = findingsFor(resource, now).sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])[0];
  if (worst) return { level: worst.level, label: worst.label };
  if (isStock(resource.category)) return { level: 'ok', label: resource.reserved > 0 ? 'Available · part reserved' : 'Available' };
  return { level: 'ok', label: 'Operational' };
}

/** True when the record can be counted on for a protocol right now. */
export const isUsable = (resource: Resource, now: Date): boolean => resource.active && !findingsFor(resource, now).some((f) => f.blocksUse);

export function crewFindings(member: CrewMember, now: Date, procedureName: (code: string) => string): Finding[] {
  const findings: Finding[] = [];
  for (const cert of member.certifications) {
    if (!cert.expiresOn) continue;
    const days = daysUntil(cert.expiresOn, now);
    const name = procedureName(cert.procedureCode);
    if (days < 0) {
      findings.push({ kind: 'certification_expired', level: 'critical', label: 'Certification expired', message: `${name}: certification expired ${relativeDays(days)} (${cert.expiresOn}).`, blocksUse: true });
    } else if (days <= WARNING_DAYS.certification) {
      findings.push({ kind: 'certification_expiring', level: 'attention', label: 'Certification expiring', message: `${name}: certification expires ${relativeDays(days)} (${cert.expiresOn}).`, blocksUse: false });
    }
  }
  return findings;
}

/**
 * Every open alert, worst first. An alert's id is its record plus its kind, so the same
 * problem is one alert however many times the list is rebuilt, never a new one each time.
 */
export function computeAlerts(resources: readonly Resource[], crew: readonly CrewMember[], now: Date, procedureName: (code: string) => string): ResourceAlert[] {
  const alerts: ResourceAlert[] = [];
  for (const resource of resources) {
    for (const finding of findingsFor(resource, now)) {
      alerts.push({ ...finding, id: `${resource.id}:${finding.kind}`, subject: 'resource', subjectId: resource.id, subjectName: resource.name, category: resource.category });
    }
  }
  for (const member of crew) {
    const seen = new Set<string>();
    for (const cert of member.certifications) {
      const [finding] = crewFindings({ ...member, certifications: [cert] }, now, procedureName);
      const id = `${member.id}:${cert.procedureCode}:${finding?.kind}`;
      if (!finding || seen.has(id)) continue;
      seen.add(id);
      alerts.push({ ...finding, id, subject: 'crew', subjectId: member.id, subjectName: member.name, category: null });
    }
  }
  return alerts.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.subjectName.localeCompare(b.subjectName));
}
