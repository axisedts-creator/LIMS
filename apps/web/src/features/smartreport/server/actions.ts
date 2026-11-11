'use server';
// Server actions for the SR-03/SR-04 client components. Ids and keys are re-checked here (actions are public endpoints); the API re-checks the permission.
// Only ApiError is mapped to { ok:false } (code + field errors); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { UUID_RE, type Issue } from '../library';
import * as api from './library.server';

export interface FieldError { path: string; message: string }
export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldError[] };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[a-z][a-z0-9_]{0,99}$/;
const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const ver = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
const obj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as unknown[]) : [];
    const errors = raw.slice(0, 20).flatMap((x) => {
      const o = obj(x) ? x : {};
      const path = typeof o['path'] === 'string' ? o['path'] : '';
      const message = typeof o['detail'] === 'string' ? o['detail'] : typeof o['message'] === 'string' ? o['message'] : typeof o['code'] === 'string' ? o['code'] : '';
      return path && message ? [{ path, message: message.slice(0, 200) }] : [];
    });
    return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
  }
}

export async function createVersionAction(body: { source: string; source_version_id?: string }, key: string) {
  if (!KEY.test(key) || !['clone_active', 'starter', 'clone_version'].includes(body?.source)) return bad();
  if (body.source === 'clone_version' && !UUID_RE.test(body.source_version_id ?? '')) return bad();
  const b = body.source === 'clone_version' ? { source: body.source, source_version_id: body.source_version_id } : { source: body.source };
  return run(async () => ({ id: (await api.createVersion(b, key)).id }));
}

export async function patchVersionAction(id: string, version: number, body: Record<string, unknown>) {
  if (!UUID_RE.test(id) || !ver(version) || !obj(body)) return bad();
  return run(async () => ({ version: (await api.patchVersion(id, version, body)).version }));
}

export async function saveBlockAction(id: string, body: Record<string, unknown>, target: { blockId: string; version: number } | { key: string }) {
  if (!UUID_RE.test(id) || !obj(body)) return bad();
  if ('key' in target) return KEY.test(target.key) ? run(async () => ({ id: (await api.createBlock(id, body, target.key)).id })) : bad();
  if (!UUID_RE.test(target.blockId) || !ver(target.version)) return bad();
  return run(async () => ({ id: (await api.replaceBlock(id, target.blockId, target.version, body)).id }));
}

export async function saveRuleAction(id: string, body: Record<string, unknown>, target: { ruleId: string; version: number } | { key: string }) {
  if (!UUID_RE.test(id) || !obj(body)) return bad();
  if ('key' in target) return KEY.test(target.key) ? run(async () => ({ id: (await api.createRule(id, body, target.key)).id })) : bad();
  if (!UUID_RE.test(target.ruleId) || !ver(target.version)) return bad();
  return run(async () => ({ id: (await api.replaceRule(id, target.ruleId, target.version, body)).id }));
}

export async function removeAction(id: string, what: 'block' | 'rule' | 'mapping', childId: string, version: number) {
  if (!UUID_RE.test(id) || !UUID_RE.test(childId) || !ver(version)) return bad();
  const fn = what === 'block' ? api.deleteBlock : what === 'rule' ? api.deleteRule : what === 'mapping' ? api.deleteMapping : undefined;
  if (!fn) return bad();
  return run(async () => { await fn(id, childId, version); return null; });
}

export async function putMappingAction(id: string, analyteId: string, version: number, body: Record<string, unknown>) {
  if (!UUID_RE.test(id) || !UUID_RE.test(analyteId) || !ver(version) || !obj(body)) return bad();
  return run(async () => ({ version: (await api.putMapping(id, analyteId, version, body)).version }));
}

export async function putGroupAction(id: string, code: string, version: number, body: Record<string, unknown>) {
  if (!UUID_RE.test(id) || !CODE.test(code) || !ver(version) || !obj(body)) return bad();
  return run(async () => ({ version: (await api.putGroup(id, code, version, body)).version }));
}

export async function validateAction(id: string): Promise<ActionResult<Issue[]>> {
  if (!UUID_RE.test(id)) return bad();
  return run(async () => {
    const r = await api.validateVersion(id);
    return (Array.isArray(r?.issues) ? r.issues : []).slice(0, 500).map((i) => ({
      code: String(i.code), severity: String(i.severity),
      ...(typeof i.detail === 'string' ? { detail: i.detail } : {}), ...(typeof i.block_key === 'string' ? { block_key: i.block_key } : {}),
      ...(typeof i.rule_id === 'string' ? { rule_id: i.rule_id } : {}), ...(typeof i.path === 'string' ? { path: i.path } : {}),
    }));
  });
}

export async function submitAction(id: string, version: number) {
  if (!UUID_RE.test(id) || !ver(version)) return bad();
  return run(async () => { await api.submitVersion(id, version); return null; });
}
