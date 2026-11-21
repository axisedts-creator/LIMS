// T0B-ACCT-2 (LD-313) static pins, no database: the 12 operations exist in the contract with the permission / idempotency / error codes the core pipeline enforces
// (permission-denied is the pipeline's job, so the entries it reads are pinned here), the permission rows stay as T0C-ACCT-1 wrote them, every handler is real and fails closed,
// none of the 12 ids is left in billing pendingOperations (LD-325 b), and the sources never DELETE an expense or a cash transfer, never UPDATE the append only ledger,
// and never use float math or a sequence for money / numbering.
// Fails now: the handlers do not exist and the 12 ids are still pending.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const load = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const perms = load('contracts/permissions.yaml');
const api = load('contracts/openapi/billing.yaml');
const ops: Record<string, any> = {};
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops[op.operationId] = { ...op, method, path };
const perm = (code: string) => (perms.permissions as any[]).find((p) => p.code === code);

// operationId, method, path, x-permission, x-idempotency
const EXPECT: Array<[string, string, string, string, string]> = [
  ['listExpenseTypes', 'get', '/v1/billing/expense-types', 'billing.account.read', 'none'],
  ['createExpenseType', 'post', '/v1/billing/expense-types', 'billing.account.manage', 'required'],
  ['updateExpenseType', 'patch', '/v1/billing/expense-types/{expense_type_id}', 'billing.account.manage', 'optional'],
  ['createExpense', 'post', '/v1/billing/expenses', 'billing.expense.manage', 'required'],
  ['listExpenses', 'get', '/v1/billing/expenses', 'billing.account.read', 'none'],
  ['cancelExpense', 'post', '/v1/billing/expenses/{expense_id}/cancel', 'billing.expense.manage', 'required'],
  ['createCashTransfer', 'post', '/v1/billing/cash-transfers', 'billing.cash_transfer.manage', 'required'],
  ['listCashTransfers', 'get', '/v1/billing/cash-transfers', 'billing.account.read', 'none'],
  ['acceptCashTransfer', 'post', '/v1/billing/cash-transfers/{cash_transfer_id}/accept', 'billing.cash_transfer.decide', 'required'],
  ['rejectCashTransfer', 'post', '/v1/billing/cash-transfers/{cash_transfer_id}/reject', 'billing.cash_transfer.decide', 'required'],
  ['cancelCashTransfer', 'post', '/v1/billing/cash-transfers/{cash_transfer_id}/cancel', 'billing.cash_transfer.manage', 'required'],
  ['getDailyCollectionSummary', 'get', '/v1/billing/daily-collection-summary', 'billing.account.read', 'none'],
];

describe('operations -> permission mapping (T0C-ACCT-1 contract)', () => {
  for (const [id, method, path, permission, idempotency] of EXPECT) {
    it(`${id}: ${method.toUpperCase()} ${path} needs ${permission}, idempotency ${idempotency}, tenant context`, () => {
      expect(ops[id], `${id} missing from contracts/openapi/billing.yaml`).toBeDefined();
      expect(ops[id]).toMatchObject({ method, path, 'x-permission': permission, 'x-idempotency': idempotency, 'x-context': 'tenant' });
      expect(ops[id]['x-error-codes']).toEqual(expect.arrayContaining(['auth.forbidden', 'auth.unauthenticated', 'common.validation_failed']));
      expect(perm(permission), `${permission} missing from permissions.yaml`).toBeDefined();
    });
  }
  it('decisions and cancels declare common.immutable_record; every post needs an Idempotency-Key; the update needs If-Match', () => {
    for (const id of ['cancelExpense', 'acceptCashTransfer', 'rejectCashTransfer', 'cancelCashTransfer']) expect(ops[id]['x-error-codes'], id).toContain('common.immutable_record');
    for (const [id] of EXPECT.filter((e) => e[1] === 'post')) expect(ops[id]['x-idempotency'], id).toBe('required');
    expect(ops['updateExpenseType']['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
  });
});

describe('permission rows (privileged = aal2; accept / reject is its own permission, separate from request / cancel)', () => {
  it('accept and reject need billing.cash_transfer.decide (privileged, finance); request and cancel need billing.cash_transfer.manage; expenses need billing.expense.manage', () => {
    expect(perm('billing.cash_transfer.decide')).toMatchObject({ privileged: true });
    expect(perm('billing.cash_transfer.decide').roles).toContain('finance');
    expect(perm('billing.cash_transfer.decide').code).not.toBe(perm('billing.cash_transfer.manage').code);
    expect(perm('billing.cash_transfer.manage').roles).toContain('finance');
    expect(perm('billing.expense.manage').roles).toContain('finance');
  });
  it('front_desk, phlebotomist and every lab role hold none of the expense / cash transfer permissions', () => {
    for (const c of ['billing.expense.manage', 'billing.cash_transfer.manage', 'billing.cash_transfer.decide']) {
      for (const r of ['front_desk', 'phlebotomist', 'centre_staff', 'lab_technologist', 'pathologist', 'lab_manager']) expect(perm(c).roles, `${c} ${r}`).not.toContain(r);
    }
  });
  it('no permission code was renamed or removed: all three exist exactly once (the corp_admin pack enumeration is covered by the T0C role-packs test)', () => {
    for (const c of ['billing.expense.manage', 'billing.cash_transfer.manage', 'billing.cash_transfer.decide']) expect((perms.permissions as any[]).filter((p) => p.code === c)).toHaveLength(1);
  });
});

describe('handlers are real and wired (LD-325 b: the task removes its own ids from billing pendingOperations)', () => {
  for (const [id] of EXPECT) {
    it(`${id}: registered, not pending, not the 503 stub, fails closed with auth.unauthenticated when the request context is missing`, async () => {
      expect(manifest.pendingOperations ?? [], `${id} must be removed from pendingOperations`).not.toContain(id);
      const h = (handlers as any)[id];
      expect(typeof h, `${id} handler`).toBe('function');
      const err: any = await h({ params: {}, query: {}, headers: {}, body: {} }, {}).then(() => undefined, (e: any) => e);
      expect(err?.code, String(err?.message)).toBe('auth.unauthenticated');
    });
  }
  it('no edit or delete operation exists for expenses or cash transfers in the contract', () => {
    for (const id of Object.keys(ops)) expect(id, id).not.toMatch(/^(delete|remove|update)(Expense|CashTransfer)$/);
    for (const p of Object.keys(api.paths)) if (/\/(expenses|cash-transfers)/.test(p)) for (const m of Object.keys(api.paths[p])) expect(m, `${m} ${p}`).not.toBe('delete');
  });
});

describe('source rules (done_when 2, 3, 5)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const sources = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p);
    return /\.ts$/.test(f) ? [p] : [];
  });
  const mine = sources(dir).filter((f) => /billing\.(expenses|cash_transfers|expense_types)\b/i.test(readFileSync(f, 'utf8')));
  it('the expense / transfer sources exist and never DELETE or TRUNCATE an expense, an expense type or a cash transfer', () => {
    expect(mine.length).toBeGreaterThan(0);
    for (const f of mine) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\bDELETE\s+FROM\s+billing\.(expenses|cash_transfers|expense_types)\b/i);
      expect(src, f).not.toMatch(/\bTRUNCATE\b[^;`'"]*(expenses|cash_transfers|expense_types)/i);
    }
  });
  // T0B-FINCTRL-1 ruling (TESTS_WRONG): hold / release (T0C-FINCTRL-1, LD-321) legitimately UPDATE the ledger status + hold columns; nothing else may be written.
  const HOLD_COLUMNS = ['status', 'held_reason', 'held_by', 'held_at', 'released_by', 'released_at', 'last_modified_by', 'updated_at'];
  it('any UPDATE of the account ledger names only the hold / release columns; no sequence, no float math on money in the expense / transfer sources', () => {
    for (const f of [...mine, ...sources(dir).filter((x) => /account_ledger_entries/i.test(readFileSync(x, 'utf8')))]) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bUPDATE\s+billing\.account_ledger_entries\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|`|$)/gi)) {
        const cols = [...m[1]!.matchAll(/(?:^|,)\s*"?([a-z_]+)"?\s*=(?!=)/gi)].map((c) => c[1]!.toLowerCase());
        expect(cols.length, `${f}: unparsable SET list ${m[1]}`).toBeGreaterThan(0);
        for (const c of cols) expect(HOLD_COLUMNS, `${f}: UPDATE of ledger column ${c}`).toContain(c);
      }
      expect(src, f).not.toMatch(/nextval|CREATE\s+SEQUENCE/i);
      expect(src, f).not.toMatch(/parseFloat|\.toFixed\(|Math\.(round|floor|ceil)\([^)]*paisa/i);
    }
  });
  it('the decision race is closed in SQL: the transfer row is locked or updated with a status = pending guard, never read-then-write unguarded', () => {
    const src = mine.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(/FOR\s+UPDATE/i.test(src) || /status\s*=\s*'pending'/i.test(src), 'cash_transfers update must be guarded (FOR UPDATE or WHERE status = pending)').toBe(true);
  });
  it('no source logs or audits the free text (remark, description, reason_text)', () => {
    for (const f of mine) expect(readFileSync(f, 'utf8'), f).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(remark|description|reason_text)/is);
  });
});
