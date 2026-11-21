// C9 T-24 TAT labels and formatting (04-UI-UX §2.10: level chips carry the word, "4 h 12 min / 4 h", Segment = short label + tooltip with the full definition [AC-14.8]).
import { staffRoutes } from '@/core/nav/generated';
import type { TatAlert, TatLevel } from '../types';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const TAT_LEVEL: Record<TatLevel, { label: string; tone: Tone; rank: number }> = {
  none: { label: 'None', tone: 'neutral', rank: 0 },
  warning: { label: 'Warning', tone: 'warning', rank: 1 },
  breached: { label: 'Breached', tone: 'danger', rank: 2 },
  escalated: { label: 'Escalated', tone: 'danger', rank: 3 },
};
export const SEGMENT_SHORT: Record<TatAlert['segment'], string> = { within_lab: 'Within lab', total: 'Total' };

/** Duration for a TAT figure: "42 min", "4 h 12 min", "4 h", "2 d 3 h" (floored; the kit formatter would print "4 h 0 min"). */
export function tatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (m < 60) return `${m} min`;
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** True when the alert reached a level above the one that was acknowledged (or was never acknowledged). */
export const outranksAck = (r: TatAlert) => r.alert_level !== 'none' && (!r.acknowledged_level || TAT_LEVEL[r.alert_level].rank > TAT_LEVEL[r.acknowledged_level].rank);
/** "New level since acknowledgement" (AC-14.6): acknowledged once, then a higher level was reached. */
export const isReRaised = (r: TatAlert) => !!r.acknowledged_level && outranksAck(r);

/** Path of a staff route from the route table (contracts/routes.yaml), e.g. buildRoute('staff.lab.specimen', { specimen_id }). */
export function buildRoute(id: string, params: Record<string, string>): string | undefined {
  const route = staffRoutes.find((r) => r.id === id);
  return route?.path.replace(/\{([a-z_]+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
}
