'use server';
// Server actions for the SR-03/SR-04 client components. Ids and keys are re-checked here (actions are public endpoints); the API re-checks the permission.
// Only ApiError is mapped to { ok:false } (code + field errors); anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { FIXTURES, UUID_RE, type Issue, type Preview } from '../library';
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

export async function approveAction(id: string, version: number, note?: string) {
  if (!UUID_RE.test(id) || !ver(version) || (note !== undefined && (typeof note !== 'string' || note.length > 500))) return bad();
  return run(async () => { await api.approveVersion(id, version, { attestation: true, ...(note ? { note } : {}) }); return null; });
}

export async function returnAction(id: string, version: number, comment: string) {
  if (!UUID_RE.test(id) || !ver(version) || typeof comment !== 'string' || !comment.trim() || comment.length > 1000) return bad();
  return run(async () => { await api.returnVersion(id, version, { comment }); return null; });
}

const str = (x: unknown) => (typeof x === 'string' ? x : '');
const texts = (x: unknown, key: string) => (Array.isArray(x) ? x.slice(0, 200).map((i) => str(obj(i) ? i[key] : '')).filter(Boolean) : []);
const words = (s: unknown) => str(s).replace(/_/g, ' ');

/** #22. The order id travels in the body only; the result is cut down to what the dialog renders. */
export async function previewAction(id: string, source: { fixture_code: string } | { order_id: string }): Promise<ActionResult<Preview>> {
  if (!UUID_RE.test(id) || !obj(source)) return bad();
  const body = 'order_id' in source
    ? UUID_RE.test(String(source.order_id)) ? { order_id: String(source.order_id) } : undefined
    : (FIXTURES as readonly string[]).includes(String(source.fixture_code)) ? { fixture_code: String(source.fixture_code) } : undefined;
  if (!body) return bad();
  return run(async () => {
    const r = await api.previewVersion(id, body);
    const hs = obj(r['health_score']) ? r['health_score'] : undefined;
    return {
      ...(hs && typeof hs['value'] === 'number' ? { score: { value: hs['value'], band: words(hs['band']), ...(str(hs['explanation_text']) ? { explanation: str(hs['explanation_text']) } : {}) } } : {}),
      panels: Array.isArray(r['panels']) ? r['panels'].slice(0, 100).map((p) => ({ name: str(obj(p) ? p['display_name'] : ''), status: words(obj(p) ? p['status'] : '') })) : [],
      deranged: texts(r['deranged'], 'text'), advice: texts(r['advice'], 'text'), followUps: texts(r['follow_ups'], 'text'),
      ...(str(r['disclaimer_text']) ? { disclaimer: str(r['disclaimer_text']) } : {}),
    };
  });
}

const TERM_LANGS = ['en', 'ne', 'any'];
export async function addTermAction(body: { term: string; language: string; reason?: string }, key: string) {
  if (!KEY.test(key) || !obj(body) || typeof body.term !== 'string' || body.term.length < 2 || body.term.length > 60 || !TERM_LANGS.includes(body.language)) return bad();
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 200)) return bad();
  return run(async () => { await api.createTerm({ term: body.term, language: body.language, ...(body.reason ? { reason: body.reason } : {}) }, key); return null; });
}

export async function deactivateTermAction(id: string, version: number) {
  if (!UUID_RE.test(id) || !ver(version)) return bad();
  return run(async () => { await api.deactivateTerm(id, version); return null; });
}

export async function submitAction(id: string, version: number) {
  if (!UUID_RE.test(id) || !ver(version)) return bad();
  return run(async () => { await api.submitVersion(id, version); return null; });
}
