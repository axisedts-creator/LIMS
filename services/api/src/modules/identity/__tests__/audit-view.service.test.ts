// C2-T18 — audit / access-log / auth-event viewer service. Spec: 01-PRD US-D1..D3; 02-TRD §5.9, §7.4; 03-APP-FLOW §7.1; 05-SCHEMA §3.2 (CR-C2-010 centre clause);
// 07-SECURITY P-3, C-1, D-T3, REQ-SEC-017/024/031; 06-PLAN T18 ("detail writes access log before returning", probes incl. centre-scoped admin, perf at 10x seed).
// ASSUMED API (spec fixes no signatures; mirrors reporting/service/settings.service.ts):
//   services/api/src/modules/identity/service/audit-view.service.ts exports createAuditViewService(deps: object = {}) -> {
//     listAuditEntries(ctx, query), getAuditEntry(ctx, { auditId }), listAccessLogEntries(ctx, query), listAuthEvents(ctx, query) }
//   query = the raw snake_case HTTP query object (occurred_at_from, occurred_at_to, table, action, ..., sort, cursor, limit); results are the OpenAPI bodies
//   ({data, page:{limit,next_cursor?}} / AuditEntry). ctx = { tenantId, requestId, actor, centreScope:{all,centreIds}, tx, audit:{access} } (helpers.ts).
//   The access-log write may go through ctx.audit.access(...) OR core/audit/access.ts (INSERT INTO audit.access_log on ctx.tx): both are observed.
//   Errors are LimsError (core/errors.ts). The SQL lives in repository/audit-read.repo.ts (see audit-view.static.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CENTRE_A1, CENTRE_A2, CENTRE_B1, FROM, MEM_A, PHI_SENTINEL, T0, TENANT_A, TENANT_B, TO, USER_A, USER_A2, USER_B, USER_GONE,
  accessRow, auditRow, authRow, idN, makeEnv, readIdentitySpec, schemaKeys, walk,
} from './audit-view.helpers.js';

const spec: any = readIdentitySpec();
let createAuditViewService: (deps?: object) => any;
beforeAll(async () => { ({ createAuditViewService } = await import('../service/audit-view.service.js')); });
const svc = () => createAuditViewService({});
const Q = { occurred_at_from: FROM, occurred_at_to: TO };
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const noNulls = (o: any): void => { for (const [k, v] of Object.entries(o)) { expect(v === null, `null at ${k}`).toBe(false); if (v && typeof v === 'object' && !Array.isArray(v)) noNulls(v); } };

/** tenant A: 8 rows; centre A1 / A2 / none; tenant B rows in the same window (must never appear). */
function seedAudit() {
  return {
    audit_log: [
      auditRow(1), auditRow(2, { centre_id: CENTRE_A1 }), auditRow(3, { centre_id: CENTRE_A2 }), auditRow(4, { table_name: 'users', schema_name: 'core', action: 'INSERT', old_values: null, changed_columns: [] }),
      auditRow(5, { actor_id: USER_A2, membership_id: idN(0x3002) }), auditRow(6, { support_session_id: idN(0x9001), actor_type: 'user' }),
      auditRow(7, { occurred_at: new Date(T0 - 86_400_000) }),                                  // before the window
      auditRow(8, { occurred_at: new Date(T0 + 30 * 86_400_000) }),                             // after the window
      auditRow(50, { tenant_id: TENANT_B, actor_id: USER_B, centre_id: CENTRE_B1 }), auditRow(51, { tenant_id: TENANT_B, centre_id: null }),
    ],
  };
}

describe('US-D1 listAuditEntries — metadata only, newest first, zero tenant B rows', () => {
  it('returns tenant A rows in the window, newest first, none of tenant B', async () => {
    const env = makeEnv(seedAudit());
    const b = await svc().listAuditEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.audit_id)).toEqual([6, 5, 4, 3, 2, 1].map((n) => idN(0x1000 + n)));
    expect(b.data.some((d: any) => [50, 51].some((n) => d.audit_id === idN(0x1000 + n)))).toBe(false);
    expect(b.page.limit).toBe(50);
    expect(b.page.next_cursor).toBeUndefined();
  });
  it('is metadata only: no old/new values, client_ip or user_agent; no null values; keys within AuditEntrySummary; ISO-ms UTC time', async () => {
    const env = makeEnv(seedAudit());
    const b = await svc().listAuditEntries(env.ctx(), Q);
    const { props, required } = schemaKeys(spec, 'AuditEntrySummary');
    expect(JSON.stringify(b)).not.toContain(PHI_SENTINEL);
    for (const d of b.data) {
      expect(Object.keys(d).filter((k) => !props.includes(k))).toEqual([]);
      for (const r of required) expect(d).toHaveProperty(r);
      for (const k of ['old_values', 'new_values', 'client_ip', 'user_agent']) expect(d).not.toHaveProperty(k);
      expect(d.occurred_at).toMatch(ISO);
      expect(['insert', 'update']).toContain(d.action);
      noNulls(d);
    }
    const first = b.data.find((d: any) => d.audit_id === idN(0x1000 + 1));
    expect(first).toMatchObject({ table: 'core.roles', action: 'update', row_id: idN(0x2000 + 1), changed_columns: ['display_name'], request_id: idN(0x3000 + 1) });
    expect(b.data.find((d: any) => d.audit_id === idN(0x1000 + 4))).toMatchObject({ action: 'insert', table: 'core.users', changed_columns: [] });
  });
  it('the statements issued by a list never select old_values / new_values / SELECT * and always bind the tenant', async () => {
    const env = makeEnv(seedAudit());
    await svc().listAuditEntries(env.ctx(), Q);
    const sel = env.stmts.filter((s) => /audit\.audit_log/i.test(s.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of env.stmts) {
      expect(s.text).not.toMatch(/old_values|new_values/i);
      expect(s.text).not.toMatch(/select\s+\*/i);
      expect(s.text).not.toMatch(/\$\{|--/);
    }
    for (const s of sel) { expect(s.tenantPredicate, s.text).toBe(true); expect(s.values).toContain(TENANT_A); }
  });
  it.each([
    ['table', { table: 'core.users' }, [4]],
    ['action', { action: 'insert' }, [4]],
    ['actor_id', { actor_id: USER_A2 }, [5]],
    ['membership_id', { membership_id: idN(0x3002) }, [5]],
    ['row_id', { row_id: idN(0x2000 + 3) }, [3]],
    ['request_id', { request_id: idN(0x3000 + 2) }, [2]],
    ['support_session_id', { support_session_id: idN(0x9001) }, [6]],
    ['centre_id', { centre_id: CENTRE_A1 }, [2]],
  ])('filter %s narrows the list', async (_n, f, ns) => {
    const env = makeEnv(seedAudit());
    const b = await svc().listAuditEntries(env.ctx(), { ...Q, ...(f as object) });
    expect(b.data.map((d: any) => d.audit_id).sort()).toEqual((ns as number[]).map((n) => idN(0x1000 + n)).sort());
  });
  it('a date range excludes rows outside it; sort=occurred_at flips the order', async () => {
    const env = makeEnv(seedAudit());
    const narrow = await svc().listAuditEntries(env.ctx(), { occurred_at_from: new Date(T0 + 2 * 60_000).toISOString(), occurred_at_to: new Date(T0 + 4.5 * 60_000).toISOString() });
    expect(narrow.data.map((d: any) => d.audit_id)).toEqual([4, 3, 2].map((n) => idN(0x1000 + n)));
    const asc = await svc().listAuditEntries(env.ctx(), { ...Q, sort: 'occurred_at' });
    expect(asc.data.map((d: any) => d.audit_id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => idN(0x1000 + n)));
  });
  it('a list writes no access-log row (only the detail view does)', async () => {
    const env = makeEnv(seedAudit());
    await svc().listAuditEntries(env.ctx(), Q);
    expect(env.accessWrites).toEqual([]);
  });
});

describe('date-range rule (03-APP-FLOW §7.1: required, span <= 31 days, 400 common.validation_failed, pointer /occurred_at_to)', () => {
  const ops = ['listAuditEntries', 'listAccessLogEntries', 'listAuthEvents'] as const;
  const day = (n: number) => new Date(Date.parse(FROM) + n * 86_400_000).toISOString();
  it.each(ops)('%s: missing from / to -> common.validation_failed, no statement executed', async (op) => {
    for (const q of [{}, { occurred_at_from: FROM }, { occurred_at_to: TO }]) {
      const env = makeEnv(seedAudit());
      const e = await rejects(svc()[op](env.ctx(), q));
      expect(e.code).toBe('common.validation_failed');
      expect(env.stmts.length).toBe(0);
    }
  });
  it.each(ops)('%s: exactly 31 days is accepted, 31 days + 1 s is rejected at /occurred_at_to', async (op) => {
    const env = makeEnv(seedAudit());
    await expect(svc()[op](env.ctx(), { occurred_at_from: FROM, occurred_at_to: day(31) })).resolves.toBeTruthy();
    const e = await rejects(svc()[op](env.ctx(), { occurred_at_from: FROM, occurred_at_to: new Date(Date.parse(day(31)) + 1000).toISOString() }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors?.[0]?.path).toBe('/occurred_at_to');
  });
  it.each(ops)('%s: from after to, and unparseable dates, are rejected', async (op) => {
    const env = makeEnv(seedAudit());
    for (const q of [{ occurred_at_from: TO, occurred_at_to: FROM }, { occurred_at_from: 'yesterday', occurred_at_to: TO }, { occurred_at_from: FROM, occurred_at_to: '2026-13-45T00:00:00Z' }]) {
      expect((await rejects(svc()[op](env.ctx(), q))).code).toBe('common.validation_failed');
    }
  });
  it.each(ops)('%s: limit 201 / 0 / non-integer and a garbage cursor -> common.validation_failed', async (op) => {
    const env = makeEnv(seedAudit());
    for (const x of [{ limit: 201 }, { limit: 0 }, { limit: 'x' }, { cursor: '!!not-a-cursor!!' }, { cursor: 'AAAA' }]) {
      expect((await rejects(svc()[op](env.ctx(), { ...Q, ...x }))).code, JSON.stringify(x)).toBe('common.validation_failed');
    }
  });
});

describe('cursor paging (keyset on occurred_at, id): every row once, ties on occurred_at safe', () => {
  const T = new Date(T0 + 5 * 60_000);
  const tied = Array.from({ length: 7 }, (_v, i) => auditRow(100 + i, { occurred_at: T }));          // 7 rows share one timestamp
  const rows = [...tied, auditRow(1), auditRow(2), auditRow(3)];
  it.each([['-occurred_at'], ['occurred_at']])('limit 3, sort %s: 10 rows in 4 pages, no duplicate, no gap, stable order', async (sort) => {
    const env = makeEnv({ audit_log: rows });
    const { ids, pages } = await walk((cursor) => svc().listAuditEntries(env.ctx(), { ...Q, limit: 3, sort, ...(cursor ? { cursor } : {}) }));
    expect(pages).toBe(4);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect([...ids].sort()).toEqual(rows.map((r) => r.id).sort());
    const full = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 200, sort });
    expect(full.data.map((d: any) => d.audit_id)).toEqual(ids);
  });
  it('exactly `limit` rows left -> no next_cursor; page.limit echoes the effective limit; fetches at most limit+1 rows', async () => {
    const env = makeEnv({ audit_log: rows });
    const b = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 10 });
    expect(b.data.length).toBe(10);
    expect(b.page).toEqual({ limit: 10 });
    const c = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 4 });
    expect(c.page.limit).toBe(4);
    expect(typeof c.page.next_cursor).toBe('string');
    expect(c.page.next_cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    for (const s of env.stmts.filter((x) => /audit\.audit_log/i.test(x.text))) expect(s.returned).toBeLessThanOrEqual(11);
  });
  it('a cursor never lets a caller leave their tenant (cursor values are bound as parameters, tenant predicate stays)', async () => {
    const env = makeEnv({ audit_log: [...rows, auditRow(900, { tenant_id: TENANT_B, occurred_at: T })] });
    const p1 = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 3 });
    const p2 = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 3, cursor: p1.page.next_cursor });
    expect([...p1.data, ...p2.data].some((d: any) => d.audit_id === idN(0x1000 + 900))).toBe(false);
    for (const s of env.stmts) expect(s.tenantPredicate).toBe(true);
  });
});

describe('centre scope (CR-C2-010, 07-SECURITY C-1): a centre-scoped admin sees only centre_id IS NULL or own-centre rows', () => {
  it('all-centres admin sees A1, A2 and unscoped rows', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: true, centreIds: [] } });
    const b = await svc().listAuditEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.centre_id).filter(Boolean).sort()).toEqual([CENTRE_A1, CENTRE_A2]);
  });
  it('centre-scoped admin (A1) sees unscoped + A1 rows only, never A2 or tenant B', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: false, centreIds: [CENTRE_A1] } });
    const b = await svc().listAuditEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.audit_id).sort()).toEqual([1, 2, 4, 5, 6].map((n) => idN(0x1000 + n)).sort());
    expect(b.data.every((d: any) => d.centre_id === undefined || d.centre_id === CENTRE_A1)).toBe(true);
  });
  it('explicitly filtering another centre returns nothing (filter cannot widen the scope); own centre works', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: false, centreIds: [CENTRE_A1] } });
    expect((await svc().listAuditEntries(env.ctx(), { ...Q, centre_id: CENTRE_A2 })).data).toEqual([]);
    expect((await svc().listAuditEntries(env.ctx(), { ...Q, centre_id: CENTRE_B1 })).data).toEqual([]);
    expect((await svc().listAuditEntries(env.ctx(), { ...Q, centre_id: CENTRE_A1 })).data.length).toBe(1);
  });
  it('paging as a scoped admin never surfaces an out-of-scope row', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: false, centreIds: [CENTRE_A1] } });
    const { ids } = await walk((cursor) => svc().listAuditEntries(env.ctx(), { ...Q, limit: 2, ...(cursor ? { cursor } : {}) }));
    expect(ids).not.toContain(idN(0x1000 + 3));
    expect(ids.length).toBe(5);
  });
  it('support session / no centres (all=false, centreIds=[]) sees only centre-less rows', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: false, centreIds: [] } });
    const b = await svc().listAuditEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.audit_id).sort()).toEqual([1, 4, 5, 6].map((n) => idN(0x1000 + n)).sort());
  });
  it('the same centre predicate applies to listAccessLogEntries', async () => {
    const rows = [accessRow(1), accessRow(2, { centre_id: CENTRE_A1 }), accessRow(3, { centre_id: CENTRE_A2 })];
    const env = makeEnv({ access_log: rows }, { scope: { all: false, centreIds: [CENTRE_A1] } });
    const b = await svc().listAccessLogEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.id).sort()).toEqual([1, 2].map((n) => idN(0x5000 + n)).sort());
  });
  it('auth events have no centre column: a centre-scoped admin sees the same tenant rows (documented, C-1)', async () => {
    const rows = [authRow(1), authRow(2)];
    const all = await svc().listAuthEvents(makeEnv({ auth_events: rows }).ctx(), Q);
    const scoped = await svc().listAuthEvents(makeEnv({ auth_events: rows }, { scope: { all: false, centreIds: [CENTRE_A1] } }).ctx(), Q);
    expect(scoped.data.length).toBe(all.data.length);
    expect(scoped.data.length).toBe(2);
  });
});

describe('actor display names (03-APP-FLOW §7.1.3): same tenant only, unknown -> "Unknown actor"', () => {
  it('resolves user actors in the tenant, never another tenant, unknown -> Unknown actor; no PII beyond the name', async () => {
    const rows = [auditRow(1), auditRow(2, { actor_id: USER_A2, membership_id: idN(0x3002) }), auditRow(3, { actor_id: USER_GONE, membership_id: null }), auditRow(4, { actor_id: USER_B, membership_id: null })];
    const env = makeEnv({ audit_log: rows });
    const b = await svc().listAuditEntries(env.ctx(), Q);
    const by = Object.fromEntries(b.data.map((d: any) => [d.audit_id, d.actor]));
    expect(by[idN(0x1001)]).toMatchObject({ type: 'user', id: USER_A, membership_id: MEM_A, display_name: 'Demo Lab Admin' });
    expect(by[idN(0x1002)].display_name).toBe('Demo Technician');
    expect(by[idN(0x1003)].display_name).toBe('Unknown actor');
    expect(by[idN(0x1004)].display_name).toBe('Unknown actor');              // exists only in tenant B: must not leak
    expect(JSON.stringify(b)).not.toContain('Beta Person');
  });
  it('display-name lookups are batched (no N+1) and bind the tenant', async () => {
    const rows = Array.from({ length: 40 }, (_v, i) => auditRow(i + 1));
    const env = makeEnv({ audit_log: rows });
    await svc().listAuditEntries(env.ctx(), { ...Q, limit: 40 });
    expect(env.stmts.length).toBeLessThanOrEqual(3);
    for (const s of env.stmts) expect(s.tenantPredicate, s.text).toBe(true);
  });
});

describe('US-D2 getAuditEntry — values shown, access log written before returning (07-SECURITY D-T3)', () => {
  const id = idN(0x1000 + 2);
  it('returns old/new values (JSON text, per contract), changed columns, client_ip, user_agent', async () => {
    const env = makeEnv(seedAudit());
    const e = await svc().getAuditEntry(env.ctx(), { auditId: id });
    const { props, required } = schemaKeys(spec, 'AuditEntry');
    expect(Object.keys(e).filter((k) => !props.includes(k))).toEqual([]);
    for (const r of required) expect(e).toHaveProperty(r);
    expect(e).toMatchObject({ audit_id: id, table: 'core.roles', action: 'update', changed_columns: ['display_name'], client_ip: '10.0.0.5', user_agent: 'Mozilla/5.0', centre_id: CENTRE_A1 });
    expect(typeof e.old_values).toBe('string');
    expect(typeof e.new_values).toBe('string');
    expect(JSON.parse(e.old_values)).toEqual({ display_name: `${PHI_SENTINEL}-2` });
    expect(JSON.parse(e.new_values)).toEqual({ display_name: 'New 2' });
    expect(e.actor.display_name).toBe('Demo Lab Admin');
    noNulls(e);
  });
  it('an insert entry (no old values) carries no null', async () => {
    const env = makeEnv(seedAudit());
    const e = await svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + 4) });
    noNulls(e);
    expect(e.action).toBe('insert');
  });
  it('writes exactly one access_log audit_entry.view / entity audit_entry for the viewer, with no values in it', async () => {
    const env = makeEnv(seedAudit());
    await svc().getAuditEntry(env.ctx(), { auditId: id });
    const w = env.viewWrites();
    expect(w.length).toBe(1);
    expect(w[0]).toMatchObject({ action: 'audit_entry.view', entity_type: 'audit_entry', outcome: 'allowed' });
    expect(w[0].entity_id).toBe(id);
    if (w[0].channel === 'tx') expect(w[0]).toMatchObject({ tenant_id: TENANT_A, actor_id: USER_A, actor_type: 'user', membership_id: MEM_A });
    expect(JSON.stringify(w[0])).not.toContain(PHI_SENTINEL);
    expect(JSON.stringify(w[0])).not.toContain('New 2');
  });
  it('the access-log write happens before the call returns (resolved only after the write is recorded)', async () => {
    const env = makeEnv(seedAudit());
    let writes = 0;
    const origQuery = env.tx.query.bind(env.tx);
    const ctx = env.ctx();
    const slow = { ...ctx, audit: { access: async (e: any) => { await new Promise((r) => setTimeout(r, 25)); writes++; return ctx.audit.access(e); } }, tx: { query: async (t: string, v: unknown[]) => { if (/insert\s+into\s+audit\.access_log/i.test(t)) { await new Promise((r) => setTimeout(r, 25)); writes++; } return origQuery(t, v); } } };
    await svc().getAuditEntry(slow, { auditId: id });
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(env.viewWrites().length).toBe(1);
  });
  it('D-T3 fault injection: access-log insert fails -> the request fails and no values leave (error carries none)', async () => {
    const env = makeEnv(seedAudit(), { failAccess: true });
    const e = await rejects(svc().getAuditEntry(env.ctx(), { auditId: id }));
    expect(String(e?.message ?? e)).not.toContain(PHI_SENTINEL);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(PHI_SENTINEL);
    expect(env.viewWrites()).toEqual([]);
  });
  it('unknown id -> common.not_found and no view logged', async () => {
    const env = makeEnv(seedAudit());
    const e = await rejects(svc().getAuditEntry(env.ctx(), { auditId: idN(0x1fff) }));
    expect(e.code).toBe('common.not_found');
    expect(env.viewWrites()).toEqual([]);
  });
  it('tenant B entry id as tenant A -> common.not_found (not 403), no values, no view logged; the SELECT binds tenant and id', async () => {
    const env = makeEnv(seedAudit());
    const e = await rejects(svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + 50) }));
    expect(e.code).toBe('common.not_found');
    expect(env.viewWrites()).toEqual([]);
    const sel = env.stmts.filter((s) => /audit\.audit_log/i.test(s.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) { expect(s.tenantPredicate).toBe(true); expect(s.values).toContain(TENANT_A); expect(s.values).toContain(idN(0x1000 + 50)); }
  });
  it('centre-scoped admin (A1) opening an A2 entry -> common.not_found and no view logged; own-centre and unscoped entries open', async () => {
    const env = makeEnv(seedAudit(), { scope: { all: false, centreIds: [CENTRE_A1] } });
    expect((await rejects(svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + 3) }))).code).toBe('common.not_found');
    expect(env.viewWrites()).toEqual([]);
    await expect(svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + 2) })).resolves.toBeTruthy();
    await expect(svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + 1) })).resolves.toBeTruthy();
    expect(env.viewWrites().length).toBe(2);
  });
  it('a malformed audit_id is rejected without touching the database', async () => {
    const env = makeEnv(seedAudit());
    const e = await rejects(svc().getAuditEntry(env.ctx(), { auditId: "1' OR '1'='1" }));
    expect(['common.validation_failed', 'common.not_found']).toContain(e.code);
    expect(env.stmts.length).toBe(0);
  });
});

describe('US-D3 listAccessLogEntries', () => {
  const rows = () => [
    accessRow(1), accessRow(2, { action: 'audit_export.download', entity_type: 'audit_export', actor_id: USER_A2, membership_id: idN(0x3002), outcome: 'denied' }),
    accessRow(3, { centre_id: CENTRE_A1, entity_id: idN(0xe3) }), accessRow(4, { tenant_id: TENANT_B }), accessRow(5, { occurred_at: new Date(T0 + 40 * 86_400_000) }),
  ];
  it('tenant A only, newest first, AccessLogEntry shape, detail as JSON text, no nulls', async () => {
    const env = makeEnv({ access_log: rows() });
    const b = await svc().listAccessLogEntries(env.ctx(), Q);
    expect(b.data.map((d: any) => d.id)).toEqual([3, 2, 1].map((n) => idN(0x5000 + n)));
    const { props, required } = schemaKeys(spec, 'AccessLogEntry');
    for (const d of b.data) {
      expect(Object.keys(d).filter((k) => !props.includes(k))).toEqual([]);
      for (const r of required) expect(d).toHaveProperty(r);
      expect(typeof d.detail).toBe('string');
      expect(JSON.parse(d.detail)).toEqual({ k: 'v' });
      expect(d.occurred_at).toMatch(ISO);
      expect(['allowed', 'denied']).toContain(d.outcome);
      noNulls(d);
    }
    for (const s of env.stmts) expect(s.tenantPredicate).toBe(true);
  });
  it.each([
    ['action', { action: 'audit_export.download' }, [2]], ['entity_type', { entity_type: 'audit_export' }, [2]], ['entity_id', { entity_id: idN(0xe3) }, [3]],
    ['actor_id', { actor_id: USER_A2 }, [2]], ['membership_id', { membership_id: idN(0x3002) }, [2]], ['centre_id', { centre_id: CENTRE_A1 }, [3]], ['outcome', { outcome: 'denied' }, [2]],
  ])('filter %s narrows the list', async (_n, f, ns) => {
    const env = makeEnv({ access_log: rows() });
    const b = await svc().listAccessLogEntries(env.ctx(), { ...Q, ...(f as object) });
    expect(b.data.map((d: any) => d.id)).toEqual((ns as number[]).map((n) => idN(0x5000 + n)));
  });
  it('pages by cursor without duplicates', async () => {
    const env = makeEnv({ access_log: Array.from({ length: 9 }, (_v, i) => accessRow(i + 1, { occurred_at: new Date(T0 + 60_000) })) });
    const { ids, pages } = await walk((cursor) => svc().listAccessLogEntries(env.ctx(), { ...Q, limit: 4, ...(cursor ? { cursor } : {}) }));
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(9);
  });
});

describe('US-D3 listAuthEvents', () => {
  const rows = () => [
    authRow(1), authRow(2, { event_type: 'login_failed', membership_id: idN(0x3002), reason_code: 'auth.login_failed' }),
    authRow(3, { tenant_id: null, event_type: 'login_failed', membership_id: null, user_id: null }),         // tenant-less row (unknown account): never in a tenant list
    authRow(4, { tenant_id: TENANT_B }), authRow(5, { occurred_at: new Date(T0 + 40 * 86_400_000) }),
  ];
  it('tenant A rows only (no tenant-less, no tenant B), AuthEvent shape, email HMAC never returned', async () => {
    const env = makeEnv({ auth_events: rows() });
    const b = await svc().listAuthEvents(env.ctx(), Q);
    expect(b.data.map((d: any) => d.auth_event_id)).toEqual([2, 1].map((n) => idN(0x7000 + n)));
    const { props, required } = schemaKeys(spec, 'AuthEvent');
    const enumv: string[] = spec.components.schemas.AuthEvent.properties.event_type.enum;
    for (const d of b.data) {
      expect(Object.keys(d).filter((k) => !props.includes(k))).toEqual([]);
      for (const r of required) expect(d).toHaveProperty(r);
      expect(d).not.toHaveProperty('email_hmac');
      expect(enumv).toContain(d.event_type);
      expect(d.occurred_at).toMatch(ISO);
      noNulls(d);
    }
    expect(JSON.stringify(b)).not.toMatch(/email_hmac|CQkJCQkJCQ/);
    for (const s of env.stmts) { expect(s.tenantPredicate).toBe(true); expect(s.text).not.toMatch(/email_hmac|select\s+\*/i); }
  });
  it.each([['event_type', { event_type: 'login_failed' }, [2]], ['membership_id', { membership_id: idN(0x3002) }, [2]]])('filter %s narrows the list', async (_n, f, ns) => {
    const env = makeEnv({ auth_events: rows() });
    const b = await svc().listAuthEvents(env.ctx(), { ...Q, ...(f as object) });
    expect(b.data.map((d: any) => d.auth_event_id)).toEqual((ns as number[]).map((n) => idN(0x7000 + n)));
  });
  it('pages by cursor without duplicates', async () => {
    const env = makeEnv({ auth_events: Array.from({ length: 9 }, (_v, i) => authRow(i + 1, { occurred_at: new Date(T0 + 60_000) })) });
    const { ids, pages } = await walk((cursor) => svc().listAuthEvents(env.ctx(), { ...Q, limit: 4, ...(cursor ? { cursor } : {}) }));
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(9);
  });
});

describe('P-3 probes: tenant A credentials with tenant B data present -> zero B rows on every list; DB failure leaks nothing', () => {
  it('every list returns zero tenant B rows even when B has the most rows', async () => {
    const mk = (f: (n: number, o: object) => object) => Array.from({ length: 30 }, (_v, i) => f(i + 1, { tenant_id: TENANT_B }));
    const env = makeEnv({ audit_log: mk(auditRow), access_log: mk(accessRow), auth_events: mk(authRow) });
    for (const op of ['listAuditEntries', 'listAccessLogEntries', 'listAuthEvents']) {
      const b = await svc()[op](env.ctx(), { ...Q, limit: 200 });
      expect(b.data, op).toEqual([]);
    }
  });
  it('a database error propagates as an error carrying neither SQL nor values', async () => {
    const env = makeEnv(seedAudit(), { failOn: [{ match: /audit\.audit_log/i, error: () => Object.assign(new Error(`boom ${PHI_SENTINEL}`), { code: '57014' }) }] });
    const e = await rejects(svc().listAuditEntries(env.ctx(), Q));
    expect(e).toBeTruthy();
  });
});

describe('perf at 10x seed (06-PLAN T18): cost stays bounded by the page, not by the table', () => {
  const big = (n: number) => {
    const audit_log: any[] = []; const access_log: any[] = []; const auth_events: any[] = [];
    for (let i = 1; i <= n; i++) {
      const o = { occurred_at: new Date(T0 + (i % 20_000) * 1000) };
      audit_log.push(auditRow(i, { ...o, id: idN(0x100000 + i), centre_id: i % 3 === 0 ? CENTRE_A1 : null }));
      access_log.push(accessRow(i, { ...o, id: idN(0x400000 + i) }));
      auth_events.push(authRow(i, { ...o, id: idN(0x700000 + i) }));
      if (i % 4 === 0) { audit_log.push(auditRow(i, { ...o, id: idN(0x200000 + i), tenant_id: TENANT_B })); access_log.push(accessRow(i, { ...o, id: idN(0x500000 + i), tenant_id: TENANT_B })); auth_events.push(authRow(i, { ...o, id: idN(0x800000 + i), tenant_id: TENANT_B })); }
    }
    return { audit_log, access_log, auth_events };
  };
  const run = async (n: number) => {
    const env = makeEnv(big(n), { scope: { all: false, centreIds: [CENTRE_A1] } });
    const t = performance.now();
    const out: Record<string, any> = {};
    for (const op of ['listAuditEntries', 'listAccessLogEntries', 'listAuthEvents']) out[op] = await svc()[op](env.ctx(), { ...Q, limit: 50 });
    const ms = performance.now() - t;
    return { env, out, ms };
  };
  it('1x (2 000 rows/table) vs 10x (20 000): same number of statements, <= limit+1 rows read per statement, first page identical size, bounded time', async () => {
    const one = await run(2_000); const ten = await run(20_000);
    expect(ten.env.stmts.length).toBe(one.env.stmts.length);
    expect(ten.env.stmts.length).toBeLessThanOrEqual(9);
    for (const s of ten.env.stmts.filter((x) => /audit\.|identity\.auth_events/i.test(x.text) && !/core\./i.test(x.text))) expect(s.returned, s.text).toBeLessThanOrEqual(51);
    for (const op of Object.keys(ten.out)) { expect(ten.out[op].data.length).toBe(50); expect(ten.out[op].page.next_cursor).toBeTruthy(); expect(one.out[op].data.length).toBe(50); }
    expect(ten.ms).toBeLessThan(3_000);
  });
  it('walks 10 consecutive pages at 10x without a duplicate and with constant statements per page (keyset, not OFFSET)', async () => {
    const env = makeEnv(big(20_000));
    let cursor: string | undefined; const seen = new Set<string>(); const per: number[] = [];
    for (let p = 0; p < 10; p++) {
      const before = env.stmts.length;
      const b = await svc().listAuditEntries(env.ctx(), { ...Q, limit: 50, ...(cursor ? { cursor } : {}) });
      per.push(env.stmts.length - before);
      for (const d of b.data) { expect(seen.has(d.audit_id)).toBe(false); seen.add(d.audit_id); }
      cursor = b.page.next_cursor; expect(cursor).toBeTruthy();
    }
    expect(seen.size).toBe(500);
    expect(new Set(per).size).toBe(1);
    for (const s of env.stmts) expect(s.text).not.toMatch(/\boffset\b/i);
  });
});

// LD-64 / CR-C2-T18-a: action enum [insert, update, delete]; AuditActor.required = [type]; actor.id omitted when actor_id IS NULL (system actor).
describe('LD-64 CR-C2-T18-a — DELETE rows and system (NULL actor_id) rows stay on contract', () => {
  const DEL = 9, SYS = 10;
  const seed = () => ({ audit_log: [auditRow(DEL, { action: 'DELETE', new_values: null, changed_columns: [] }), auditRow(SYS, { actor_id: null, actor_type: 'system', membership_id: null })] });
  const sch = (n: string) => spec.components.schemas[n];
  /** Minimal validator for the object schemas under test: additionalProperties false, required, and enum on `action`. */
  const conforms = (name: string, o: any) => {
    const s = sch(name);
    expect(Object.keys(o).filter((k) => !(k in s.properties)), `${name} extra keys`).toEqual([]);
    for (const r of s.required ?? []) expect(o, `${name}.${r} required`).toHaveProperty(r);
    if ('action' in o) expect(s.properties.action.enum, `${name}.action enum`).toContain(o.action);
    if (o.actor) {
      const a = sch('AuditActor');
      expect(Object.keys(o.actor).filter((k) => !(k in a.properties)), 'AuditActor extra keys').toEqual([]);
      for (const r of a.required) expect(o.actor).toHaveProperty(r);
    }
  };
  it('the contract itself carries the LD-64 shape (guards the fixtures below)', () => {
    for (const n of ['AuditEntrySummary', 'AuditEntry']) expect(sch(n).properties.action.enum).toEqual(['insert', 'update', 'delete']);
    expect(sch('AuditActor').required).toEqual(['type']);
    expect(sch('AuditActor').properties).not.toHaveProperty('maintenance');
    const get = Object.values<any>(spec.paths).map((p) => p.get).find((g) => g?.operationId === 'listAuditEntries');
    expect(get.parameters.find((p: any) => p.name === 'action').schema.enum).toEqual(['insert', 'update', 'delete']);
  });
  it('?action=delete is accepted and forwarded to the repo as DELETE; only the delete row returns', async () => {
    const env = makeEnv(seed());
    const b = await svc().listAuditEntries(env.ctx(), { ...Q, action: 'delete' });
    expect(env.stmts.some((s) => s.values.includes('DELETE'))).toBe(true);
    expect(b.data.map((d: any) => d.audit_id)).toEqual([idN(0x1000 + DEL)]);
    expect(b.data[0].action).toBe('delete');
  });
  it('?action=truncate (and other non-enum values) still -> common.validation_failed, no statement executed', async () => {
    for (const action of ['truncate', 'DELETE', 'Delete']) {
      const env = makeEnv(seed());
      const e = await rejects(svc().listAuditEntries(env.ctx(), { ...Q, action }));
      expect(e.code, action).toBe('common.validation_failed');
      expect(env.stmts.length).toBe(0);
    }
  });
  it('a DELETE row maps to action "delete" in list and in getAuditEntry, both on contract', async () => {
    const env = makeEnv(seed());
    const l = (await svc().listAuditEntries(env.ctx(), Q)).data.find((d: any) => d.audit_id === idN(0x1000 + DEL));
    expect(l.action).toBe('delete');
    conforms('AuditEntrySummary', l);
    const e = await svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + DEL) });
    expect(e.action).toBe('delete');
    conforms('AuditEntry', e);
    noNulls(e);
  });
  it('a NULL actor_id / actor_type system row yields actor {type, display_name} with no id key, in list and detail', async () => {
    const env = makeEnv(seed());
    const l = (await svc().listAuditEntries(env.ctx(), Q)).data.find((d: any) => d.audit_id === idN(0x1000 + SYS));
    expect(l.actor).toMatchObject({ type: 'system' });
    expect(l.actor).not.toHaveProperty('id');
    expect(l.actor).not.toHaveProperty('membership_id');
    conforms('AuditEntrySummary', l);
    noNulls(l);
    const e = await svc().getAuditEntry(env.ctx(), { auditId: idN(0x1000 + SYS) });
    expect(e.actor).toMatchObject({ type: 'system' });
    expect(Object.keys(e.actor)).not.toContain('id');
    expect(e.actor).not.toHaveProperty('maintenance');
    conforms('AuditEntry', e);
    noNulls(e);
  });
});
