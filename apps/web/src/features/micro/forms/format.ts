// Small helpers shared by the T-20 culture dialogs. LD-140 (2026-11-13): no styling here; this file only holds rules and text.
import type { MicroCodeDto } from '../server/types';

const HOUR = 3_600_000;
export const PLANTING_WINDOW_HOURS = 72; // AC-03.1: planted_at <= now and >= now - 72 h

/** Inline message for a planting time outside [now - 72 h, now]; undefined when it is fine. */
export function plantedError(iso: string | undefined, now: number): string | undefined {
  if (!iso) return 'Enter the time the plates were planted.';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Enter the time the plates were planted.';
  if (t > now) return 'Planted at cannot be in the future.';
  if (t < now - PLANTING_WINDOW_HOURS * HOUR) return `Planted at cannot be more than ${PLANTING_WINDOW_HOURS} hours ago.`;
  return undefined;
}

const KATHMANDU = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }); // [CONV] CV §4.8 tenant zone
/** "06/11/2026 10:00 AM" in the tenant zone; "—" for a missing or unparseable instant. */
export function whenText(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const p: Record<string, string> = {};
  for (const x of KATHMANDU.formatToParts(d)) p[x.type] = x.value;
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${(p['dayPeriod'] ?? '').toUpperCase()}`.trim();
}

/** Coded-set options for the kit CodedSelect (inactive codes are hidden by the kit unless currently chosen). */
export const toOptions = (codes: readonly MicroCodeDto[]) => codes.map((c) => ({ code: c.code, display: c.display, isActive: c.is_active }));
export const displayOf = (codes: readonly MicroCodeDto[], code: string | undefined) => (code ? codes.find((c) => c.code === code)?.display ?? code : undefined);
