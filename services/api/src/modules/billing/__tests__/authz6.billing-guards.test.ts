// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the 80 billing operations that the classifier snapshot
// shows as `unguarded` (70) or `guarded-other` (10: the "billing reprint" rows, where the classifier saw billing.invoice.reprint in code reachable from
// invoice.service.ts although the read, cancel and credit-note paths never assert it; 8 sit in REPRINT_ROWS, cancelInvoice and issuePartialCreditNote
// are listed with the first group). Each handler is called directly (the central
// stage 8a is NOT in play; LIMS_CORE_AUTHZ_MODE stays shadow), so what is proven is the handler's OWN guard:
//   ctx.ports.IdentityPort.assertRole(ctx, { permission })  BEFORE any data is read or written (tx, events, services).
// Pinned interface (same as SEC-AUTHZ-5 catalog): it is the FIRST thing a handler does (before validation, Idempotency-Key, If-Match, tx, events); it throws
// LimsError auth.forbidden | auth.mfa_required | identity.support_session_required and the handler lets that through unchanged (no new error code);
// a context without IdentityPort.assertRole fails closed (a LimsError, nothing read).
// Expected permission = the operation's contract x-permission, unless the operation is in services/api/src/core/pipeline/authz-exceptions.json (then its
// handlerPermission) or is named in a SEC-AUTHZ-6 change request (.orchestra/cr/SEC-AUTHZ-6*.md: wrong contract x-permission, for the contract owner).
// R2 of the role matrix: refund request / approve, payment reverse, invoice cancel and discount approval keep their authority rules (second-person checks,
// ceilings, privileged aal2) and their existing tests; this guard only adds the permission floor in front of them. Nothing is widened: no contract,
// permission registry, role pack or SQL file changes (the reviewer reads the git diff). Synthetic data only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'billing.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) if (op && typeof op === 'object' && op.operationId && op['x-permission']) xPerm[op.operationId] = op['x-permission'];
}
const packs: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const roleGrants = new Map<string, Set<string>>();
for (const p of packs.permissions as Array<{ code: string; roles?: string[] }>) for (const r of p.roles ?? []) (roleGrants.get(r) ?? roleGrants.set(r, new Set()).get(r)!).add(p.code);
const holders = (perm: string): string[] => (packs.permissions as Array<{ code: string; roles?: string[] }>).find((p) => p.code === perm)?.roles ?? [];

const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-6.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';

// Snapshot at the start of SEC-AUTHZ-6 (tests/security/authz-classification.json, module billing): class unguarded (70).
export const UNGUARDED_BILLING = [
  'cancelInvoice', 'issuePartialCreditNote', 'requestRefund', 'createReleaseOverride', 'getReleaseEligibility', 'reverseLedgerEntry', 'listLedgerEntries',
  'approveRefund', 'rejectRefund', 'listRefundRequests', 'listDues', 'getMyCashSession', 'closeCashSession', 'getDailyCash', 'listCreditAccounts', 'getCreditAccount',
  'updateCreditAccount', 'listCreditCharges', 'issuePeriodicInvoice', 'recordCreditPartyPayment', 'getCreditPartyStatement', 'getSalesRegister',
  'getCancelledInvoiceRegister', 'getCreditNoteRegister', 'getAuditTrail', 'listCbmsDocuments', 'retryCbmsDocument', 'getBillingSettings', 'updateBillingSettings',
  'listBillingCodes', 'listFinanceReviewItems', 'resolveFinanceReviewItem', 'listAccountGroups', 'createAccountGroup', 'updateAccountGroup', 'listAccountParticulars',
  'createAccountParticular', 'updateAccountParticular', 'listExpenseTypes', 'createExpenseType', 'updateExpenseType', 'createAccountLedgerEntry',
  'listAccountLedgerEntries', 'getAccountLedgerEntry', 'reverseAccountLedgerEntry', 'getAccountStatement', 'getAccountSummary', 'createExpense', 'listExpenses',
  'cancelExpense', 'createCashTransfer', 'listCashTransfers', 'acceptCashTransfer', 'rejectCashTransfer', 'cancelCashTransfer', 'getDailyCollectionSummary',
  'listDiscountReasons', 'createDiscountReason', 'updateDiscountReason', 'listPartyDiscountSlabs', 'createPartyDiscountSlab', 'updatePartyDiscountSlab',
  'deactivatePartyDiscountSlab', 'resolveDiscountSlab', 'listUserDiscountLimits', 'setUserDiscountLimit', 'listDiscountAuthorities', 'createDiscountAuthority',
  'deactivateDiscountAuthority', 'getMyDiscountPolicy', 'holdLedgerEntry', 'releaseLedgerEntry',
] as const;
// class guarded-other: the classifier saw billing.invoice.reprint (the print paths of the same service file); the handler asserts nothing for these.
export const REPRINT_ROWS = [
  'listInvoices', 'getInvoice', 'listInvoicePrints', 'listCreditNotes', 'getCreditNote', 'getOrderBilling', 'listCreditNoteTasks', 'recordPayment',
] as const;
export const GROUP = [...UNGUARDED_BILLING, ...REPRINT_ROWS] as const;
// operations of the group that must keep their own authority rules after the floor (R2): the guard is asked first, the later rules may still deny.
const AUTHORITY = new Set(['requestRefund', 'approveRefund', 'rejectRefund', 'reverseLedgerEntry', 'cancelInvoice', 'issuePartialCreditNote', 'resolveFinanceReviewItem',
  'createDiscountAuthority', 'deactivateDiscountAuthority', 'setUserDiscountLimit', 'createCashTransfer', 'acceptCashTransfer', 'rejectCashTransfer', 'cancelCashTransfer',
  'createExpense', 'cancelExpense', 'reverseAccountLedgerEntry', 'createAccountLedgerEntry', 'createReleaseOverride', 'closeCashSession']);

const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined; // contract x-permission wrong: CR written, exactness not checked
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const anyKey = new Proxy({} as Record<string, string>, { get: (_t, p) => (typeof p === 'string' ? ID : undefined), has: () => true });
const req = { params: anyKey, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'k-authz6-0001' }, body: {} };

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  // any access to the transaction, the events port, jobs or audit counts as data access: a denied request must touch none of them.
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return p === 'query' ? query : vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => new Date('2026-11-19T00:00:00Z').toISOString(),
    tx: touch('tx'), events: touch('events'), jobs: touch('jobs'),
    ports: withPort ? { IdentityPort: { assertRole: assert } } : {}, audit: touch('audit'),
  };
  return { ctx, log, query, assert, asserted };
}
const run = async (op: string, ctx: any) => {
  try { await (handlers as Record<string, any>)[op](req, ctx); return undefined; } catch (e) { return e as any; }
};
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>, op: string) => expect(r.log.filter((x) => x !== 'assert'), `${op}: no data read or written before/without the guard`).toEqual([]);

describe('SEC-AUTHZ-6 billing: the snapshot list is real', () => {
  it('has 80 distinct operations, each in billing.yaml with a runtime handler and a billing.* x-permission', () => {
    expect(UNGUARDED_BILLING.length).toBe(72);
    expect(REPRINT_ROWS.length).toBe(8);
    expect(new Set(GROUP).size).toBe(80);
    for (const op of GROUP) {
      expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
      expect(xPerm[op], op).toMatch(/^billing\./);
    }
  });
});

describe('SEC-AUTHZ-6 billing: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, repository, events and audit spies not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r, op);
  });

  it.each(['auth.mfa_required', 'identity.support_session_required'])('refund, reverse, cancel, discount and read operations pass %s through unchanged (no new error code)', async (code) => {
    for (const op of ['approveRefund', 'requestRefund', 'reverseLedgerEntry', 'cancelInvoice', 'setUserDiscountLimit', 'listInvoices', 'recordPayment', 'getAccountStatement', 'updateBillingSettings']) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      noData(r, op);
    }
  });

  it('a failing IdentityPort (dependency down) fails closed: the handler rejects and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', async () => { throw new Error('identity store unavailable'); });
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject when assertRole fails`).toBeDefined();
      noData(r, op);
    }
  });

  it('no IdentityPort in the context fails closed: the handler rejects with a LimsError and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', denyAll(), false);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject without a port`).toBeInstanceOf(LimsError);
      noData(r, op);
    }
  });

  it('a user holding every billing permission EXCEPT the one needed is denied (no adjacent permission is enough; billing.invoice.reprint is not a read, cancel or payment permission)', async () => {
    const all = new Set([...Object.values(xPerm), ...exceptions.map((e) => e.handlerPermission), 'billing.invoice.reprint', 'billing.invoice.issue', 'billing.data.export']);
    for (const op of GROUP) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all].filter((p) => p !== want))));
      const err = await run(op, r.ctx);
      expect(err?.code, `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r, op);
    }
  });
});

describe('SEC-AUTHZ-6 billing: user with exactly the permission reaches the handler', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission; with exactly that grant the guard does not deny', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    if (want) expect(r.asserted[0], `${op} asks ${want} first`).toBe(want);
    // the later R2 authority rules (second person, ceiling, privileged aal2) may still deny: that is their own check, not this guard.
    if (want && !AUTHORITY.has(op)) {
      expect(new Set(r.asserted), `${op} asks exactly ${want}`).toEqual(new Set([want]));
      expect(err?.code, `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
    }
  });
});

describe('SEC-AUTHZ-6 billing: the billing reprint rows (7 reads + recordPayment) ask their own permission, not billing.invoice.reprint', () => {
  it.each(REPRINT_ROWS)('%s: holding only billing.invoice.reprint is not enough', async (op) => {
    const want = expectedPermission(op);
    if (want === 'billing.invoice.reprint') return; // exception row: covered by the role-matrix test below
    const r = rig('user', grantOnly(new Set(['billing.invoice.reprint'])));
    const err = await run(op, r.ctx);
    expect(err?.code, `${op} must be denied for a user who can only reprint`).toBe('auth.forbidden');
    noData(r, op);
  });
  it('printInvoice and printCreditNote keep asserting billing.invoice.reprint (not widened, not narrowed)', async () => {
    for (const op of ['printInvoice', 'printCreditNote']) {
      expect(xPerm[op]).toBe('billing.invoice.reprint');
      const r = rig('user', denyAll());
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe('auth.forbidden');
      expect(r.asserted[0], op).toBe('billing.invoice.reprint');
    }
  });
});

describe('SEC-AUTHZ-6 billing: the default role packs keep their billing reads and payments (nothing is widened, nothing is narrowed)', () => {
  const READS = GROUP.filter((op) => /\.(read|record)$/.test(xPerm[op] ?? '') && !AUTHORITY.has(op) && !exceptions.some((e) => e.operationId === op));
  it('the matrix covers front desk, finance, tenant admin and phlebotomist', () => {
    const roles = new Set(READS.flatMap((op) => holders(xPerm[op]!)));
    for (const role of ['front_desk', 'finance', 'tenant_admin', 'phlebotomist']) expect(roles.has(role), role).toBe(true);
    expect(READS.length).toBeGreaterThan(25);
  });
  for (const role of ['tenant_admin', 'front_desk', 'finance', 'phlebotomist', 'lab_manager']) {
    it(`${role}: every read or record operation whose x-permission the role holds is not denied by the handler's own guard`, async () => {
      const grants = roleGrants.get(role) ?? new Set<string>();
      for (const op of READS.filter((o) => grants.has(xPerm[o]!))) {
        const r = rig('user', grantOnly(grants));
        const err = await run(op, r.ctx);
        expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
        expect(err?.code, `${op} must work for ${role} (holds ${xPerm[op]})`).not.toBe('auth.forbidden');
      }
    });
  }
  it('recordPayment still works for a phlebotomist (billing.payment.record) who does not hold billing.invoice.reprint', async () => {
    const grants = roleGrants.get('phlebotomist') ?? new Set<string>();
    expect(grants.has('billing.payment.record')).toBe(true);
    expect(grants.has('billing.invoice.reprint')).toBe(false);
    const r = rig('user', grantOnly(grants));
    const err = await run('recordPayment', r.ctx);
    expect(err?.code).not.toBe('auth.forbidden');
  });
  it('an exception row is only for an operation whose handler really needs another permission: every role holding the x-permission also holds the handler permission', () => {
    for (const e of exceptions.filter((x) => (GROUP as readonly string[]).includes(x.operationId))) {
      for (const role of holders(xPerm[e.operationId]!)) {
        expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role} holds ${xPerm[e.operationId]} but not ${e.handlerPermission} (a role would lose access; correct the contract with a change request instead)`).toBe(true);
      }
    }
  });
});

describe('SEC-AUTHZ-6 billing: patient, partner and portal actors are denied on staff operations', () => {
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(GROUP)(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
      noData(r, op);
    });
  }
});

describe('SEC-AUTHZ-6 billing: refund, payment reverse, invoice cancel and discount approval keep their authority permissions (R2)', () => {
  it.each([
    ['requestRefund', 'billing.refund.request'], ['approveRefund', 'billing.refund.approve'], ['rejectRefund', 'billing.refund.approve'],
    ['reverseLedgerEntry', 'billing.payment.reverse'], ['cancelInvoice', 'billing.invoice.cancel'], ['issuePartialCreditNote', 'billing.invoice.cancel'],
    ['createDiscountAuthority', 'billing.discount_policy.manage'], ['setUserDiscountLimit', 'billing.discount_policy.manage'],
    ['resolveFinanceReviewItem', 'billing.refund.approve'], ['createReleaseOverride', 'billing.release.override'],
  ])('%s asks %s first and is denied without it (a holder of the neighbouring permissions is not enough)', async (op, perm) => {
    if (expectedPermission(op) !== perm) return; // exception or CR: covered by the matrix above
    const r = rig('user', grantOnly(new Set(['billing.invoice.reprint', 'billing.payment.record', 'billing.invoice.read', 'billing.discount_policy.read'])));
    const err = await run(op, r.ctx);
    expect(err?.code).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe(perm);
    noData(r, op);
  });
  it('the contract x-permission of those operations is what R2 says (the contract is not edited by this task)', () => {
    expect(xPerm['requestRefund']).toBe('billing.refund.request');
    expect(xPerm['approveRefund']).toBe('billing.refund.approve');
    expect(xPerm['reverseLedgerEntry']).toBe('billing.payment.reverse');
    expect(xPerm['cancelInvoice']).toBe('billing.invoice.cancel');
    expect(holders('billing.refund.approve')).toEqual(['finance']);
    expect(holders('billing.payment.reverse')).toEqual(['finance']);
    expect(holders('billing.invoice.cancel')).toEqual(['finance']);
  });
});

describe('SEC-AUTHZ-6 billing: stubs stay refusals (never a 2xx, never a read)', () => {
  // T0D-BUILD-1 (LD-447): listAccountSummaries is a real read handler now (guard order + no data before the guard: accounts/summaries.guard.test.ts); it leaves this stub list.
  it.each(['createPaymentIntent', 'verifyPaymentIntent'])('%s refuses and reads nothing', async (op) => {
    const h = (handlers as Record<string, any>)[op];
    if (typeof h !== 'function') return; // no handler registered: the core stub answers
    const r = rig('user', async () => undefined);
    const err = await run(op, r.ctx);
    expect(err, op).toBeInstanceOf(LimsError);
    noData(r, op);
  });
});
