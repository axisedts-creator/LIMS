// C9 T-25 — S-01 / AB-06 (07-SECURITY §5; REQ-SEC-002/040/041; 02-TRD §5.0): tenant A with every quality permission (aal2) names an object id that RLS hides from A (= tenant B's object: the
// repository sees no row) on EVERY operation of quality.yaml that has an id in the path -> 404 common.not_found IDENTICAL to a missing id, the id is not echoed, nothing is written, no access-log row.
// DB-less half: real handlers + real IdentityPort + a tx under which every SELECT returns no rows (what RLS gives A for B's ids). The live half (real RLS, owner-side snapshot of B unchanged) is
// crossTenant.live.test.ts. Lists with B's ids as filters: 200 with an empty page, never B data.
// Fails now if: a handler answers anything but 404 for an invisible object, differs between "B's" and "missing" ids (existence oracle), writes before the load, or echoes the id.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPS, fire, loadManifest, makeHarness, requestFor, seen, uid, type OpInfo, type Row, type Who } from './kit.js';

let handlers: Record<string, (...a: any[]) => Promise<any>>;
beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
const ALL = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read', 'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];
const WRITE_SQL = /^\s*(insert|update|delete|merge|truncate)\b/i;

/** Path ids that name a tenant object (set_name / code are tenant-level coded-set keys, probed separately). */
const idParams = (o: OpInfo) => o.pathParams.filter((p) => p !== 'set_name' && p !== 'code');
const BY_ID = OPS.filter((o) => idParams(o).length > 0);

/** Bodies that name OTHER objects (levels of a plan version) or coded-set codes are resolved before the path object (02-TRD §5.3: unknown reference -> 400 common.validation_failed, S-04); the generic
 *  probe accepts that order for these two and still demands: no reply, no write, no access-log row. excludeQcObservation gets the strict 404 probe below with the coded set visible. */
const BODY_REFS_FIRST = new Set(['createQcPlanVersion', 'excludeQcObservation']);
const CODE_ROW = (text: string): Row[] | undefined => (/exclusion_reasons/.test(text) ? [{ code: 'wrong_material', display: 'Wrong control material', is_active: true, source: 'global' }] : undefined);

const go = async (op: OpInfo, ids: Record<string, string>, rows?: Who['rows']) => {
  const h = makeHarness({ permissions: ALL, aal: 'aal2', ...(rows ? { rows } : {}) }, op.id);
  const req = requestFor(op, { ids });
  const out = await fire(handlers[op.id]!, req, h.ctx);
  return { out, h, req };
};

describe('S-01 registry', () => {
  it('every operation is covered by exactly one of: id in the path, list, body/tenant-level (own probes below)', () => {
    const lists = OPS.filter((o) => o.isList && idParams(o).length === 0);
    const other = OPS.filter((o) => idParams(o).length === 0 && !o.isList);
    expect(BY_ID.length + lists.length + other.length).toBe(54);
    expect(BY_ID.length).toBeGreaterThanOrEqual(30);
  });
});

describe('S-01 an id RLS hides from tenant A: 404 common.not_found on every operation with an id in the path', () => {
  it.each(BY_ID.map((o) => [o.id, o] as const))('%s', async (_id, op) => {
    const foreign = Object.fromEntries(idParams(op).map((p) => [p, uid()]));
    const { out, h, req } = await go(op, foreign);
    expect(out.reply, `answered ${out.reply?.status}: B's object must be invisible to A`).toBeUndefined();
    if (BODY_REFS_FIRST.has(op.id)) expect(['common.not_found', 'common.validation_failed'], String(out.error?.code)).toContain(out.error?.code);
    else { expect(out.error?.code, String(out.error?.message)).toBe('common.not_found'); expect(out.error?.statusCode).toBe(404); }
    for (const v of Object.values(req.params)) expect(seen(out.error), 'the id is not echoed').not.toContain(String(v));
    expect(h.queries.filter((q) => WRITE_SQL.test(q.text)), 'no write before the object was loaded').toEqual([]);
    expect(h.audits, 'no access-log row for an object the caller cannot see').toEqual([]);
    for (const q of h.queries) expect(JSON.stringify(q.values), `every statement is tenant-bound: ${q.text.slice(0, 60)}`).toContain('01a1a98a-ac40-7000-8000-00000000a001');
  });

  it.each(BY_ID.map((o) => [o.id, o] as const))('%s: "B\'s id" and "an id that never existed" are indistinguishable (no existence oracle)', async (_id, op) => {
    const a = await go(op, Object.fromEntries(idParams(op).map((p) => [p, uid()])));
    const b = await go(op, Object.fromEntries(idParams(op).map((p) => [p, uid()])));
    expect([a.out.error?.code, a.out.error?.statusCode, a.out.error?.message]).toEqual([b.out.error?.code, b.out.error?.statusCode, b.out.error?.message]);
  });
});

describe('S-01 #27 excludeQcObservation with the exclusion-reason code visible: B\'s observation id -> 404 common.not_found, no write', () => {
  it('404 identical to a missing id', async () => {
    const op = OPS.find((o) => o.id === 'excludeQcObservation')!;
    const { out, h, req } = await go(op, { observation_id: uid() }, CODE_ROW);
    expect(out.reply).toBeUndefined();
    expect(out.error?.code, String(out.error?.message)).toBe('common.not_found');
    expect(out.error?.statusCode).toBe(404);
    expect(seen(out.error)).not.toContain(String(req.params['observation_id']));
    expect(h.queries.filter((q) => WRITE_SQL.test(q.text))).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe('S-01 lists: B\'s ids as filters give an empty page, never data and never an error that confirms the id', () => {
  const lists = OPS.filter((o) => o.isList);
  it.each(lists.map((o) => [o.id, o] as const))('%s', async (_id, op) => {
    const B = uid();
    const query = Object.fromEntries(((op.operation.parameters ?? []) as any[]).filter((p) => p.in === 'query').map((p) => p.name as string)
      .filter((n) => /_id$/.test(n)).map((n) => [n, B]));
    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op.id);
    const req = requestFor(op, { query });
    const out = await fire(handlers[op.id]!, req, h.ctx);
    if (out.reply) {
      expect(out.reply.status).toBe(200);
      const items = out.reply.body?.items ?? out.reply.body?.points ?? out.reply.body?.data;
      if (Array.isArray(items)) expect(items).toEqual([]);
      expect(JSON.stringify(out.reply.body)).not.toContain(B);
    } else {
      expect(['common.not_found', 'common.validation_failed'], String(out.error?.code)).toContain(out.error?.code);   // required query params the probe leaves out are a 400, never data
      expect(seen(out.error)).not.toContain(B);
    }
    expect(h.queries.filter((q) => WRITE_SQL.test(q.text))).toEqual([]);
  });
});

describe('S-01 tenant-level coded sets: an unknown code is 404 for A, never B\'s tenant code', () => {
  it('upsertQualityCode / listQualityCodedSet never write on behalf of a body tenant_id (the schema forbids it; the handler must not read it)', async () => {
    const op = OPS.find((o) => o.id === 'upsertQualityCode')!;
    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op.id);
    const B = uid();
    const out = await fire(handlers[op.id]!, requestFor(op, { body: { tenant_id: B, label_en: 'Synthetic', label_ne: 'Synthetic' } }), h.ctx);
    for (const q of h.queries) expect(JSON.stringify(q.values), 'tenant_id from the body never reaches SQL').not.toContain(B);
    expect(out.error ? seen(out.error) : JSON.stringify(out.reply?.body)).not.toContain(B);
  });
});
