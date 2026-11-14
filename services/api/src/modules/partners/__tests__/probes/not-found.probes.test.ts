// C13 T22 — AB1 / AB3 / AB15, ST1-ST3 generic probe: a by-id read of an object that is not visible to the caller (another partner's, another tenant's, another centre's, or nothing at all)
// answers the SAME 404 common.not_found, with no write, no side effect, and an error that carries nothing of the id's owner. Row-level hiding is the DB's job (ST5, live DB: T24);
// this proves the handler layer maps "no visible row" to an indistinguishable 404 for every GET-by-id operation of partners.yaml (generated from the spec).
// The world is EMPTY except the caller's own partner-context row, so any handler that answers 200 / 403 / 500 for an unseen id fails.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { ALL, BY_PATH_ID, ids, minimal, NO_PATH_ID, recCtx, reqFor, settle, UNOWNED_STUBS } from './kit.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const BY_ID = ALL.filter((o) => o.method === 'GET' && /\{[a-z_]+_id\}/.test(o.path) && !o.path.endsWith('/users') && o.operationId !== 'listPartnerUsersForPartner');
const OTHER = '01940e00-0000-7000-8000-c13220000f99';
const reportPort = { ReportingPort: { async openReleasedReportFile() { throw new LimsError('common.not_found'); } } };

const outcome = async (opId: string, id: string) => {
  const o = ALL.find((x) => x.operationId === opId)!;
  const k = recCtx(o.staff ? 'user' : 'partner', { activePartner: true, portal: reportPort as any });
  const req = reqFor(o);
  for (const key of Object.keys(req.params)) if (/_id$/.test(key)) req.params[key] = id;
  const r = await settle(H[opId]!(req, k.ctx));
  return { r, k };
};

// ---- review item 2: the same empty-world probe for EVERY operation whose path carries an *_id (any method), and for ids carried in the body.
const IDEM = { 'idempotency-key': 'synthetic-probe-key-0001', 'if-match': '"1"' }; // If-Match is checked before the row lookup (428 otherwise), so send a well-formed one
// the spec's own synthetic request example is the most valid body there is (coded sets, window ordering); the schema-minimal body is the fallback
const bodyFor = (o: (typeof ALL)[number]) => {
  const c = o.op.requestBody?.content?.['application/json'];
  const b = structuredClone(c?.examples?.synthetic?.value ?? (c?.schema ? minimal(c.schema) : undefined));
  for (const [s, e] of [['scheduled_start', 'scheduled_end'], ['window_start', 'window_end']] as const) // the spec example has start == end; a window needs end > start
    if (b && typeof b === 'object' && b[s] && b[e] && b[s] === b[e]) b[e] = new Date(Date.parse(b[s]) + 3_600_000).toISOString();
  if (b && typeof b === 'object' && 'email' in b) b.email = 'synthetic.probe@example.test'; // the spec example holds the placeholder "<synthetic-email>"
  return b;
};
const mutOutcome = async (opId: string, id: string) => {
  const o = ALL.find((x) => x.operationId === opId)!;
  const k = recCtx(o.staff ? 'user' : 'partner', { activePartner: true, portal: reportPort as any });
  const req: any = reqFor(o, { headers: IDEM, body: bodyFor(o) });
  for (const key of Object.keys(req.params)) if (/_id$/.test(key)) req.params[key] = id;
  return { r: await settle(H[opId]!(req, k.ctx)), k };
};
const MUTATIONS = BY_PATH_ID.filter((o) => o.method !== 'GET' && !UNOWNED_STUBS.includes(o.operationId));

describe('ST1/ST2/ST3 generator guard: every operation with an *_id path param is probed', () => {
  it('GET-by-id + mutations together equal BY_PATH_ID (minus stubs and the two list-under-id reads)', () => {
    const probed = new Set([...BY_ID, ...MUTATIONS].map((o) => o.operationId));
    const missing = BY_PATH_ID.filter((o) => !probed.has(o.operationId) && !UNOWNED_STUBS.includes(o.operationId)).map((o) => o.operationId);
    expect(missing.sort()).toEqual(['listPartnerUsersForPartner']); // GET list scoped by an id; answers an empty list for an unseen partner by design (checked below)
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(25);
  });
});

describe.each(MUTATIONS.map((o) => [o.operationId, o.method] as const))('%s (%s with an unseen path id)', (opId) => {
  it('-> 404 common.not_found, no write, no enqueue_job, no audit "allowed" row', async () => {
    const { r, k } = await mutOutcome(opId, OTHER);
    expect(r.ok, `${opId} resolved: ${JSON.stringify((r as any).value)}`).toBe(false);
    if (!r.ok) { expect(r.error.code, String(r.error.message)).toBe('common.not_found'); expect(r.error.statusCode).toBe(404); }
    expect(k.writes()).toEqual([]);
    expect(k.audit.filter((e) => e.outcome === 'allowed')).toEqual([]);
  });
});

describe('ids in the body (AB3 / AB4)', () => {
  it('createPickupRequest with a manifest id nobody owns -> an error, no write, no enqueue_job, and the id is not echoed (AB3)', async () => {
    const o = ALL.find((x) => x.operationId === 'createPickupRequest')!;
    const k = recCtx('partner', { activePartner: true });
    // window inside the allowed range relative to recCtx's pinned now (2026-11-14T06:00Z), so the handler reaches the manifest lookup instead of failing window validation first
    const body = { ...bodyFor(o), manifest_ids: [OTHER], window_start: '2026-11-14T08:00:00.000Z', window_end: '2026-11-14T09:00:00.000Z' };
    const r = await settle(H.createPickupRequest!(reqFor(o, { headers: IDEM, body }), k.ctx));
    expect(r.ok, 'resolved for a foreign manifest id').toBe(false);
    if (!r.ok) {
      expect(r.error.code, String(r.error.message)).toBe('common.not_found');
      expect(r.error.statusCode).toBe(404);
      expect(JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(r.error).map((n) => [n, r.error[n]])))).not.toContain(OTHER);
    }
    expect(k.sql.some((s) => s.values.some((v) => JSON.stringify(v).includes(OTHER))), 'the manifest lookup ran with the foreign id').toBe(true);
    expect(k.writes()).toEqual([]);
  });

  it('markPartnerReportsSeen with an unseen report id -> no error, nothing written as seen (count 0), the id is not revealed (AB4)', async () => {
    const o = ALL.find((x) => x.operationId === 'markPartnerReportsSeen')!;
    const k = recCtx('partner', { activePartner: true });
    const r = await settle(H.markPartnerReportsSeen!(reqFor(o, { body: { report_versions: [{ report_id: OTHER, version_no: 1 }] } }), k.ctx));
    expect(r.ok, `rejected: ${(r as any).error?.code}`).toBe(true);
    if (r.ok) expect(JSON.stringify(r.value)).toMatch(/"(marked|seen|updated|count)[a-z_]*":0/);
    expect(JSON.stringify((r as any).value ?? {})).not.toContain(OTHER);
  });
});

// ---- ST2: operations with no id at all (list / context / dashboard / create): in an empty world they answer an empty result, and every statement after the context lookup binds the caller's partner (never a request value).
describe.each(NO_PATH_ID.map((o) => [o.operationId] as const))('ST1/ST2 scope of %s', (opId) => {
  it('a foreign partner_id / tenant_id sent in query or header reaches no SQL value (body smuggling is the closed-schema check in contract-probes; the scope is the token membership, never a request value)', async () => {
    const o = ALL.find((x) => x.operationId === opId)!;
    const k = recCtx(o.staff ? 'user' : 'partner', { activePartner: true });
    const body = bodyFor(o);
    // a staff list may legitimately filter by partner_id (a filter, not a scope), so staff probes send only the foreign tenant_id
    const query = o.staff ? { tenant_id: OTHER } : { partner_id: OTHER, tenant_id: OTHER };
    await settle(H[opId]!(reqFor(o, { query, headers: { ...IDEM, 'x-partner-id': OTHER, 'x-tenant-id': OTHER }, body }), k.ctx));
    for (const s of k.sql) expect(JSON.stringify(s.values), s.text.slice(0, 80)).not.toContain(OTHER);
  });
});

describe('generator guard', () => {
  it('covers the by-id reads of manifests, orders, pickups, slips, reports, partners', () => {
    expect(BY_ID.map((o) => o.operationId).sort()).toEqual(expect.arrayContaining(['downloadPartnerReport', 'downloadPatientAccessSlip', 'getInboundManifest', 'getManifest', 'getManifestPrintView',
      'getPartner', 'getPartnerOrder', 'getPatientAccessSlip', 'getPickupRequest']));
  });
});

describe.each(BY_ID.map((o) => [o.operationId] as const))('%s', (opId) => {
  it('unseen id -> 404 common.not_found, no write, no job, no audit "allowed" row', async () => {
    const { r, k } = await outcome(opId, OTHER);
    expect(r.ok, `${opId} resolved: ${JSON.stringify((r as any).value)}`).toBe(false);
    if (!r.ok) { expect(r.error.code, String(r.error.message)).toBe('common.not_found'); expect(r.error.statusCode).toBe(404); }
    expect(k.writes()).toEqual([]);
    expect(k.audit.filter((e) => e.outcome === 'allowed')).toEqual([]);
  });

  it('indistinguishable: two different unseen ids give the identical error (code, status, message), and the id is never echoed', async () => {
    const a = await outcome(opId, OTHER); const b = await outcome(opId, ids.actor);
    expect(a.r.ok || b.r.ok).toBe(false);
    if (!a.r.ok && !b.r.ok) {
      expect([a.r.error.code, a.r.error.statusCode, a.r.error.message]).toEqual([b.r.error.code, b.r.error.statusCode, b.r.error.message]);
      const blob = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(a.r.error).map((n) => [n, a.r.error[n]])));
      expect(blob).not.toContain(OTHER);
    }
  });
});
