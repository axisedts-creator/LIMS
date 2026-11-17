// BL-T03 static guards over billing/repository/*.repo.ts (05-SCHEMA §5 + §9 tests 3/4/6; 07-SECURITY REQ-SEC-057; US-BL-02.1/.2).
// The DB refuses what these files must never even try: lims_app has no DELETE anywhere (except billing.export_jobs), no UPDATE on the
// append-only tables, and only the lifecycle columns on billing.invoices. Fails now: the repository files do not exist yet.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// 02-TRD §3.2 repository/ listing, verbatim.
const REQUIRED = ['invoices', 'invoiceLines', 'creditNotes', 'counters', 'ledger', 'balances', 'overrides', 'cashSessions', 'creditAccounts',
  'creditCharges', 'printLog', 'activity', 'cbms', 'exports', 'settings', 'creditNoteTasks'].map((n) => `${n}.repo.ts`);
// 05-SCHEMA §5 / §9.4: "no grant" UPDATE tables of billing.
const APPEND_ONLY = ['invoice_lines', 'credit_note_lines', 'ledger_entries', 'print_log', 'activity_log', 'cbms_submissions', 'release_overrides', 'payment_intent_refs'];
// 05-SCHEMA §3 invoices__mutable_columns trigger list.
const INVOICE_MUTABLE = new Set(['status', 'is_active', 'cancelled_at', 'cancelled_by', 'cancel_reason_code', 'cancel_reason_text', 'credit_note_id',
  'credited_total_paisa', 'print_count', 'last_printed_at', 'cbms_state', 'cbms_attempts', 'cbms_last_attempt_at', 'cbms_synced_at', 'cbms_external_ref',
  'cbms_cancel_state', 'cbms_cancel_attempts', 'cbms_cancel_last_attempt_at', 'cbms_cancel_synced_at', 'cbms_cancel_external_ref',
  'updated_at', 'updated_by', 'version']);

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');
const files = () => (existsSync(repoDir) ? readdirSync(repoDir).filter((f) => f.endsWith('.repo.ts')) : []);
const src = (f: string) => strip(readFileSync(join(repoDir, f), 'utf8'));
const all = () => files().map((f) => [f, src(f)] as const);

describe('repository files exist (02-TRD §3.2)', () => {
  for (const f of REQUIRED) it(`${f} exists and exports at least one function taking tx first`, () => {
    expect(files()).toContain(f);
    expect(src(f)).toMatch(/export\s+(async\s+)?function\s+\w+\s*\(\s*tx\b/);
  });
});

describe('no DELETE, no UPDATE on append-only tables (US-BL-02.2, §9.3/.4, REQ-SEC-057)', () => {
  it('DELETE FROM appears only in exports.repo.ts and only against billing.export_jobs', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const [f, s] of all()) {
      for (const m of s.matchAll(/\bDELETE\s+FROM\s+([\w.]+)/gi)) {
        expect([f, m[1]!.toLowerCase()], `${f} deletes from ${m[1]}`).toEqual(['exports.repo.ts', 'billing.export_jobs']);
      }
    }
  });
  it('no TRUNCATE / DROP / ALTER / CREATE statements', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const [f, s] of all()) expect(s, f).not.toMatch(/\b(TRUNCATE|DROP\s+(TABLE|TRIGGER|POLICY)|ALTER\s+(TABLE|FUNCTION|POLICY)|CREATE\s+(TABLE|TRIGGER|FUNCTION))\b/i);
  });
  it.each(APPEND_ONLY)('nothing issues UPDATE billing.%s (reversals are new rows)', (t) => {
    expect(files().length).toBeGreaterThan(0);
    for (const [f, s] of all()) expect(s, f).not.toMatch(new RegExp(`\\bUPDATE\\s+billing\\.${t}\\b`, 'i'));
  });
  it('ledger.repo.ts writes ledger_entries only with INSERT', () => {
    const s = src('ledger.repo.ts');
    expect(s).toMatch(/INSERT\s+INTO\s+billing\.ledger_entries/i);
    expect(s).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+billing\.ledger_entries/i);
  });
});

describe('invoices only change lifecycle columns (US-BL-02.1, §3 invoices__mutable_columns)', () => {
  const sets = () => [...src('invoices.repo.ts').matchAll(/\bUPDATE\s+billing\.invoices\s+SET\b([\s\S]*?)(\bWHERE\b|\bRETURNING\b|`)/gi)].map((m) => m[1]!);
  it('has lifecycle UPDATEs, each assigning only columns from the mutable list', () => {
    const stmts = sets();
    expect(stmts.length).toBeGreaterThan(0);
    for (const clause of stmts) {
      const cols = [...clause.matchAll(/(?:^|[,\s])([a-z_][a-z0-9_]*)\s*=(?!=)/gi)].map((m) => m[1]!.toLowerCase());
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) expect(INVOICE_MUTABLE.has(c), `invoices.repo.ts assigns ${c}`).toBe(true);
    }
  });
  it('never touches money, number or buyer/seller columns', () => {
    const s = src('invoices.repo.ts');
    expect(s).not.toMatch(/\bSET\b[^`;]*\b(net_paisa|gross_paisa|vat_paisa|discount_paisa|taxable_paisa|exempt_paisa|invoice_no|invoice_seq|buyer_name|seller_name|issued_at|series)\s*=/is);
  });
});

describe('gapless counter (BL-T04 depends on it; guard fiscal_counters_guard: last_no = old or old + 1)', () => {
  it('counters.repo.ts only ever sets last_no = last_no + 1', () => {
    const s = src('counters.repo.ts');
    expect(s).toMatch(/\bSET\b[^`;]*\blast_no\s*=\s*last_no\s*\+\s*1\b/is);
    expect(s).not.toMatch(/\bSET\b[^`;]*?\blast_no\s*=(?!\s*last_no\s*\+\s*1\b)/is);
    expect(s).not.toMatch(/\bSET\b[^`;]*\blast_no\s*=\s*last_no\s*\+\s*([2-9]|\$)/is);
    expect(s).not.toMatch(/\bDELETE\b/i);
  });
});

describe('bound values, tenant context from the tx facade only', () => {
  it('no ${…} interpolation inside any SQL template literal', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const [f, s] of all()) {
      for (const m of s.matchAll(/`([^`]*)`/g)) {
        if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(m[1]!)) expect(m[1], `${f} interpolates into SQL`).not.toMatch(/\$\{/);
      }
    }
  });
  it('no driver import, no role/RLS/GUC games', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const [f, s] of all()) {
      expect(s, f).not.toMatch(/from\s+['"]pg['"]|new\s+Pool\b|\.connect\s*\(/);
      expect(s, f).not.toMatch(/set_config|SET\s+(LOCAL\s+)?ROLE|session_authorization|row_level_security|bypassrls|app\.maintenance|SECURITY\s+DEFINER/i);
    }
  });
});
