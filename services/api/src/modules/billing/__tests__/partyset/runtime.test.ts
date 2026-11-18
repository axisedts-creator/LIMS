// T0B-PARTYSET-1 done_when (3) RUNTIME EFFECTS in billing, each proven: invoice_blocking_days (+ auto_block_overdue) blocks NEW credit billing through the existing block flag
// (billing.credit_accounts.is_locked + lock_reason_code, visible in getCreditAccount), invoice_warning_days returns a warning in the billing check, interest_bp_per_day is a line on the
// statement only and is NEVER posted. Real PG17. The billing check = BillingCommandPort.assertCreditAllowed (shared by recordCreditCharges).
// PINS (CONTRACT GAPS for the lead, see .orchestra/notes/T0B-PARTYSET-1-tests.md): due date = invoice date (Asia/Kathmandu) + invoice_payment_days of the party setting; days_overdue = today - due;
//   blocked when auto_block_overdue and an unpaid issued periodic credit invoice has days_overdue >= invoice_blocking_days -> billing.credit_party_locked AND the flag stays set (the handler
//   calls ctx.commitOnError()) with a non empty lock_reason_code; warning (not blocked) when days_overdue >= invoice_warning_days: assertCreditAllowed RESOLVES { warnings: [{ code, days_overdue }] }
//   (undefined when there is no warning, so the existing void callers and suites are unchanged); interest = floor(unpaid net x interest_bp_per_day x days_overdue / 10000) shown under a key
//   matching /interest/i on the statement row of the invoice month, closing balance unchanged, no ledger row, no account ledger entry.
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { LimsError } from '../../../../core/errors.js';
import { createBillingEvents } from '../../events/publish.js';
import { createBillingCommandPort } from '../../ports/BillingCommandPort.impl.js';
import { createCounterService } from '../../service/counter.service.js';
import { manifest } from '../../index.js';
import { appTx } from '../../../frontdesk/__tests__/integration/helpers.js';
import { ADMIN_A, CENTRE, NOW, T, TENANT_A, TENANT_B, SYS_ACTOR, dbRows, fire, mkCreditParty, mkInvoice, mkSetting, ok, req, superTx, uid, wipe } from '../../../partners/__tests__/partyset/helpers.js';

const TODAY = new Date('2026-11-18T00:00:00Z');   // NOW = 2026-11-17T20:30Z = 2026-11-18 in Asia/Kathmandu
const minusDays = (n: number): string => new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const PAY_DAYS = 30, BLOCK = 60, WARN = 45;
const issuedAt = (overdue: number) => `${minusDays(PAY_DAYS + overdue)}T06:00:00.000Z`;   // 11:45 Asia/Kathmandu of that date

interface Party { id: string }
async function party(tenant = TENANT_A, setting: Record<string, unknown> | null = {}): Promise<Party> {
  const cp = await mkCreditParty(tenant);
  await superTx(async (tx) => {
    await tx.query('INSERT INTO billing.credit_accounts (tenant_id, credit_party_id, party_code, party_display_name, credit_limit_paisa, credit_days, created_by, updated_by) VALUES ($1,$2,$3,$4,50000000,30,$5,$5)',
      [tenant, cp.id, cp.party_code, cp.name, SYS_ACTOR]);
  }, tenant);
  if (setting !== null) await mkSetting(tenant, 'credit_party', cp.id, { invoice_payment_days: PAY_DAYS, invoice_blocking_days: BLOCK, invoice_warning_days: WARN, auto_block_overdue: true, ...setting });
  return cp;
}
const account = (tenant: string, id: string) => superTx(async (tx) => (await tx.query('SELECT * FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2', [tenant, id])).rows[0], tenant);

/** BillingCommandPort.assertCreditAllowed over the real repo; like the core pipeline a handler that called commitOnError keeps its tx when it throws */
async function check(p: Party, tenant = TENANT_A, additional = 100): Promise<{ result?: unknown; error?: unknown }> {
  const port = createBillingCommandPort({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) });
  return appTx(tenant, async (raw: any) => {
    let keep = false;
    const ctx: any = {
      tenantId: tenant, tx: { startedAt: NOW, query: (t: string, v?: unknown[]) => raw.query(t, v) }, now: () => NOW.toISOString(), requestId: uid(), centreId: CENTRE[tenant === TENANT_B ? 'b' : 'a'],
      actor: { type: 'user', id: ADMIN_A.userId, membershipId: ADMIN_A.membershipId }, commitOnError: () => { keep = true; }, log: { info() {}, warn() {}, error() {}, debug() {} }, metrics: { inc() {} },
      ports: { CatalogPort: { getCreditParty: async () => ({ id: p.id, code: 'SYN', name: 'Synthetic Party', allowsCredit: true, isActive: true }) },
        IdentityPort: { getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu' }) } },
    };
    try { return { result: await port.assertCreditAllowed(ctx, { creditPartyId: p.id, additional: { amountPaisa: additional, currency: 'NPR' } }) }; }
    catch (error) { if (keep) return { error }; throw error; }
  }).catch((error) => ({ error }));
}
const settle = (invoiceId: string) => superTx(async (tx) => { await tx.query("SET LOCAL session_replication_role = 'replica'", []); await tx.query('UPDATE billing.invoices SET credited_total_paisa = net_paisa WHERE id = $1', [invoiceId]); });
const codeOf = (e: unknown) => (e instanceof LimsError ? (e as any).code : undefined);

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

describe('blocking: invoice_blocking_days past the due date, auto_block_overdue on', () => {
  it('at blocking_days past due: credit billing is refused (billing.credit_party_locked) and the existing block flag is set with a visible reason', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(BLOCK));
    const r = await check(p);
    expect(codeOf(r.error), String((r.error as any)?.message)).toBe('billing.credit_party_locked');
    const acc = await account(TENANT_A, p.id);
    expect(acc.is_locked).toBe(true);
    expect(typeof acc.lock_reason_code).toBe('string');
    expect(acc.lock_reason_code.length).toBeGreaterThan(0);
    expect(acc.locked_at).toBeTruthy();
  }, T);
  it('the reason is visible in getCreditAccount (B19) and the party stays blocked on the next check', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(BLOCK + 10));
    await check(p);
    const a = ok(await fire('getCreditAccount', req({ params: { credit_party_id: p.id } }), { ...ADMIN_A, grants: ['billing.credit_party.read'] }, { manifest: manifest as never }));
    expect(a).toMatchObject({ is_locked: true });
    expect(a.lock_reason_code).toBeTruthy();
    expect(codeOf((await check(p)).error)).toBe('billing.credit_party_locked');
  }, T);
  it('one day before the blocking day: not blocked, flag untouched', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(BLOCK - 1));
    const r = await check(p);
    expect(r.error).toBeUndefined();
    expect((await account(TENANT_A, p.id)).is_locked).toBe(false);
  }, T);
  it('auto_block_overdue off (or no setting at all = default): never blocked however old the invoice is', async () => {
    const off = await party(TENANT_A, { auto_block_overdue: false }); await mkInvoice(TENANT_A, off.id, 100_000, issuedAt(300));
    expect((await check(off)).error).toBeUndefined();
    const none = await party(TENANT_A, null); await mkInvoice(TENANT_A, none.id, 100_000, issuedAt(300));
    expect((await check(none)).error).toBeUndefined();
    expect((await account(TENANT_A, off.id)).is_locked).toBe(false);
    expect((await account(TENANT_A, none.id)).is_locked).toBe(false);
  }, T);
  it('a paid invoice does not count; one still unpaid overdue invoice among paid ones does', async () => {
    const p = await party();
    const paid = await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(BLOCK + 30)); await settle(paid.id);
    expect((await check(p)).error).toBeUndefined();
    await mkInvoice(TENANT_A, p.id, 50_000, issuedAt(BLOCK));
    expect(codeOf((await check(p)).error)).toBe('billing.credit_party_locked');
  }, T);
  it('the blocking days of THIS party apply; another party of the same tenant and the same party id seen by another tenant are not blocked', async () => {
    const a = await party(); const b = await party();
    await mkInvoice(TENANT_A, a.id, 100_000, issuedAt(BLOCK + 5));
    expect(codeOf((await check(a)).error)).toBe('billing.credit_party_locked');
    expect((await check(b)).error).toBeUndefined();
    expect((await account(TENANT_A, b.id)).is_locked).toBe(false);
    const x = await party(TENANT_B, { auto_block_overdue: true });
    expect((await check(x, TENANT_B)).error).toBeUndefined();
  }, T);
  it('an existing manual lock keeps its own reason (the automatic rule never rewrites it)', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(BLOCK + 5));
    await superTx(async (tx) => { await tx.query("UPDATE billing.credit_accounts SET is_locked = true, lock_reason_code = 'manual', locked_at = now(), locked_by = $3 WHERE tenant_id = $1 AND credit_party_id = $2", [TENANT_A, p.id, SYS_ACTOR]); }, TENANT_A);
    await check(p);
    expect((await account(TENANT_A, p.id)).lock_reason_code).toBe('manual');
  }, T);
  it('a longer blocking period of another setting value is honoured (blocking 120: 100 days overdue is not blocked, 120 is)', async () => {
    const p = await party(TENANT_A, { invoice_blocking_days: 120, invoice_warning_days: 100 }); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(100));
    expect((await check(p)).error).toBeUndefined();
    await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(120));
    expect(codeOf((await check(p)).error)).toBe('billing.credit_party_locked');
  }, T);
});

describe('warning: invoice_warning_days', () => {
  it('between the warning day and the blocking day the check passes and returns a warning with the days overdue', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(WARN + 3));
    const r = await check(p);
    expect(r.error).toBeUndefined();
    const w = (r.result as any)?.warnings;
    expect(Array.isArray(w) && w.length >= 1, `no warnings in ${JSON.stringify(r.result)}`).toBe(true);
    expect(w[0]).toMatchObject({ days_overdue: WARN + 3 });
    expect(typeof w[0].code).toBe('string');
    expect((await account(TENANT_A, p.id)).is_locked).toBe(false);
  }, T);
  it('before the warning day there is no warning (the result stays undefined: existing callers see no change)', async () => {
    const p = await party(); await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(WARN - 1));
    const r = await check(p);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeUndefined();
  }, T);
  it('a party without a setting row, or with nothing unpaid, gets no warning', async () => {
    const none = await party(TENANT_A, null); await mkInvoice(TENANT_A, none.id, 100_000, issuedAt(WARN + 20));
    expect((await check(none)).result).toBeUndefined();
    const paid = await party(); const inv = await mkInvoice(TENANT_A, paid.id, 100_000, issuedAt(WARN + 20)); await settle(inv.id);
    expect((await check(paid)).result).toBeUndefined();
  }, T);
});

describe('interest: a statement line only, never posted', () => {
  const stmt = (p: Party, who = ADMIN_A) => fire('getCreditPartyStatement', req({ params: { credit_party_id: p.id }, query: { from_month: '2026-01', to_month: '2026-12' } }), { ...who, grants: ['billing.credit_party.read'] }, { manifest: manifest as never });
  const interestValues = (o: unknown): number[] => {
    const out: number[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
      else if (/interest/i.test(key) && typeof v === 'number') out.push(v);
    };
    walk(o);
    return out;
  };
  it('floor(unpaid net x bp per day x days overdue / 10000) appears on the statement; closing balances are unchanged by it', async () => {
    const p = await party(TENANT_A, { interest_bp_per_day: 5 }); const overdue = 10;
    await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(overdue));
    const withInterest = ok(await stmt(p));
    const expected = Math.floor((100_000 * 5 * overdue) / 10_000);   // 500 paisa
    expect(interestValues(withInterest), JSON.stringify(withInterest)).toContain(expected);
    const zero = await party(TENANT_A, { interest_bp_per_day: 0 }); await mkInvoice(TENANT_A, zero.id, 100_000, issuedAt(overdue));
    const plain = ok(await stmt(zero));
    expect(interestValues(plain).every((v) => v === 0)).toBe(true);
    expect(withInterest.rows.map((r: any) => r.closing_balance)).toEqual(plain.rows.map((r: any) => r.closing_balance));
  }, T);
  it('never posts: reading the statement (twice) creates no ledger entry, no account ledger entry, no credit charge and no invoice', async () => {
    const p = await party(TENANT_A, { interest_bp_per_day: 100 });
    await mkInvoice(TENANT_A, p.id, 100_000, issuedAt(40));
    const count = async () => [(await dbRows('billing.ledger_entries', 'tenant_id = $1', [TENANT_A])).length, (await dbRows('billing.account_ledger_entries', 'tenant_id = $1', [TENANT_A])).length,
      (await dbRows('billing.credit_charges', 'tenant_id = $1', [TENANT_A])).length, (await dbRows('billing.invoices', 'tenant_id = $1', [TENANT_A])).length];
    const before = await count();
    const a = await stmt(p); const b = await stmt(p);
    expect(ok(a)).toEqual(ok(b));
    expect(a.probe.writes.filter((s) => !/audit|access_log/i.test(s))).toEqual([]);
    expect(await count()).toEqual(before);
  }, T);
  it('interest of another tenant\'s party never shows (common.not_found)', async () => {
    const p = await party(TENANT_A, { interest_bp_per_day: 5 });
    const o = await stmt(p, { ...ADMIN_A, tenant: TENANT_B } as never);
    expect(o.reply).toBeUndefined();
    expect(codeOf(o.error)).toBe('common.not_found');
  }, T);
});
