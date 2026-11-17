// T0B-REGAPI-2, LD-323 (a)(e), LD-326: BillingCommandPortV1.previewInvoiceNo on the REAL implementation (real PG17, RLS as lims_api).
// Binding facts: it reads last_no + 1 of the INV series of the current BS fiscal year from billing.fiscal_counters and formats it with the tenant invoiceNoPattern;
// NO write, NO nextval, no row lock (a plain SELECT); no counter row yet = the first number of the year; a closed year is refused (billing.fiscal_year_closed);
// it never reserves anything: the real number is still allocated by the counter service inside issueOrderInvoice.
// The fake (packages/fakes/src/BillingCommandPort.fake.ts) must give the same shape: '{fyl}-{seq:6}' (long B.S. year, 03-IC:2884) for the test tenant pattern.
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/billing/T0B-REGAPI-2.pg.sh).
import { describe, expect, it } from 'vitest';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { LimsError } from '../../../../core/errors.js';
import { billingCommandPort } from '../../ports/BillingCommandPort.impl.js';
import { createCounterService } from '../../service/counter.service.js';
import { fiscalYearOf } from '../../domain/fiscalYear.js';
import { SYS_ACTOR, T, TENANT_A, TENANT_B, appTx, superTx } from '../accounts/helpers.js';

const NOW = new Date('2026-11-17T06:00:00.000Z');
const PATTERN = '{fyl}-{seq:6}';
const SHAPE = /^\d{4}\/\d{2}-\d{6}$/;
const FY = fiscalYearOf(NOW.toISOString() as never).long;
const pad = (n: number) => String(n).padStart(6, '0');

async function preview(tenant = TENANT_A, now = NOW, pattern: string | null = PATTERN): Promise<{ invoiceNo?: string; error?: unknown; stmts: string[] }> {
  const stmts: string[] = [];
  try {
    const invoiceNo = await appTx(tenant, async (raw: any) => {
      const tx = { startedAt: now, query: async (text: string, values?: unknown[]) => { stmts.push(text); return raw.query(text, values); } };
      const identity = { getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu', numbering: pattern === null ? {} : { invoiceNoPattern: pattern }, channels: {}, featureFlags: {} }) };
      const ctx: any = { tenantId: tenant, tx, actor: { type: 'system', id: SYS_ACTOR }, now: () => now, ports: { IdentityPort: identity } };
      return (await billingCommandPort.previewInvoiceNo(ctx, {})).invoiceNo;
    });
    return { invoiceNo, stmts };
  } catch (error) { return { error, stmts }; }
}
const counterRows = (tenant = TENANT_A) => superTx(async (tx: any) => (await tx.query(
  `SELECT series, fiscal_year_bs, last_no, closed_at, updated_at FROM billing.fiscal_counters WHERE tenant_id = $1 ORDER BY series, fiscal_year_bs`, [tenant])).rows);
const lastNo = async (tenant: string, series = 'INV', fy = FY) => Number((await counterRows(tenant)).find((r: any) => r.series === series && r.fiscal_year_bs === fy)?.last_no ?? 0);

describe('previewInvoiceNo (real implementation, LD-323)', () => {
  it('returns last_no + 1 of the INV series of the current BS fiscal year, formatted with the tenant pattern', { timeout: T }, async () => {
    const p = await preview();
    expect(p.error).toBeUndefined();
    expect(p.invoiceNo).toMatch(SHAPE);
    expect(p.invoiceNo).toBe(`${FY}-${pad((await lastNo(TENANT_A)) + 1)}`);
  });

  it('50 previews consume nothing: every answer is identical, the counter rows (last_no, updated_at, count) are unchanged, and no statement is a write or a lock', { timeout: T }, async () => {
    const before = await counterRows();
    const outs = [];
    for (let i = 0; i < 50; i++) outs.push(await preview());
    for (const o of outs) {
      expect(o.error).toBeUndefined();
      for (const s of o.stmts) {
        expect(s, 'a preview must be a plain read').not.toMatch(/^\s*(insert|update|delete|truncate)\b|nextval|for\s+(update|share)|pg_advisory|lock\s+table/i);
      }
    }
    expect(new Set(outs.map((o) => o.invoiceNo)).size).toBe(1);
    expect(await counterRows()).toEqual(before);
  });

  it('previews under concurrency never change the next real number: 20 parallel previews agree, the counter is untouched, and the next real allocation equals the preview', { timeout: T }, async () => {
    const before = await counterRows();
    const outs = await Promise.all(Array.from({ length: 20 }, () => preview()));
    expect(new Set(outs.map((o) => o.invoiceNo)).size).toBe(1);
    expect(await counterRows()).toEqual(before);
    const seen = outs[0]!.invoiceNo!;
    const counter = createCounterService();
    const got = await appTx(TENANT_A, async (tx: any) => counter.allocate(tx, { tenantId: TENANT_A, series: 'INV', fiscalYearBs: FY, actorId: SYS_ACTOR }));
    expect(`${FY}-${pad(got.lastNo)}`, 'the real number is exactly the one previewed').toBe(seen);
    expect((await preview()).invoiceNo, 'after a real allocation the preview moves on by one').toBe(`${FY}-${pad(got.lastNo + 1)}`);
  });

  it('previews racing real allocations never hands out a number below the committed counter and never moves it', { timeout: T }, async () => {
    const counter = createCounterService();
    const base = await lastNo(TENANT_A);
    const alloc = () => appTx(TENANT_A, async (tx: any) => counter.allocate(tx, { tenantId: TENANT_A, series: 'INV', fiscalYearBs: FY, actorId: SYS_ACTOR }));
    const mixed = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? alloc().then((a) => ({ kind: 'alloc' as const, n: a.lastNo })) : preview().then((p) => ({ kind: 'preview' as const, n: Number(p.invoiceNo!.slice(-6)) })))));
    const allocs = mixed.filter((m) => m.kind === 'alloc').map((m) => m.n).sort((a, b) => a - b);
    expect(allocs).toEqual([base + 1, base + 2, base + 3, base + 4]);            // gap free, unaffected by previews
    expect(await lastNo(TENANT_A)).toBe(base + 4);
    for (const m of mixed.filter((x) => x.kind === 'preview')) expect(m.n).toBeGreaterThanOrEqual(base + 1);
  });

  it('no counter row for the year yet: the first number of the year, and still no row is created', { timeout: T }, async () => {
    const future = new Date('2038-06-01T06:00:00.000Z');                 // a BS year no other test touches
    const fy = fiscalYearOf(future.toISOString() as never).long;
    const before = (await counterRows()).length;
    const p = await preview(TENANT_A, future);
    expect(p.invoiceNo).toBe(`${fy}-000001`);
    expect((await counterRows()).length).toBe(before);
  });

  it('a closed fiscal year is refused with billing.fiscal_year_closed (a wrong number is never shown)', { timeout: T }, async () => {
    const future = new Date('2039-06-01T06:00:00.000Z');
    const fy = fiscalYearOf(future.toISOString() as never).long;
    await superTx(async (tx: any) => tx.query(`INSERT INTO billing.fiscal_counters (tenant_id, series, fiscal_year_bs, last_no, closed_at, created_by, updated_by)
      VALUES ($1, 'INV', $2, 5, now(), $3, $3) ON CONFLICT DO NOTHING`, [TENANT_A, fy, SYS_ACTOR]));
    const p = await preview(TENANT_A, future);
    expect(p.error).toBeInstanceOf(LimsError);
    expect((p.error as LimsError).code).toBe('billing.fiscal_year_closed');
  });

  it('a missing or malformed tenant pattern is refused with billing.numbering_pattern_invalid (never a guessed number)', { timeout: T }, async () => {
    for (const bad of [null, 'no-seq-token', '{seq:6']) {
      const p = await preview(TENANT_A, NOW, bad);
      expect(p.error, `pattern ${String(bad)}`).toBeInstanceOf(LimsError);
      expect((p.error as LimsError).code).toBe('billing.numbering_pattern_invalid');
    }
  });

  it('tenant isolation: tenant B sees only its own counter and a tenant A preview never reads tenant B rows', { timeout: T }, async () => {
    await superTx(async (tx: any) => tx.query(`INSERT INTO billing.fiscal_counters (tenant_id, series, fiscal_year_bs, last_no, created_by, updated_by)
      VALUES ($1, 'INV', $2, 7, $3, $3) ON CONFLICT DO NOTHING`, [TENANT_B, FY, SYS_ACTOR]));
    const b = await lastNo(TENANT_B);
    expect(b).toBeGreaterThanOrEqual(7);
    expect((await preview(TENANT_B)).invoiceNo).toBe(`${FY}-${pad(b + 1)}`);
    expect((await preview(TENANT_A)).invoiceNo).toBe(`${FY}-${pad((await lastNo(TENANT_A)) + 1)}`);
  });

  it('the fake port gives the same number and the same shape as the real one for the same counter state (fake matches real)', { timeout: T }, async () => {
    const real = await preview();
    const fake: any = createFakeBillingCommandPort({ seed: 1 } as never);
    const f = await fake.previewInvoiceNo({ tenantId: TENANT_A, now: () => NOW, actor: { type: 'system', id: SYS_ACTOR } }, {});
    expect(f.invoiceNo).toMatch(SHAPE);
    expect(real.invoiceNo).toMatch(SHAPE);
    expect(f.invoiceNo.slice(0, 7), 'same BS fiscal year').toBe(real.invoiceNo!.slice(0, 7));
  });
});
