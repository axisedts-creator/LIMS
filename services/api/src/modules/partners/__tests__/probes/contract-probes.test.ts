// C13 T22 — contract-level security probes generated from contracts/openapi/partners.yaml (07-SECURITY §4 AB2, AB7, AB11, AB12, AB16; §6 ST4/ST8/ST10/ST12; US-15.1, US-15.2, US-15.3).
// These are static: they fail the moment a schema grows a field a partner must never be able to send (or a response a secret), for ANY operation, present or future.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { ALL, BY_PATH_ID, NO_PATH_ID, PARTNER_OPS, SPEC, STAFF_OPS, UNOWNED_STUBS } from './kit.js';

const COMMON: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', '_common.yaml'));
const deref = (n: any): any => {
  const ref: string | undefined = n?.$ref;
  if (!ref) return n;
  const [file, ptr] = ref.split('#');
  const root = file ? COMMON : SPEC;
  return deref(ptr!.slice(1).split('/').filter(Boolean).reduce((a: any, k) => a?.[k], root));
};
/** every property name (and the schema object it sits on) reachable from a schema */
function walk(n: any, out: Array<{ name: string; schema: any }> = [], objs: any[] = [], seen = new Set<any>(), d = 0): { props: typeof out; objects: any[] } {
  n = deref(n);
  if (!n || typeof n !== 'object' || seen.has(n) || d > 12) return { props: out, objects: objs };
  seen.add(n);
  if (n.type === 'object' || n.properties) objs.push(n);
  for (const [k, v] of Object.entries<any>(n.properties ?? {})) { out.push({ name: k, schema: v }); walk(v, out, objs, seen, d + 1); }
  if (n.items) walk(n.items, out, objs, seen, d + 1);
  if (n.additionalProperties && typeof n.additionalProperties === 'object') walk(n.additionalProperties, out, objs, seen, d + 1);
  for (const k of ['allOf', 'oneOf', 'anyOf']) for (const m of n[k] ?? []) walk(m, out, objs, seen, d + 1);
  return { props: out, objects: objs };
}
const bodyOf = (o: any) => o.requestBody?.content?.['application/json']?.schema;
const paramsOf = (o: any): any[] => (o.parameters ?? []).map(deref);

/** AB2 / AB11 / AB12: a partner may never send these (the server sets or derives them). */
// (registration_no is the LAB registration number of a line, set at conversion; the referrer's medical-council registration_no is a legitimate partner input, so it is checked per operation below)
const NEVER_FROM_PARTNER = ['partner_id', 'tenant_id', 'state', 'status', 'order_id', 'converted_at', 'failure_code', 'sample_received_at', 'received_by', 'received_at',
  'in_transit_at', 'scheduled_start', 'scheduled_end', 'assignee_text', 'picked_up_at', 'created_by', 'updated_by', 'submitted_by', 'submitted_at', 'version', 'receiving_centre_id', 'membership_id'];

describe('AB2 / US-15.1: partner-facing request contracts', () => {
  const withBody = PARTNER_OPS.filter((o) => bodyOf(o.op));
  it('there are partner-facing operations with a JSON body to check', () => expect(withBody.length).toBeGreaterThanOrEqual(12));

  it.each(withBody.map((o) => [o.operationId, o] as const))('%s: no server-owned field in the body (partner_id, tenant_id, state, order_id, receipt / pickup facts, audit columns ...)', (_n, o) => {
    const names = walk(bodyOf(o.op)).props.map((p) => p.name);
    expect(names.filter((n) => NEVER_FROM_PARTNER.includes(n))).toEqual([]);
  });

  it('the lab registration_no is never accepted on a manifest / line / pickup body (only the referrer council number is)', () => {
    const bad = withBody.filter((o) => /\/(manifests|pickup-requests)/.test(o.path) && walk(bodyOf(o.op)).props.some((p) => p.name === 'registration_no')).map((o) => o.operationId);
    expect(bad).toEqual([]);
  });

  it.each(withBody.map((o) => [o.operationId, o] as const))('%s: every object in the body is closed (additionalProperties: false) so an unknown field is 400 common.validation_failed', (_n, o) => {
    const open = walk(bodyOf(o.op)).objects.filter((s) => s.additionalProperties !== false && !s.allOf && !s.oneOf && !s.anyOf);
    expect(open.length, 'open object schemas').toBe(0);
  });

  it('no partner-facing operation takes partner_id / tenant_id in path, query or header (the partner is the token membership, never a request value)', () => {
    const bad = PARTNER_OPS.flatMap((o) => paramsOf(o.op).filter((p) => /^(partner_id|tenant_id|partner|tenant)$/i.test(p.name ?? '') || /^x-(partner|tenant)/i.test(p.name ?? '')).map((p) => `${o.operationId}:${p.in}:${p.name}`));
    const inPath = PARTNER_OPS.filter((o) => /\{(partner_id|tenant_id)\}/.test(o.path)).map((o) => o.operationId);
    expect([...bad, ...inPath]).toEqual([]);
  });

  it('AB7: the invite / change-role bodies take partner_role as an enum of exactly partner_admin | partner_member (no staff-like role code)', () => {
    for (const id of ['invitePartnerUser', 'changePartnerUserRole', 'invitePartnerUserByStaff', 'changePartnerUserRoleByStaff']) {
      const o = ALL.find((x) => x.operationId === id)!;
      const role = walk(bodyOf(o.op)).props.find((p) => p.name === 'partner_role');
      expect(role, id).toBeTruthy();
      expect([...(deref(role!.schema).enum ?? [])].sort(), id).toEqual(['partner_admin', 'partner_member']);
    }
  });

  it('staff bodies are closed as well (a staff client cannot smuggle a column either)', () => {
    const open = STAFF_OPS.filter((o) => bodyOf(o.op)).filter((o) => walk(bodyOf(o.op)).objects.some((s) => s.additionalProperties !== false && !s.allOf && !s.oneOf && !s.anyOf)).map((o) => o.operationId);
    expect(open).toEqual([]);
  });
});

describe('AB16 / US-07.8 / REQ-SEC-098: no patient search term in any URL', () => {
  const FORBIDDEN_QUERY = /^(patient|patient_name|full_name|name|phone|phone_e164|dob|birth_on|registration_no|partner_sample_ref|sample_ref|manifest_no|clinical_note|email)$/i;
  // free-text `q` exists only where the searched thing is not a patient: price list / orderable catalogue, the partner's own referrer (doctor) list, the staff partner list.
  const Q_ALLOWED = ['listPartnerPriceList', 'searchPartnerOrderables', 'listPartnerReferrers', 'listPartners'];

  it('no operation has a query parameter that can carry patient-identifying data', () => {
    const bad = ALL.flatMap((o) => paramsOf(o.op).filter((p) => p.in === 'query' && FORBIDDEN_QUERY.test(p.name)).map((p) => `${o.operationId}:${p.name}`));
    expect(bad).toEqual([]);
  });

  it('free-text q appears only on the catalogue / referrer / partner lists; order and report search is POST with q in the body', () => {
    const withQ = ALL.filter((o) => paramsOf(o.op).some((p) => p.in === 'query' && p.name === 'q')).map((o) => o.operationId).sort();
    expect(withQ).toEqual([...Q_ALLOWED].sort());
    const search = ALL.find((o) => o.operationId === 'searchPartnerOrders')!;
    expect(search.method).toBe('POST');
    expect(walk(bodyOf(search.op)).props.map((p) => p.name)).toContain('q');
  });
});

describe('ST12 / US-09.x: no URL or token in any response contract; only the slip PDF stream carries the link (inside the file)', () => {
  const SECRETISH = /(^|_)(url|uri|token|secret|signed|link|href|jwt|password)($|_)/i;
  const responseSchemas = (o: any) => Object.values<any>(o.responses ?? {}).flatMap((r) => Object.values<any>(deref(r)?.content ?? {}).map((c: any) => c.schema)).filter(Boolean);

  it('response schemas of every operation have no property named like a url / token / secret / link (link_expires_at is the one allowed name)', () => {
    const bad = ALL.flatMap((o) => responseSchemas(o.op).flatMap((s) => walk(s).props.map((p) => p.name)).filter((n) => SECRETISH.test(n) && n !== 'link_expires_at').map((n) => `${o.operationId}:${n}`));
    expect(bad).toEqual([]);
  });

  it('request bodies take no url / token either (the BFF never forwards one)', () => {
    const bad = ALL.filter((o) => bodyOf(o.op)).flatMap((o) => walk(bodyOf(o.op)).props.map((p) => p.name).filter((n) => SECRETISH.test(n)).map((n) => `${o.operationId}:${n}`));
    expect(bad).toEqual([]);
  });

  it('the three file operations answer a binary stream (application/pdf), never JSON carrying a location', () => {
    for (const id of ['downloadPartnerReport', 'downloadPatientAccessSlip']) {
      const o = ALL.find((x) => x.operationId === id)!;
      const ok = deref(o.op.responses?.['200']);
      expect(Object.keys(ok?.content ?? {}), id).toEqual(['application/pdf']);
    }
  });
});

describe('ST10: every mutation that must be idempotent declares the Idempotency-Key header', () => {
  it.each(ALL.filter((o) => o.op['x-idempotency'] === 'required').map((o) => [o.operationId, o] as const))('%s', (_n, o) => {
    const hasHeader = paramsOf(o.op).some((p) => p.in === 'header' && /^idempotency-key$/i.test(p.name ?? ''));
    expect(hasHeader).toBe(true);
    expect(o.method).toBe('POST');
  });
});

describe('ST8 / ST4: privileged partner-user management is its own permission, not shared with reads', () => {
  it('every /users write operation requires partners.partner_user.manage; no other partner-facing operation uses that code', () => {
    const users = PARTNER_OPS.filter((o) => o.path.startsWith('/v1/partners/users'));
    expect(users.length).toBe(6);
    expect(users.every((o) => o.permission === 'partners.partner_user.manage')).toBe(true);
    expect(PARTNER_OPS.filter((o) => o.permission === 'partners.partner_user.manage' && !o.path.startsWith('/v1/partners/users')).map((o) => o.operationId)).toEqual([]);
  });
  it('referrer writes use .manage and reads use .read (a member holds read only)', () => {
    for (const o of PARTNER_OPS.filter((x) => x.path.startsWith('/v1/partners/referrers'))) expect(o.permission, o.operationId).toBe(o.method === 'GET' ? 'partners.referrer.read' : 'partners.referrer.manage');
  });
});

// ------------------------------------------------------------------ ST1 / ST2 / ST3 coverage guard
// The executable cross-tenant / cross-partner / cross-centre cases live in the per-task suites (and the generic empty-world probe next to this file). This guard makes
// "every operationId has such a case" a hard requirement: a new operationId, or a suite that stops naming one, fails here.
const TESTS = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'partners', '__tests__');
const files = existsSync(TESTS) ? readdirSync(TESTS).filter((f) => f.endsWith('.test.ts') && !/^(boot|observability)/.test(f)) : [];
const text = new Map(files.map((f) => [f, readFileSync(join(TESTS, f), 'utf8')]));
const SCOPE = /not_found|404|partner Y|tenant B|foreign|another partner|other partner|cross-|centre C2|C2 vs C1|not.*visible|invisible/i;
/** Review item 1: match PER TEST BLOCK, never whole file. A block = the text from one it( / it.each( / test( to the next. */
const blocksOf = (t: string) => t.split(/^\s*(?:it|test)(?:\.each\b|\()/m).slice(1);
const hasProofBlock = (t: string, id: string) => blocksOf(t).some((b) => new RegExp(`\\b${id}\\b`).test(b) && SCOPE.test(b));
const proofFiles = (id: string) => [...text.entries()].filter(([, t]) => hasProofBlock(t, id)).map(([f]) => f);
// Executed generic probes (not-found.probes.test.ts, generated from the spec) also count: an unseen-id 404 case for every op with an *_id path param, and a scope-binding case for every other op.
const GENERATED = new Set([...BY_PATH_ID, ...NO_PATH_ID].map((o) => o.operationId));

describe('ST1 / ST2 / ST3 coverage guard', () => {
  it('self-check: the opId in one block and "404" in ANOTHER block is NOT a proof; both in one block is', () => {
    const planted = ["it('a', () => { callMyOp(); });", "it('b', () => { expect(status).toBe(404); });"].join('\n');
    expect(hasProofBlock(planted, 'callMyOp')).toBe(false);
    expect(hasProofBlock(planted + "\nit('c', () => { callMyOp(); expect(status).toBe(404); });", 'callMyOp')).toBe(true);
    expect(hasProofBlock("it.each(rows)('x %s', (callMyOp) => { expect(r).toBe('cross-partner'); });", 'callMyOp')).toBe(true);
  });

  it('the per-task suites exist (guard is not vacuous)', () => expect(files.length).toBeGreaterThanOrEqual(15));

  it.each(ALL.filter((o) => !UNOWNED_STUBS.includes(o.operationId)).map((o) => [o.operationId, o.staff ? 'ST1+ST3 (tenant, centre)' : 'ST1+ST2 (tenant, partner)'] as const))(
    '%s has a cross-scope case in a test file (%s)', (operationId) => {
      expect(proofFiles(operationId).length > 0 || GENERATED.has(operationId), `no test BLOCK names ${operationId} next to a cross-scope assertion and no generated probe covers it`).toBe(true);
    });
});
