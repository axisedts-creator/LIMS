'use server';
// C9 T-24 server actions: save settings (#52, PUT + If-Match "<version>") and one tenant code (#54). The JWT stays on the server (REQ-SEC-068);
// a server action is a public endpoint, so permission and every input are re-checked here. Only ApiError becomes { ok:false, status, code }.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { permissions } from '../server/quality.server';
import type { ActionResult } from '../types';
import { MANAGE_CONFIG, NUM_KEYS, codeValid, isCodedSet, settingsValid, type CodeInput, type SettingsBody } from './validate';

const fail = (status: number, code: string): ActionResult<never> => ({ ok: false, status, code });
const invalid = () => fail(400, 'common.validation_failed');

async function put(path: string, headers: Record<string, string>, body: unknown): Promise<ActionResult<unknown>> {
  if (!(await permissions()).includes(MANAGE_CONFIG)) return fail(403, 'auth.forbidden');
  try {
    return { ok: true, data: await serverFetch(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.problem.code);
    throw e;
  }
}

export async function saveSettingsAction(version: number, body: SettingsBody): Promise<ActionResult<unknown>> {
  if (!Number.isInteger(version) || version < 0 || !settingsValid(body)) return invalid();
  // only the nine mutable keys are forwarded, whatever the client sent
  const clean = { tat_alerts_enabled: body.tat_alerts_enabled, ...Object.fromEntries(NUM_KEYS.map((k) => [k, body[k]])), default_plan_params: body.default_plan_params };
  return put('/v1/quality/settings', { 'if-match': `"${version}"` }, clean);
}

/** The set name is whitelisted; the code is data (a row of the loaded set) and goes into the path percent-encoded, so it can never add path segments. */
export async function saveCodeAction(set: string, code: string, input: CodeInput): Promise<ActionResult<unknown>> {
  if (!isCodedSet(set) || typeof code !== 'string' || code.length < 1 || code.length > 100 || !codeValid(input)) return invalid();
  return put(`/v1/quality/coded-sets/${set}/codes/${encodeURIComponent(code)}`, {}, { display: input.display.trim(), sort_order: input.sort_order, is_active: input.is_active });
}
