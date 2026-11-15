import type { HabitatId } from './profile';

export interface Habitat {
  id: HabitatId;
  label: string;
  /** Inline SVG markup (static, authored here): no icon font or network request needed. */
  icon: string;
}

const svg = (body: string): string =>
  `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** The places a crew member can live in, in the order they are offered. */
export const HABITATS: Habitat[] = [
  {
    id: 'spacecraft',
    label: 'Spacecraft',
    icon: svg(
      '<path d="M24 5c6 5 9 12 9 20v8H15v-8c0-8 3-15 9-20z"/><circle cx="24" cy="20" r="3.5"/><path d="M15 27l-6 7v5l6-3M33 27l6 7v5l-6-3M20 33v5M24 33v8M28 33v5"/>',
    ),
  },
  {
    id: 'station',
    label: 'Space station',
    icon: svg(
      '<rect x="19" y="17" width="10" height="14" rx="3"/><path d="M19 24h-4M29 24h4M24 17v-6M24 31v6"/><rect x="5" y="14" width="10" height="20" rx="1"/><rect x="33" y="14" width="10" height="20" rx="1"/><path d="M5 21h10M5 27h10M33 21h10M33 27h10M21 11h6"/>',
    ),
  },
  {
    id: 'rover',
    label: 'Exploration rover',
    icon: svg(
      '<path d="M8 28h30l-3-9H17l-4 5H8z"/><path d="M22 19v5h10"/><circle cx="12" cy="34" r="4"/><circle cx="24" cy="34" r="4"/><circle cx="36" cy="34" r="4"/><path d="M33 19V9M33 9l6 3M29 9a4 4 0 0 1 8 0"/>',
    ),
  },
  {
    id: 'lunar-base',
    label: 'Lunar base',
    icon: svg(
      '<path d="M4 38h40"/><path d="M11 38V30a12 12 0 0 1 24 0v8"/><path d="M19 38v-6a4 4 0 0 1 8 0v6M11 29h24"/><path d="M39 7a6 6 0 1 0 4 10 7 7 0 0 1-4-10z"/><path d="M5 43h6M36 43h7"/>',
    ),
  },
  {
    id: 'mars-base',
    label: 'Mars base',
    icon: svg(
      '<path d="M4 38h40"/><path d="M4 38l8-13 5 7 4-5 4 11"/><path d="M24 38v-6a9 9 0 0 1 18 0v6"/><path d="M30 38v-4a3 3 0 0 1 6 0v4"/><circle cx="37" cy="11" r="4.5"/><path d="M6 43h9M30 43h12"/>',
    ),
  },
];
