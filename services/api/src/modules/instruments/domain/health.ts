// Agent health evaluator (03-APP-FLOW §2.4; AC-13.2–13.5). Pure: inputs + now -> state.
import { zonedParts } from './instrumentTime.js';

export type HealthState = 'offline' | 'backlog' | 'degraded' | 'online';

export interface LiveInstrumentHealthInput {
  id: string;
  liveAt: string;
  lastMessageAt: string | null;
  silenceWindowMinutes: number | null;
  silenceActiveFrom: string | null; // 'HH:MM', tenant timezone
  silenceActiveTo: string | null;
}
export interface HealthInput {
  lastHeartbeatAt: string | null;
  queueDepth: number;
  oldestPendingAgeSeconds: number;
  backlogThreshold: number;
  maxOldestPendingSeconds: number;
  tenantTimezone: string;
  liveInstruments: LiveInstrumentHealthInput[];
}

const OFFLINE_AFTER_MS = 3 * 60 * 1000;
const hhmm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** [from, to) in local minutes; unset = all day. [CONV] from > to wraps midnight; from == to is an empty window. */
function insideActiveHours(i: LiveInstrumentHealthInput, localMinutes: number): boolean {
  if (i.silenceActiveFrom === null || i.silenceActiveTo === null) return true;
  const from = hhmm(i.silenceActiveFrom);
  const to = hhmm(i.silenceActiveTo);
  return from <= to ? localMinutes >= from && localMinutes < to : localMinutes >= from || localMinutes < to;
}

export function evaluateHealth(input: HealthInput, nowIso: string): { state: HealthState; silentInstrumentIds: string[] } {
  const now = Date.parse(nowIso);
  const hb = input.lastHeartbeatAt === null ? NaN : Date.parse(input.lastHeartbeatAt);
  if (Number.isNaN(hb) || now - hb > OFFLINE_AFTER_MS) return { state: 'offline', silentInstrumentIds: [] };
  if (input.queueDepth > input.backlogThreshold || input.oldestPendingAgeSeconds > input.maxOldestPendingSeconds) {
    return { state: 'backlog', silentInstrumentIds: [] };
  }
  const z = zonedParts(now, input.tenantTimezone);
  const localMinutes = z.h * 60 + z.mi;
  const silent = input.liveInstruments
    .filter((i) => i.silenceWindowMinutes !== null && insideActiveHours(i, localMinutes)
      && now - Date.parse(i.lastMessageAt ?? i.liveAt) > i.silenceWindowMinutes * 60_000)
    .map((i) => i.id);
  return silent.length ? { state: 'degraded', silentInstrumentIds: silent } : { state: 'online', silentInstrumentIds: [] };
}

/** null = unchanged (no transition row, no event). */
export function healthTransition(stored: HealthState, computed: HealthState): { from: HealthState; to: HealthState } | null {
  return stored === computed ? null : { from: stored, to: computed };
}
