// T0D-DENSITY-1 (LD-310, founder 2026-11-17 04:49 / 05:03 NPT): the per-user screen density preference.
// A UI preference only: the key holds the membership id (no name, tenant or token), the value is "compact" or "regular".
// Kept out of core/shell, whose client files must never touch web storage (r04.source: no tokens in the browser).
// Anything else, or storage that throws (blocked, quota), means compact, the default.
export type Density = 'compact' | 'regular';

const keyOf = (memberId: string | undefined) => `lims.density.${memberId ?? 'default'}`;

export function readDensity(memberId: string | undefined): Density {
  try {
    return window.localStorage.getItem(keyOf(memberId)) === 'regular' ? 'regular' : 'compact';
  } catch {
    return 'compact';
  }
}

export function writeDensity(memberId: string | undefined, d: Density): void {
  try {
    window.localStorage.setItem(keyOf(memberId), d);
  } catch {
    // quota or blocked storage: the choice still applies for this page view
  }
}
