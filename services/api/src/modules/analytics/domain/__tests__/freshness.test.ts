// AN-T02 domain/freshness.ts (PRD US-16.1–3, §8.5; 02-TRD §9.2 "no row = never_refreshed"; OpenAPI `Freshness`). Pure; clock injected.
// Assumed API:
//   evaluateFreshness(s: FamilyState, now: IsoUtc, cfg: { staleDirtyMinutes: number; staleSuccessMinutes: number }): Freshness
//     FamilyState = { family: string; lastSuccessAt: IsoUtc | null; oldestDirtyAt: IsoUtc | null; lastAttemptFailed: boolean }
//     (lastSuccessAt null = no refresh_state row or never succeeded)
//   liveFreshness(family: string, now: IsoUtc): Freshness
//   Freshness (wire shape, snake_case) = { family, refreshed_at?: IsoUtc, is_stale: boolean, stale_reason?: 'refresh_lagging'|'refresh_failed'|'never_refreshed', live: boolean }
import { describe, expect, it } from 'vitest';
import type { IsoUtc } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { loadAnalyticsConfig } from '../../config.js';
import { evaluateFreshness, liveFreshness } from '../freshness.js';

const U = (s: string) => s as IsoUtc;
const NOW = U('2026-11-07T10:00:00.000Z');
const ago = (min: number, extraMs = 0): IsoUtc => new Date(Date.parse(NOW) - min * 60_000 - extraMs).toISOString() as IsoUtc;
const cfg = loadAnalyticsConfig({}); // defaults: dirty 20 min, success 30 min
const st = (o: Partial<{ lastSuccessAt: IsoUtc | null; oldestDirtyAt: IsoUtc | null; lastAttemptFailed: boolean }> = {}) =>
  ({ family: 'income', lastSuccessAt: ago(1), oldestDirtyAt: null, lastAttemptFailed: false, ...o });

describe('defaults the tests rely on', () => {
  it('config defaults are 20 / 30 minutes', () => {
    expect([cfg.staleDirtyMinutes, cfg.staleSuccessMinutes]).toEqual([20, 30]);
  });
});

describe('fresh', () => {
  it('recent success, nothing dirty, no failure -> not stale, refreshed_at = last success, no stale_reason key', () => {
    const f = evaluateFreshness(st(), NOW, cfg);
    expect(f).toEqual({ family: 'income', refreshed_at: ago(1), is_stale: false, live: false });
    expect('stale_reason' in f).toBe(false);
  });
  it('a young dirty mark (5 min) is still fresh', () => {
    expect(evaluateFreshness(st({ oldestDirtyAt: ago(5) }), NOW, cfg).is_stale).toBe(false);
  });
});

describe('US-16.2 dirty-mark rule: oldest unprocessed dirty mark OLDER than 20 min -> refresh_lagging', () => {
  it('exactly 20:00.000 is not stale; one ms older is', () => {
    expect(evaluateFreshness(st({ oldestDirtyAt: ago(20) }), NOW, cfg).is_stale).toBe(false);
    expect(evaluateFreshness(st({ oldestDirtyAt: ago(20, 1) }), NOW, cfg)).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging' });
  });
  it('the OLDEST mark decides (callers pass min(first_marked_at)); 45 min old dirty -> lagging, last values still reported', () => {
    const f = evaluateFreshness(st({ oldestDirtyAt: ago(45) }), NOW, cfg);
    expect(f).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging', refreshed_at: ago(1) });
  });
});

describe('US-16.2 success-age rule: last success OLDER than 30 min -> refresh_lagging (PRD US-01.4: income succeeded 45 min ago)', () => {
  it('exactly 30:00.000 is not stale; one ms older is', () => {
    expect(evaluateFreshness(st({ lastSuccessAt: ago(30) }), NOW, cfg).is_stale).toBe(false);
    expect(evaluateFreshness(st({ lastSuccessAt: ago(30, 1) }), NOW, cfg)).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging' });
  });
  it('45 min old: stale, and refreshed_at still shows the last success so the UI can say "Updated <time>"', () => {
    const f = evaluateFreshness(st({ lastSuccessAt: ago(45) }), NOW, cfg);
    expect(f).toMatchObject({ is_stale: true, stale_reason: 'refresh_lagging', refreshed_at: ago(45), live: false });
  });
});

describe('failure and never-refreshed', () => {
  it('last attempt failed -> refresh_failed even though the last success is young', () => {
    expect(evaluateFreshness(st({ lastAttemptFailed: true }), NOW, cfg)).toMatchObject({ is_stale: true, stale_reason: 'refresh_failed', refreshed_at: ago(1) });
  });
  it('failed AND lagging -> refresh_failed wins (the more specific cause)', () => {
    expect(evaluateFreshness(st({ lastAttemptFailed: true, lastSuccessAt: ago(90), oldestDirtyAt: ago(60) }), NOW, cfg).stale_reason).toBe('refresh_failed');
  });
  it('no success ever -> stale never_refreshed with NO refreshed_at', () => {
    const f = evaluateFreshness(st({ lastSuccessAt: null }), NOW, cfg);
    expect(f).toMatchObject({ family: 'income', is_stale: true, stale_reason: 'never_refreshed', live: false });
    expect(f.refreshed_at).toBeUndefined();
  });
  it('never_refreshed even when dirty marks are young (no data to trust)', () => {
    expect(evaluateFreshness(st({ lastSuccessAt: null, oldestDirtyAt: ago(1) }), NOW, cfg).stale_reason).toBe('never_refreshed');
  });
});

describe('thresholds come from config, not constants', () => {
  it('custom 5/10 minutes', () => {
    const c = loadAnalyticsConfig({ LIMS_ANALYTICS_STALE_DIRTY_MINUTES: '5', LIMS_ANALYTICS_STALE_SUCCESS_MINUTES: '10' });
    expect(evaluateFreshness(st({ oldestDirtyAt: ago(6) }), NOW, c).is_stale).toBe(true);
    expect(evaluateFreshness(st({ lastSuccessAt: ago(11) }), NOW, c).is_stale).toBe(true);
    expect(evaluateFreshness(st({ oldestDirtyAt: ago(4), lastSuccessAt: ago(9) }), NOW, c).is_stale).toBe(false);
  });
});

describe('robustness', () => {
  it('a success timestamp slightly in the future (clock skew) is not stale', () => {
    expect(evaluateFreshness(st({ lastSuccessAt: U('2026-11-07T10:00:05.000Z') }), NOW, cfg).is_stale).toBe(false);
  });
  it('returns a new object each call and does not mutate its input', () => {
    const s = st({ oldestDirtyAt: ago(45) });
    const snap = JSON.stringify(s);
    const a = evaluateFreshness(s, NOW, cfg);
    expect(JSON.stringify(s)).toBe(snap);
    expect(evaluateFreshness(s, NOW, cfg)).not.toBe(a);
  });
});

describe('US-16.3 live sources are never stale and refreshed_at = response time', () => {
  it('pending_items / agent_status', () => {
    for (const fam of ['pending_items', 'agent_status']) {
      expect(liveFreshness(fam, NOW)).toEqual({ family: fam, refreshed_at: NOW, is_stale: false, live: true });
    }
  });
  it('no stale_reason key on a live source', () => {
    expect('stale_reason' in liveFreshness('pending_items', NOW)).toBe(false);
  });
});
