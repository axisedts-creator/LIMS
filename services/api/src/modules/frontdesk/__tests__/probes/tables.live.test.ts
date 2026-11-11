// FD-T16 / 07-SECURITY §6.3 table probes for EVERY table of schema `frontdesk` (the C0 db/tests suites T0B-10.C4_* hold the full pgTAP version; these are the vitest probes the task's
// done_when asks for, run as the real `lims_api` login under RLS, owner-side truth via the superuser):
//   structure  RLS enabled + FORCED, >=1 policy, no sequences, tenant_id-leading index, lims_app grants (never DELETE/TRUNCATE; no UPDATE on append-only patient_consents; g_cs_reasons SELECT only)
//   isolation  with A's claims: SELECT sees zero B rows; INSERT of a B row fails 42501 (RLS WITH CHECK); UPDATE / DELETE of B rows change zero rows (or are refused) and B stays byte-identical
//   immutability  the mutable-column / lifecycle triggers refuse (P0001 immutable_row): orders, order_items, discount_approvals (approval binding), discounts, trf_attachments
//   claims     partner / portal / patient actors see no frontdesk row (app.is_staff_or_system())
// A table that appears in the schema but not in EXPECTED fails the first test, so a new table cannot ship unprobed.
import { beforeAll, describe, expect, it } from 'vitest';
import { appTx, SYS_ACTOR, TENANT_A, TENANT_B, seed, seedOrder, seedPatient, superTx, tag, uid } from '../patients/helpers.js';
import { rows } from '../integration/helpers.js';
import { objs, snapshot, T, TENANT_TABLES, type Objs } from './kit.js';

const EXPECTED = [...TENANT_TABLES, 'g_cs_reasons'].sort();
const GLOBAL = new Set(['g_cs_reasons']);                                  // no tenant_id: global reference data, SELECT-only for lims_app
const APPEND_ONLY = new Set(['patient_consents']);                         // INSERT + SELECT only (REQ-SEC-005)
let A: Objs; let B: Objs;

beforeAll(async () => {
  A = await objs('a'); B = await objs('b');
  await seed('frontdesk.booking_links', rows.bookingLink('a', A.order.id)); await seed('frontdesk.booking_links', rows.bookingLink('b', B.order.id));
  for (const [t, side] of [[TENANT_A, 'a'], [TENANT_B, 'b']] as const) await seed('frontdesk.cs_reasons', { tenant_id: t, set_name: 'order_cancel_reasons', code: `probe_${side}_${tag()}`.toLowerCase(), display: 'Probe', sort_order: 90, id: uid() });
}, T);

const dbError = async (tenant: string, sql: string, values: unknown[] = []): Promise<any> => {
  try { await appTx(tenant, (tx) => tx.query(sql, values)); } catch (e) { return e; }
  throw new Error(`expected a database error: ${sql}`);
};
const rowOf = async (table: string, where: string, values: unknown[]) => (await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(x) AS j FROM frontdesk.${table} x WHERE ${where} LIMIT 1`, values)).rows))[0]?.j;

describe('structure (catalog queries)', () => {
  it('the schema holds exactly the probed tables (a new table must be added to EXPECTED and thereby probed)', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'frontdesk' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`)).rows);
    expect(r.map((x: any) => x.relname)).toEqual(EXPECTED);
  });
  it('RLS is enabled AND forced on every table; every table has a policy', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'frontdesk' AND p.tablename = c.relname)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'frontdesk' AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname <> 'g_cs_reasons'`)).rows);
    expect(r.filter((x: any) => !x.rls || !x.forced || x.policies < 1).map((x: any) => x.relname)).toEqual([]);
  });
  it('grants: lims_app never has DELETE/TRUNCATE; append-only tables have no UPDATE; g_cs_reasons is SELECT-only', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname, has_table_privilege('lims_app', c.oid, 'DELETE') AS del, has_table_privilege('lims_app', c.oid, 'TRUNCATE') AS trunc,
      has_table_privilege('lims_app', c.oid, 'UPDATE') AS upd, has_table_privilege('lims_app', c.oid, 'INSERT') AS ins, has_table_privilege('lims_app', c.oid, 'SELECT') AS sel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'frontdesk' AND c.relkind IN ('r','p') AND NOT c.relispartition`)).rows);
    expect(r.filter((x: any) => x.del || x.trunc).map((x: any) => x.relname), 'DELETE/TRUNCATE').toEqual([]);
    expect(r.filter((x: any) => (APPEND_ONLY.has(x.relname) || GLOBAL.has(x.relname)) && x.upd).map((x: any) => x.relname), 'UPDATE on append-only').toEqual([]);
    expect(r.filter((x: any) => GLOBAL.has(x.relname) && x.ins).map((x: any) => x.relname), 'INSERT on global').toEqual([]);
    expect(r.filter((x: any) => !x.sel).map((x: any) => x.relname), 'SELECT').toEqual([]);
  });
  it('no sequences in the schema (counters are rows)', async () => {
    expect((await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'frontdesk' AND c.relkind = 'S'`)).rows))).toEqual([]);
  });
  it('every tenant table has an index whose first column is tenant_id', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'frontdesk' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND c.relname <> 'g_cs_reasons' AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = c.oid AND a.attname = 'tenant_id')`)).rows);
    expect(r.map((x: any) => x.relname)).toEqual([]);
  });
});

describe.each(TENANT_TABLES.map((t) => [t] as const))('frontdesk.%s: tenant A claims against tenant B rows', (t) => {
  it('SELECT sees zero rows of any other tenant', { timeout: T }, async () => {
    const r = await appTx(TENANT_A, async (tx) => ({ foreign: (await tx.query(`SELECT count(*)::int AS n FROM frontdesk.${t} WHERE tenant_id <> $1`, [TENANT_A])).rows[0].n,
      b: (await tx.query(`SELECT count(*)::int AS n FROM frontdesk.${t} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n }));
    expect(r).toEqual({ foreign: 0, b: 0 });
  });
  it('INSERT of a row carrying tenant B\'s id fails (RLS WITH CHECK, 42501)', { timeout: T }, async () => {
    // a real B row where B has one, else an A row retagged, else an all-NULL record: RLS WITH CHECK is evaluated before NOT NULL / unique constraints
    const j = (await rowOf(t, 'tenant_id = $1', [TENANT_B])) ?? (await rowOf(t, 'tenant_id = $1', [TENANT_A])) ?? {};
    const e = await dbError(TENANT_A, `INSERT INTO frontdesk.${t} SELECT * FROM jsonb_populate_record(NULL::frontdesk.${t}, $1::jsonb)`, [JSON.stringify({ ...j, tenant_id: TENANT_B })]);
    expect(e.code, e.message).toBe('42501');
  });
  it('UPDATE and DELETE of B rows change zero rows (or are refused outright) and B stays byte-identical', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    for (const sql of [`UPDATE frontdesk.${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, `DELETE FROM frontdesk.${t} WHERE tenant_id = $1`]) {
      try { const r = await appTx(TENANT_A, (tx) => tx.query(sql, [TENANT_B])); expect(r.rowCount, sql).toBe(0); }
      catch (e: any) { expect(e.code, `${sql}: ${e.message}`).toBe('42501'); }               // no grant: permission denied is the stronger answer
    }
    expect(await snapshot(TENANT_B)).toEqual(before);
  });
});

describe('immutability (mutable-column + lifecycle triggers; P0001 immutable_row) — run as A under RLS', () => {
  const immutable = async (sql: string, values: unknown[]) => { const e = await dbError(TENANT_A, sql, values); expect([e.code, e.message], sql).toEqual(['P0001', 'immutable_row']); };
  it('orders: identity columns and the cancelled terminal state', async () => {
    await immutable(`UPDATE frontdesk.orders SET registration_no = registration_no || 'X' WHERE id = $1`, [A.order.id]);
    await immutable(`UPDATE frontdesk.orders SET patient_id = $2 WHERE id = $1`, [A.order.id, uid()]);
    await immutable(`UPDATE frontdesk.orders SET centre_id = $2 WHERE id = $1`, [A.order.id, B.centre]);
    const p = await seedPatient('a'); const c = await seedOrder('a', p.id, { status: 'cancelled', cancelled_at: '2026-11-06T00:00:00Z', cancel_reason_code: 'patient_request' });
    await immutable(`UPDATE frontdesk.orders SET status = 'registered' WHERE id = $1`, [c.id]);                    // nothing out of cancelled
    await immutable(`UPDATE frontdesk.orders SET cancel_reason_code = 'other' WHERE id = $1`, [c.id]);              // cancelled_* never changed afterwards
    await immutable(`UPDATE frontdesk.orders SET priority = 'urgent' WHERE id = $1`, [A.order.id]);                 // only while pre_registered
  });
  it('order_items: price / identity columns and a removed item cannot come back', async () => {
    await immutable(`UPDATE frontdesk.order_items SET unit_price_paisa = 1 WHERE id = $1`, [A.item.id]);
    await immutable(`UPDATE frontdesk.order_items SET orderable_id = $2 WHERE id = $1`, [A.item.id, uid()]);
    const removed = rows.item('a', A.order.id, { status: 'removed', removed_at: '2026-11-06T00:00:00Z', removal_reason_code: 'patient_request' }); await seed('frontdesk.order_items', removed);
    await immutable(`UPDATE frontdesk.order_items SET status = 'active', removed_at = NULL, removal_reason_code = NULL WHERE id = $1`, [removed.id]);
  });
  it('discount_approvals: approval binding (fingerprint / patient / centre / discounts) is immutable; rejected is terminal', async () => {
    for (const set of ['base_fingerprint = $2', 'patient_id = $2', 'centre_id = $2', `discounts = '[{"scope":"bill"}]'::jsonb`, 'computed_discount_paisa = 1', 'requested_by_membership_id = $2']) {
      const v = set.includes('$2') ? [A.approval.id, set.startsWith('base_fingerprint') ? 'a'.repeat(64) : uid()] : [A.approval.id];
      await immutable(`UPDATE frontdesk.discount_approvals SET ${set} WHERE id = $1`, v);
    }
    const rej = rows.approval('a', A.patient.id, { status: 'rejected', decided_by_membership_id: uid(), decided_at: '2026-11-06T00:00:00Z' }); await seed('frontdesk.discount_approvals', rej);
    await immutable(`UPDATE frontdesk.discount_approvals SET status = 'approved' WHERE id = $1`, [rej.id]);
  });
  it('discounts: amounts and reasons are immutable', async () => {
    await immutable(`UPDATE frontdesk.discounts SET amount_paisa = 1 WHERE id = $1`, [A.discount.id]);
    await immutable(`UPDATE frontdesk.discounts SET reason_code = 'other' WHERE id = $1`, [A.discount.id]);
  });
  it('trf_attachments: file identity is immutable, order link is set once, quarantined is terminal', async () => {
    await immutable(`UPDATE frontdesk.trf_attachments SET sha256 = $2 WHERE id = $1`, [A.trf.id, 'b'.repeat(64)]);
    await immutable(`UPDATE frontdesk.trf_attachments SET mime_type = 'text/html' WHERE id = $1`, [A.trf.id]);
    await immutable(`UPDATE frontdesk.trf_attachments SET order_id = $2 WHERE id = $1`, [A.trf.id, uid()]);        // already linked
  });
  it('patient_consents is append-only: UPDATE and DELETE are refused (no grant)', async () => {
    const c = await rowOf('patient_consents', 'tenant_id = $1', [TENANT_A]);
    for (const sql of [`UPDATE frontdesk.patient_consents SET sms = NOT sms WHERE id = $1`, `DELETE FROM frontdesk.patient_consents WHERE id = $1`]) expect((await dbError(TENANT_A, sql, [c.id])).code, sql).toBe('42501');
  });
  it('no DELETE of any kind: the settings / counters / patients rows of A survive a DELETE attempt', async () => {
    for (const t of ['settings', 'number_counters', 'patients', 'orders', 'order_items', 'discounts', 'discount_approvals', 'trf_attachments', 'order_flags', 'booking_links', 'cs_reasons']) {
      expect((await dbError(TENANT_A, `DELETE FROM frontdesk.${t} WHERE tenant_id = $1`, [TENANT_A])).code, t).toBe('42501');
    }
  });
});

describe('non-staff claims (partner / portal / patient) see no frontdesk rows (app.is_staff_or_system())', () => {
  it.each(['partner', 'portal', 'patient'])('actor_type %s', { timeout: T }, async (actorType) => {
    const counts = await appTx(TENANT_A, async (tx) => {
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT_A, sub: SYS_ACTOR, actor_type: actorType })]);
      const out: Record<string, number> = {};
      for (const t of TENANT_TABLES) out[t] = (await tx.query(`SELECT count(*)::int AS n FROM frontdesk.${t}`)).rows[0].n;
      return out;
    });
    expect(Object.entries(counts).filter(([, n]) => n !== 0)).toEqual([]);
    // and a write is refused too
    const e = await (async () => { try { await appTx(TENANT_A, async (tx) => {
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT_A, sub: SYS_ACTOR, actor_type: actorType })]);
      await tx.query(`INSERT INTO frontdesk.patients SELECT * FROM jsonb_populate_record(NULL::frontdesk.patients, $1::jsonb)`, [JSON.stringify({ ...(await rowOf('patients', 'tenant_id = $1', [TENANT_A])), id: uid(), patient_code: `ZP${tag()}` })]);
    }); } catch (x) { return x as any; } return undefined; })();
    expect(e?.code, 'a non-staff actor must not insert a patient').toBe('42501');
  });
});
