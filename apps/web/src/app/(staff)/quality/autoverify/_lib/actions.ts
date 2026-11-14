'use server';
// C9 T-23 server actions: every mutation of the auto-verification screens plus the decision-detail read. The JWT stays on the server (REQ-SEC-068);
// every input is re-validated here because a server action is a public endpoint. Only ApiError becomes { ok:false, status, code }; anything else rethrows.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { DECIMAL, RULE_KEY, UUID } from './format';
import { BASE } from './server';
import type { ActionResult, Decision, Definition, FieldError, Rule, Version } from './types';

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const invalid = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });

async function call<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = (e.problem as { errors?: unknown }).errors;
    const errors: FieldError[] = Array.isArray(raw)
      ? raw.flatMap((x: { path?: unknown; message?: unknown }) => (typeof x?.path === 'string' && typeof x?.message === 'string' ? [{ path: x.path.slice(0, 200), message: x.message.slice(0, 300) }] : []))
      : [];
    return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
  }
}

const okVersion = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const send = <T>(method: 'POST' | 'PUT', path: string, body: unknown, version: number | undefined, key: string | undefined) =>
  serverFetch<T>(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify(body),
  });

/** #37 createAutoverifyVersion: exactly one of copy_from_version_id / an empty definition. */
export async function createVersionAction(copyFrom: string | null, key: string): Promise<ActionResult<Version>> {
  if (!KEY.test(String(key)) || (copyFrom !== null && !UUID.test(String(copyFrom)))) return invalid();
  const body = copyFrom ? { copy_from_version_id: copyFrom } : { definition: { schema_version: 1, rules: [] } };
  return call(() => send<Version>('POST', '/versions', body, undefined, key));
}

const uniq = <T,>(a: T[]) => new Set(a).size === a.length;
/** Rebuilds a rule from its known fields only (no extra keys reach the API); undefined = not a valid rule shape. */
function cleanRule(r: unknown): Rule | undefined {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const key = str(x['key']);
  const testId = str(x['test_id']);
  const analyteId = str(x['analyte_id']);
  const instrumentId = x['instrument_id'] === undefined ? undefined : str(x['instrument_id']);
  if (!key || !RULE_KEY.test(key) || !testId || !UUID.test(testId) || !analyteId || !UUID.test(analyteId) || typeof x['enabled'] !== 'boolean') return undefined;
  if (x['instrument_id'] !== undefined && (!instrumentId || !UUID.test(instrumentId))) return undefined;
  const out: Rule = { key, test_id: testId, analyte_id: analyteId, ...(instrumentId ? { instrument_id: instrumentId } : {}), enabled: x['enabled'] };
  if (x['limits'] !== undefined) {
    const l = x['limits'] as Record<string, unknown> | null;
    const low = l?.['low'];
    const high = l?.['high'];
    if (!l || typeof l !== 'object' || (low === undefined && high === undefined)) return undefined;
    if ((low !== undefined && !(typeof low === 'string' && DECIMAL.test(low) && low.length <= 40)) || (high !== undefined && !(typeof high === 'string' && DECIMAL.test(high) && high.length <= 40))) return undefined;
    out.limits = { ...(low !== undefined ? { low: low as string } : {}), ...(high !== undefined ? { high: high as string } : {}) };
  }
  if (x['allowed_range_flags'] !== undefined) {
    const f = x['allowed_range_flags'];
    if (!Array.isArray(f) || f.length < 1 || f.length > 3 || !uniq(f) || !f.every((v) => v === 'N' || v === 'L' || v === 'H')) return undefined;
    out.allowed_range_flags = f as NonNullable<Rule['allowed_range_flags']>;
  }
  if (x['instrument_flags_allowed'] !== undefined) {
    const f = x['instrument_flags_allowed'];
    if (!Array.isArray(f) || f.length > 20 || !f.every((v) => typeof v === 'string' && v.length >= 1 && v.length <= 16)) return undefined;
    out.instrument_flags_allowed = f as string[];
  }
  if (x['qc_allow_warning'] !== undefined) {
    if (typeof x['qc_allow_warning'] !== 'boolean') return undefined;
    out.qc_allow_warning = x['qc_allow_warning'];
  }
  if (x['note'] !== undefined) {
    const n = str(x['note']);
    if (n === undefined || n.length > 200) return undefined;
    out.note = n;
  }
  return out;
}

/** #39 replaceAutoverifyDraft: the WHOLE definition, If-Match = the version the editor loaded. */
export async function saveDraftAction(versionId: string, version: number, definition: Definition): Promise<ActionResult<Version>> {
  const rules = Array.isArray(definition?.rules) ? definition.rules.map(cleanRule) : undefined;
  if (!UUID.test(String(versionId)) || !okVersion(version) || definition?.schema_version !== 1 || !rules || rules.length > 2000 || rules.some((r) => !r)) return invalid();
  return call(() => send<Version>('PUT', `/versions/${versionId}`, { definition: { schema_version: 1, rules } }, version, undefined));
}

const STEP = { start: 'start-simulation', stop: 'stop-simulation', discard: 'discard' } as const;
/** #40 start-simulation, #41 stop-simulation, #45 discard. */
export async function transitionAction(step: keyof typeof STEP, versionId: string, version: number, key: string): Promise<ActionResult<Version>> {
  if (!Object.hasOwn(STEP, String(step)) || !UUID.test(String(versionId)) || !okVersion(version) || !KEY.test(String(key))) return invalid();
  return call(() => send<Version>('POST', `/versions/${versionId}/${STEP[step]}`, {}, version, key));
}

/** #43 activate: the confirmation text must be exactly ACTIVATE (the API checks it again). */
export async function activateAction(versionId: string, version: number, confirmationText: string, key: string): Promise<ActionResult<Version>> {
  if (confirmationText !== 'ACTIVATE' || !UUID.test(String(versionId)) || !okVersion(version) || !KEY.test(String(key))) return invalid();
  return call(() => send<Version>('POST', `/versions/${versionId}/activate`, { confirmation_text: 'ACTIVATE' }, version, key));
}

/** #44 retire: reason 1..500 after trimming. */
export async function retireAction(versionId: string, version: number, reason: string, key: string): Promise<ActionResult<Version>> {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 1 || r.length > 500 || !UUID.test(String(versionId)) || !okVersion(version) || !KEY.test(String(key))) return invalid();
  return call(() => send<Version>('POST', `/versions/${versionId}/retire`, { reason: r }, version, key));
}

/** #47 getAutoverifyDecision: the access-log entry autoverify_decision.view is written by the API when this is called, so it runs only when a drawer opens. */
export async function readDecisionAction(decisionId: string): Promise<ActionResult<Decision>> {
  if (!UUID.test(String(decisionId))) return invalid();
  return call(() => serverFetch<Decision>(`${BASE}/decisions/${decisionId}`));
}
