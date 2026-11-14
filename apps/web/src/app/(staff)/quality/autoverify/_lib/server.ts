import 'server-only';
// C9 T-23 reads (BFF). Permission is checked BEFORE any API call; only whitelisted, well-formed search params reach the API (07-SECURITY);
// the Bearer token comes from the session inside serverFetch and never leaves the server (REQ-SEC-068).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { DAY, ISO_UTC, PERIOD_MAX_DAYS, REASONS, UUID, isoMs, nptDayStart } from './format';
import type { Decision, Report, RuleSet, Settings, Version } from './types';

export const READ = 'quality.autoverify.read';
export const MANAGE = 'quality.autoverify.manage';
export const BASE = '/v1/quality/autoverify';

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const oneOf = (v: string | undefined, allowed: readonly string[]) => (v !== undefined && allowed.includes(v) ? v : undefined);
const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export type Gate = 'denied' | 'disabled';
export const isFeatureDisabled = (e: unknown) => e instanceof ApiError && e.problem.code === 'common.feature_disabled';
export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

export async function permissions(): Promise<readonly string[]> {
  return (await getShellSession())?.actor.permissions ?? [];
}

/** Runs `load` only when the session holds `quality.autoverify.read`. A switched-off module is a normal state; anything else rethrows to error.tsx. */
export async function gated<T>(load: (perms: readonly string[]) => Promise<T>): Promise<{ gate: Gate } | { perms: readonly string[]; data: T }> {
  const perms = await permissions();
  if (!perms.includes(READ)) return { gate: 'denied' };
  try {
    return { perms, data: await load(perms) };
  } catch (e) {
    if (isFeatureDisabled(e)) return { gate: 'disabled' };
    throw e;
  }
}

/** #36. 404 common.not_found = this lab has no rule set yet (a normal state). */
export const getRuleSet = () => serverFetch<RuleSet>(`${BASE}/rule-set`).catch((e: unknown) => (isNotFound(e) ? null : Promise.reject(e)));
/** #51 needs quality.qc_run.read, which an auto-verification reader may lack: a failed read yields undefined and the screens say less instead of guessing. */
export const getSettings = () => serverFetch<Settings>('/v1/quality/settings').catch(() => undefined);
export const getVersion = (id: string) => serverFetch<Version>(`${BASE}/versions/${id}`);
/** #42. Opening the report writes the access-log entry server side; a failure only degrades the report section. */
export const getReport = (id: string) => serverFetch<Report>(`${BASE}/versions/${id}/simulation-report?sample_limit=50`).catch(() => undefined);

// ---------------------------------------------------------------- decisions (#46)
export interface DecisionsQuery {
  /** undefined = the period is not acceptable, no request is made. */
  query?: URLSearchParams;
  problem?: string;
  from: string;
  to: string;
  /** The sanitized URL state the client keeps. */
  clean: Record<string, string>;
}

export function decisionsQuery(sp: SP): DecisionsQuery {
  const a = first(sp['decided_at_from']);
  const b = first(sp['decided_at_to']);
  const valid = !!a && !!b && ISO_UTC.test(a) && ISO_UTC.test(b) && !Number.isNaN(Date.parse(a)) && !Number.isNaN(Date.parse(b));
  const start = nptDayStart(Date.now());
  const from = valid ? a : isoMs(start);
  const to = valid ? b : isoMs(start + DAY);
  const clean: Record<string, string> = { decided_at_from: from, decided_at_to: to };
  const put = (k: string, v: string | undefined) => { if (v !== undefined) clean[k] = v; };
  put('mode', oneOf(first(sp['mode']), ['live', 'shadow']));
  put('decision', oneOf(first(sp['decision']), ['allow', 'deny']));
  put('reason', oneOf(first(sp['reason']), REASONS));
  put('analyte_id', uuid(first(sp['analyte_id'])));
  put('instrument_id', uuid(first(sp['instrument_id'])));
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) return { problem: 'The end of the period is before its start. Choose a later end.', from, to, clean };
  if (span > PERIOD_MAX_DAYS * DAY) return { problem: `Choose a period of ${PERIOD_MAX_DAYS} days or less.`, from, to, clean };
  const q = new URLSearchParams(clean);
  const cursor = first(sp['cursor']);
  if (cursor && CURSOR.test(cursor)) q.set('cursor', cursor);
  q.set('sort', '-decided_at');
  q.set('limit', '50');
  return { query: q, from, to, clean };
}

export async function getDecisions(q: URLSearchParams) {
  const r = await serverFetch<{ data: Decision[]; page?: { next_cursor?: string } }>(`${BASE}/decisions?${q.toString()}`);
  return { rows: Array.isArray(r?.data) ? r.data : [], ...(r?.page?.next_cursor ? { next: r.page.next_cursor } : {}) };
}
