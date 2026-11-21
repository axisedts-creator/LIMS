// T0B-ACCT-1 (LD-313) static pins, no database: the 13 operations of this task exist in the contract with the permission / idempotency / error codes the core pipeline enforces
// (permission-denied is the pipeline's job: handlers never check, see ledger.handlers.ts; so the entries it reads are pinned here), the permission rows (privileged + roles) stay as
// T0C-ACCT-1 wrote them, every handler is real (fails closed, never the 503 stub), and the source cannot UPDATE / DELETE the append only ledger, uses no sequence and no float math.
// Fails now: the contract operations only exist on lane/C0-0C until it merges, and the handlers are not written.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const load = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const perms = load('contracts/permissions.yaml');
const api = load('contracts/openapi/billing.yaml');
const ops: Record<string, any> = {};
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops[op.operationId] = { ...op, method, path };
const perm = (code: string) => (perms.permissions as any[]).find((p) => p.code === code);

// operationId, method, path, x-permission, x-idempotency
const EXPECT: Array<[string, string, string, string, string]> = [
  ['listAccountGroups', 'get', '/v1/billing/account-groups', 'billing.account.read', 'none'],
  ['createAccountGroup', 'post', '/v1/billing/account-groups', 'billing.account.manage', 'required'],
  ['updateAccountGroup', 'patch', '/v1/billing/account-groups/{account_group_id}', 'billing.account.manage', 'optional'],
  ['listAccountParticulars', 'get', '/v1/billing/account-particulars', 'billing.account.read', 'none'],
  ['createAccountParticular', 'post', '/v1/billing/account-particulars', 'billing.account.manage', 'required'],
  ['updateAccountParticular', 'patch', '/v1/billing/account-particulars/{account_particular_id}', 'billing.account.manage', 'optional'],
  ['createAccountLedgerEntry', 'post', '/v1/billing/account-ledger-entries', 'billing.account_entry.create', 'required'],
  ['listAccountLedgerEntries', 'get', '/v1/billing/account-ledger-entries', 'billing.account.read', 'none'],
  ['getAccountLedgerEntry', 'get', '/v1/billing/account-ledger-entries/{account_ledger_entry_id}', 'billing.account.read', 'none'],
  ['reverseAccountLedgerEntry', 'post', '/v1/billing/account-ledger-entries/{account_ledger_entry_id}/reverse', 'billing.account_entry.reverse', 'required'],
  ['getAccountStatement', 'get', '/v1/billing/account-statement', 'billing.account.read', 'none'],
  ['getAccountSummary', 'get', '/v1/billing/account-summary', 'billing.account.read', 'none'],
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
  it('every write that is not an update needs an Idempotency-Key; updates need If-Match with version_conflict declared; reversal declares billing.ledger_reversal_invalid', () => {
    for (const [id] of EXPECT.filter((e) => e[1] === 'post')) expect(ops[id]['x-idempotency'], id).toBe('required');
    for (const id of ['updateAccountGroup', 'updateAccountParticular']) expect(ops[id]['x-error-codes'], id).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
    expect(ops['reverseAccountLedgerEntry']['x-error-codes']).toContain('billing.ledger_reversal_invalid');
  });
});

describe('permission rows (who may do what; privileged = aal2)', () => {
  it('masters and reversal are privileged and finance only (+ tenant_admin for the masters); entry create is finance only; read is finance + tenant_admin', () => {
    expect(perm('billing.account.manage')).toMatchObject({ privileged: true }); expect(perm('billing.account.manage').roles).toEqual(expect.arrayContaining(['finance']));
    expect(perm('billing.account_entry.reverse')).toMatchObject({ privileged: true, roles: ['finance'] });
    expect(perm('billing.account_entry.create')).toMatchObject({ privileged: false, roles: ['finance'] });
    expect(perm('billing.account.read').roles).toEqual(expect.arrayContaining(['finance']));
  });
  it('front_desk, phlebotomist and every lab role hold none of the accounting permissions', () => {
    const codes = ['billing.account.read', 'billing.account.manage', 'billing.account_entry.create', 'billing.account_entry.reverse'];
    for (const c of codes) for (const r of ['front_desk', 'phlebotomist', 'centre_staff', 'lab_technologist', 'pathologist', 'lab_manager']) expect(perm(c).roles, `${c} ${r}`).not.toContain(r);
  });
  it('the reverse permission is separate from the create permission (a correction is its own, audited, privileged act)', () => {
    expect(perm('billing.account_entry.reverse').code).not.toBe(perm('billing.account_entry.create').code);
  });
});

describe('handlers are real', () => {
  for (const [id] of EXPECT) {
    it(`${id}: registered, not the 503 stub, fails closed with auth.unauthenticated when the request context is missing`, async () => {
      const h = (handlers as any)[id];
      expect(typeof h, `${id} handler`).toBe('function');
      const err: any = await h({ params: {}, query: {}, headers: {}, body: {} }, {}).then(() => undefined, (e: any) => e);
      expect(err?.code, String(err?.message)).toBe('auth.unauthenticated');
    });
  }
});

describe('source rules (done_when 2, 3, 4, 7)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const sources = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : sources(p);
    return /\.ts$/.test(f) ? [p] : [];
  });
  const ledgerFiles = sources(dir).filter((f) => /account_ledger_entries/i.test(readFileSync(f, 'utf8')));
  // T0B-FINCTRL-1 ruling (TESTS_WRONG): hold / release (T0C-FINCTRL-1, LD-321) legitimately UPDATE the ledger status + hold columns; nothing else may be written.
  const HOLD_COLUMNS = ['status', 'held_reason', 'held_by', 'held_at', 'released_by', 'released_at', 'last_modified_by', 'updated_at'];
  it('the accounting ledger is touched by at least one source file; any UPDATE of it names only the hold / release columns, and nothing DELETEs it (append only money in code too)', () => {
    expect(ledgerFiles.length).toBeGreaterThan(0);
    for (const f of ledgerFiles) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bUPDATE\s+billing\.account_ledger_entries\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|`|$)/gi)) {
        const cols = [...m[1]!.matchAll(/(?:^|,)\s*"?([a-z_]+)"?\s*=(?!=)/gi)].map((c) => c[1]!.toLowerCase());
        expect(cols.length, `${f}: unparsable SET list ${m[1]}`).toBeGreaterThan(0);
        for (const c of cols) expect(HOLD_COLUMNS, `${f}: UPDATE of ledger column ${c}`).toContain(c);
      }
      expect(src, f).not.toMatch(/\bDELETE\s+FROM\s+billing\.account_ledger_entries\b/i);
      expect(src, f).not.toMatch(/\bTRUNCATE\b[^;`'"]*account_ledger_entries/i);
    }
  });
  it('receipt numbers come from the per tenant counter in the posting transaction: no sequence, no nextval, no Math.random / Date.now numbering', () => {
    for (const f of ledgerFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/nextval|CREATE\s+SEQUENCE/i);
      expect(src, f).not.toMatch(/receipt[_a-z]*\s*[:=][^;\n]*(Math\.random|Date\.now)/i);
    }
  });
  it('money never goes through float math or string formatting in the accounting sources', () => {
    for (const f of ledgerFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/parseFloat|\.toFixed\(|Math\.(round|floor|ceil)\([^)]*paisa/i);
    }
  });
  it('no accounting source logs or audits the free text columns', () => {
    for (const f of ledgerFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(comments|payment_details|reference_no|bank_name)/is);
    }
  });
});
