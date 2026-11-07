// Freshness (PRD US-16.1–3, §8.5; 02-TRD §9.2: no refresh_state row = never_refreshed; OpenAPI `Freshness`). Pure; clock injected.
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';

export type StaleReason = 'refresh_lagging' | 'refresh_failed' | 'never_refreshed';
export interface FamilyState {
  readonly family: string;
  readonly lastSuccessAt: IsoUtc | null;
  readonly oldestDirtyAt: IsoUtc | null; // min(first_marked_at) of unprocessed dirty marks
  readonly lastAttemptFailed: boolean;
}
export interface Freshness {
  readonly family: string;
  readonly refreshed_at?: IsoUtc;
  readonly is_stale: boolean;
  readonly stale_reason?: StaleReason;
  readonly live: boolean;
}

const MIN = 60_000;

export function evaluateFreshness(
  s: FamilyState,
  now: IsoUtc,
  cfg: { readonly staleDirtyMinutes: number; readonly staleSuccessMinutes: number },
): Freshness {
  if (s.lastSuccessAt === null) return { family: s.family, is_stale: true, stale_reason: 'never_refreshed', live: false };
  const t = Date.parse(now);
  const base = { family: s.family, refreshed_at: s.lastSuccessAt, live: false };
  if (s.lastAttemptFailed) return { ...base, is_stale: true, stale_reason: 'refresh_failed' };
  const dirtyTooOld = s.oldestDirtyAt !== null && t - Date.parse(s.oldestDirtyAt) > cfg.staleDirtyMinutes * MIN;
  const successTooOld = t - Date.parse(s.lastSuccessAt) > cfg.staleSuccessMinutes * MIN;
  return dirtyTooOld || successTooOld ? { ...base, is_stale: true, stale_reason: 'refresh_lagging' } : { ...base, is_stale: false };
}

/** Live sources (pending_items, agent_status) are never stale; refreshed_at = response time (US-16.3). */
export function liveFreshness(family: string, now: IsoUtc): Freshness {
  return { family, refreshed_at: now, is_stale: false, live: true };
}
