import type { HealthStatus } from './types';

const SEVERITY: Record<HealthStatus, number> = { unknown: 0, nominal: 1, caution: 2, critical: 3 };

export const severity = (s: HealthStatus): number => SEVERITY[s];

export const worst = (a: HealthStatus, b: HealthStatus): HealthStatus => (SEVERITY[b] > SEVERITY[a] ? b : a);

export const worstOf = (list: HealthStatus[]): HealthStatus => list.reduce(worst, 'unknown');

export const STATUS_LABEL: Record<HealthStatus, string> = {
  unknown: 'No data',
  nominal: 'Nominal',
  caution: 'Caution',
  critical: 'Critical',
};

/**
 * Status colors (reserved: used for nothing else in the app) and a shape glyph,
 * so status never depends on color alone.
 */
export const STATUS_COLOR: Record<HealthStatus, string> = {
  unknown: '#8d897f',
  nominal: '#57b978',
  caution: '#d9a13c',
  critical: '#e05a4e',
};

export const STATUS_GLYPH: Record<HealthStatus, string> = {
  unknown: '○',
  nominal: '●',
  caution: '▲',
  critical: '◆',
};
