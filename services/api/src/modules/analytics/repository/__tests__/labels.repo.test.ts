// AN-T07 repository/labels.repo.ts (02-TRD §3 file tree + §6.x department SQL; 03-IC §6 view columns; 08 R12d §4.9; 07-SECURITY REQ-SEC-013/081).
// ASSUMED API (spec gives only the department SQL; same approach as BL-T02/T03). Every function takes the request `tx` first and
// `{ tenantId, ids? }`, runs ONE bound SELECT on a published view and returns the snake_case view columns, tenant-filtered:
//   listDepartments(tx, { tenantId })            catalog.v_pub_department            -> { department_id, name, is_active }
//   listTests(tx, { tenantId, ids? })            catalog.v_pub_test_directory        -> { test_id, code, name, department_id, is_active }
//   listReferrers(tx, { tenantId, ids? })        catalog.v_pub_referrer_directory    -> { referrer_id, display_name, is_active, canonical_referrer_id }
//   listInstruments(tx, { tenantId, ids? })      instruments.v_pub_instrument_directory -> { instrument_id, centre_id, instrument_code, display_name, is_active }
//   `ids` (when given) is ONE bound array parameter (`= ANY($n)`), never interpolated; omitted -> no id predicate; [] -> [].
// Fixture rows live in a fake tx that behaves like the view: filters by the bound tenant id and by any bound id array.
import { describe, expect, it } from 'vitest';
import { listDepartments, listInstruments, listReferrers, listTests } from '../labels.repo.js';

const TA = '01900000-0000-7000-8000-00000000000a', TB = '01900000-0000-7000-8000-00000000000b';
const u = (n: number) => `0190c408-0000-7000-8000-${String(n).padStart(12, '0')}`;
const D_HAEM = u(1), D_BIO = u(2), D_OLD = u(3), D_B = u(4);
const T_CBC = u(11), T_OLD = u(12), T_B = u(13);
const R_D1 = u(21), R_D3 = u(22), R_B = u(23);
const I_A = u(31), I_OFF = u(32), I_B = u(33), C_A = u(41);

const VIEWS: Record<string, { idCol: string; rows: Record<string, unknown>[] }> = {
  'catalog.v_pub_department': { idCol: 'department_id', rows: [
    { tenant_id: TA, department_id: D_HAEM, code: 'HAEM', name: 'Haematology', is_active: true },
    { tenant_id: TA, department_id: D_BIO, code: 'BIO', name: 'Biochemistry', is_active: true },
    { tenant_id: TA, department_id: D_OLD, code: 'OLD', name: 'Retired Dept', is_active: false },
    { tenant_id: TB, department_id: D_B, code: 'B', name: 'Other Tenant Dept', is_active: true }] },
  'catalog.v_pub_test_directory': { idCol: 'test_id', rows: [
    { tenant_id: TA, test_id: T_CBC, code: 'CBC', name: 'Complete Blood Count', department_id: D_HAEM, workflow_type: 'x', is_active: true },
    { tenant_id: TA, test_id: T_OLD, code: 'OLDT', name: 'Retired Test', department_id: D_OLD, workflow_type: 'x', is_active: false },
    { tenant_id: TB, test_id: T_B, code: 'BT', name: 'Other Tenant Test', department_id: D_B, workflow_type: 'x', is_active: true }] },
  'catalog.v_pub_referrer_directory': { idCol: 'referrer_id', rows: [
    { tenant_id: TA, referrer_id: R_D1, display_name: 'Dr Test One', is_active: true, canonical_referrer_id: null },
    { tenant_id: TA, referrer_id: R_D3, display_name: 'Dr Test Three', is_active: false, canonical_referrer_id: R_D1 },
    { tenant_id: TB, referrer_id: R_B, display_name: 'Dr Other Tenant', is_active: true, canonical_referrer_id: null }] },
  'instruments.v_pub_instrument_directory': { idCol: 'instrument_id', rows: [
    { tenant_id: TA, instrument_id: I_A, centre_id: C_A, instrument_code: 'HM-01', display_name: 'Hematology Analyzer', vendor: 'v', model: 'm', state: 'online', is_active: true },
    { tenant_id: TA, instrument_id: I_OFF, centre_id: C_A, instrument_code: 'CH-09', display_name: 'Old Chemistry', vendor: 'v', model: 'm', state: 'retired', is_active: false },
    { tenant_id: TB, instrument_id: I_B, centre_id: C_A, instrument_code: 'XX-01', display_name: 'Other Tenant Analyzer', vendor: 'v', model: 'm', state: 'online', is_active: true }] },
};

/** Fake tx that acts like the published views: tenant predicate on the first bound value, id predicate on any bound array. */
function viewTx(opts: { fail?: unknown } = {}) {
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    calls.push({ text, values });
    if (opts.fail) throw opts.fail;
    const m = /\bFROM\s+((?:catalog|instruments)\.v_pub_\w+)/i.exec(text);
    const view = m && VIEWS[m[1]!.toLowerCase()];
    if (!view) return { rows: [] };
    const ids = values.find(Array.isArray) as unknown[] | undefined;
    const rows = view.rows.filter((r) => r['tenant_id'] === values[0] && (ids === undefined || ids.includes(r[view.idCol])));
    return { rows: rows.map((r) => ({ ...r })) };
  } };
  return { tx: tx as never, calls };
}

type RepoFn = (tx: never, a: Record<string, unknown>) => Promise<Record<string, any>[]>;
const CASES: { name: string; fn: RepoFn; view: string; cols: string[] }[] = [
  { name: 'listDepartments', fn: listDepartments as RepoFn, view: 'catalog.v_pub_department', cols: ['department_id', 'name', 'is_active'] },
  { name: 'listTests', fn: listTests as RepoFn, view: 'catalog.v_pub_test_directory', cols: ['test_id', 'code', 'name', 'department_id', 'is_active'] },
  { name: 'listReferrers', fn: listReferrers as RepoFn, view: 'catalog.v_pub_referrer_directory', cols: ['referrer_id', 'display_name', 'is_active', 'canonical_referrer_id'] },
  { name: 'listInstruments', fn: listInstruments as RepoFn, view: 'instruments.v_pub_instrument_directory', cols: ['instrument_id', 'centre_id', 'instrument_code', 'display_name', 'is_active'] },
];

describe.each(CASES)('$name: one bound SELECT on the published view only', ({ fn, view, cols }) => {
  it(`runs exactly one SELECT … FROM ${view} WHERE tenant_id = $1 (no base tables, no other schemas)`, async () => {
    const { tx, calls } = viewTx();
    await fn(tx, { tenantId: TA });
    expect(calls).toHaveLength(1);
    const text = calls[0]!.text;
    expect(text).toMatch(/^\s*SELECT\b/i);
    expect(text.toLowerCase()).toContain(`from ${view}`);
    expect(text).toMatch(/\btenant_id\s*=\s*\$1\b/i);
    expect(calls[0]!.values[0]).toBe(TA);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    expect(text).not.toMatch(/\bcore\.|\bfrontdesk\.|\bbilling\.|\blab\./i);
    expect(text).not.toContain(TA);                                    // tenant is bound, never interpolated
  });

  it('returns the view columns, scoped to the bound tenant (tenant B rows never come back)', async () => {
    const rows = await fn(viewTx().tx, { tenantId: TA });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) for (const c of cols) expect(r, c).toHaveProperty(c);
    expect(JSON.stringify(rows)).not.toMatch(/Other Tenant|Dr Other/);
    const b = await fn(viewTx().tx, { tenantId: TB });
    expect(JSON.stringify(b)).toMatch(/Other Tenant|Dr Other/);
    expect(JSON.stringify(b)).not.toMatch(/Haematology|Dr Test|Hematology Analyzer|Complete Blood/);
  });

  it('a database failure propagates unchanged (no empty-label fallback that would hide missing rows)', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '08006' });
    await expect(fn(viewTx({ fail: boom }).tx, { tenantId: TA })).rejects.toBe(boom);
  });

  it('REQ-SEC-081: SELECT list is an explicit allowlist (no *, no patient / phone / email column)', async () => {
    const { tx, calls } = viewTx();
    await fn(tx, { tenantId: TA });
    const sel = /SELECT([\s\S]*?)\bFROM\b/i.exec(calls[0]!.text)![1]!;
    expect(sel).not.toMatch(/\*/);
    expect(sel).not.toMatch(/patient|phone|email|address|mobile/i);
  });

  it('no SQL predicate on is_active: inactive rows keep their label (X11)', async () => {
    const { tx, calls } = viewTx();
    await fn(tx, { tenantId: TA });
    const where = /\bWHERE\b([\s\S]*)$/i.exec(calls[0]!.text)?.[1] ?? '';
    expect(where).not.toMatch(/\bis_active\b/i);
  });
});

describe('inactive rows are returned with their flag (US-04.2, X11)', () => {
  it('departments: the deactivated department is present with is_active=false', async () => {
    const rows = await listDepartments(viewTx().tx, { tenantId: TA });
    expect(rows.map((r: any) => r.department_id).sort()).toEqual([D_HAEM, D_BIO, D_OLD].sort());
    expect(rows.find((r: any) => r.department_id === D_OLD)).toMatchObject({ name: 'Retired Dept', is_active: false });
  });
  it('tests / referrers / instruments: inactive rows are not filtered out', async () => {
    const t = await listTests(viewTx().tx, { tenantId: TA });
    expect(t.find((r: any) => r.test_id === T_OLD)).toMatchObject({ is_active: false, name: 'Retired Test' });
    const r = await listReferrers(viewTx().tx, { tenantId: TA });
    expect(r.find((x: any) => x.referrer_id === R_D3)).toMatchObject({ is_active: false });
    const i = await listInstruments(viewTx().tx, { tenantId: TA });
    expect(i.find((x: any) => x.instrument_id === I_OFF)).toMatchObject({ is_active: false, instrument_code: 'CH-09' });
  });
});

describe('US-05.2 / US-08.2 referrer canonical id (08 CR-C3-004)', () => {
  it('canonical_referrer_id is returned as published (merged doctor -> D1; unmerged -> null)', async () => {
    const rows = await listReferrers(viewTx().tx, { tenantId: TA });
    expect(rows.find((r: any) => r.referrer_id === R_D3)).toMatchObject({ canonical_referrer_id: R_D1, display_name: 'Dr Test Three' });
    expect(rows.find((r: any) => r.referrer_id === R_D1)).toMatchObject({ canonical_referrer_id: null });
  });
});

describe('id filters are one bound array parameter', () => {
  const IDS: [string, RepoFn, string, string][] = [
    ['listTests', listTests as RepoFn, 'test_id', T_CBC],
    ['listReferrers', listReferrers as RepoFn, 'referrer_id', R_D3],
    ['listInstruments', listInstruments as RepoFn, 'instrument_id', I_OFF],
  ];
  it.each(IDS)('%s with ids -> only those rows, ids bound (= ANY($n))', async (_n, fn, col, want) => {
    const { tx, calls } = viewTx();
    const rows = await fn(tx, { tenantId: TA, ids: [want] });
    expect(rows.map((r) => r[col])).toEqual([want]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/=\s*ANY\s*\(\s*\$\d+/i);
    expect(calls[0]!.values.some((v) => Array.isArray(v) && v.includes(want))).toBe(true);
  });
  it("another tenant's id asked from tenant A returns nothing (07 P1: no cross-tenant label)", async () => {
    expect(await listReferrers(viewTx().tx, { tenantId: TA, ids: [R_B] })).toEqual([]);
    expect(await listTests(viewTx().tx, { tenantId: TA, ids: [T_B] })).toEqual([]);
    expect(await listInstruments(viewTx().tx, { tenantId: TA, ids: [I_B] })).toEqual([]);
  });
  it('hostile id strings and tenant stay in bound values; SQL text is identical to the benign call', async () => {
    const evil = "x'); DROP TABLE catalog.v_pub_test_directory;--";
    for (const [, fn] of IDS) {
      const a = viewTx(), b = viewTx();
      await fn(a.tx, { tenantId: TA, ids: [u(99)] });
      await fn(b.tx, { tenantId: TA, ids: [evil] }).catch(() => undefined);   // a repo may reject non-uuid up front; it must never interpolate
      if (b.calls.length) {
        expect(b.calls[0]!.text).toBe(a.calls[0]!.text);
        expect(b.calls[0]!.text).not.toContain('DROP');
      }
    }
    const c = viewTx();
    await listDepartments(c.tx, { tenantId: "x' OR '1'='1" });
    expect(c.calls[0]!.text).not.toContain("OR '1'='1");
    expect(c.calls[0]!.values[0]).toBe("x' OR '1'='1");
  });
  it('empty ids -> empty result (no id predicate widening to the whole tenant)', async () => {
    for (const [, fn] of IDS) expect(await fn(viewTx().tx, { tenantId: TA, ids: [] })).toEqual([]);
  });
});
