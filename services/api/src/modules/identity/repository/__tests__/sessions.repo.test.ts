// T4 repository/sessions.repo.ts — DEFINER-only access (05-SCHEMA §6 / §5.4; 08 A10.5, A12.1, A15.1) + manifest registration (CR-C2-005).
// ASSUMED API: export async function resolveSessionRow(tx: { query(text, values?): Promise<{ rows: any[] }> }, gotrueSessionId: string, sub: string):
//   Promise<Row | undefined>  — runs exactly ONE statement `SELECT … FROM app.identity_resolve_session($1::uuid, $2::uuid)` with values [gotrueSessionId, sub]
//   and returns the first row (columns verbatim, snake_case) or undefined.
// FORCE RLS on every table the DEFINER reads + the owner policies / app.pre_* GUCs (incl. app.pre_support_session_id) are proven at SQL level by the existing
// pgTAP suites db/tests/identity/T0B-10.C2_lookups.test.sql (§11 tests 22, 24), T0B-10.C2_policies.test.sql and db/tests/definers/*; this file proves the
// app side never bypasses them (no direct table read, no GUC set by the app) and that the manifest registers the resolver.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveSessionRow } from '../sessions.repo.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const SUB = '01a1a98a-ac40-7000-8000-00000000a300', SID = '01a1a98a-ac40-7000-8000-00000000a301';
const fakeTx = (rows: unknown[]) => {
  const calls: { text: string; values?: unknown[] }[] = [];
  return { calls, tx: { async query(text: string, values?: unknown[]) { calls.push({ text, values }); return { rows }; } } };
};

describe('resolveSessionRow', () => {
  it('runs one parameterised call to app.identity_resolve_session with [gotrue session id, sub]', async () => {
    const { tx, calls } = fakeTx([{ session_id: 's' }]);
    await resolveSessionRow(tx as never, SID, SUB);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/app\.identity_resolve_session\s*\(\s*\$1(::uuid)?\s*,\s*\$2(::uuid)?\s*\)/);
    expect(calls[0]!.values).toEqual([SID, SUB]);
  });
  it('returns the first row, or undefined when the DEFINER returns none', async () => {
    expect(await resolveSessionRow(fakeTx([{ session_id: 'a' }, { session_id: 'b' }]).tx as never, SID, SUB)).toEqual({ session_id: 'a' });
    expect(await resolveSessionRow(fakeTx([]).tx as never, SID, SUB)).toBeUndefined();
  });
  it('values are bound, never interpolated (hostile ids leave the SQL text unchanged)', async () => {
    const a = fakeTx([]), b = fakeTx([]);
    await resolveSessionRow(a.tx as never, SID, SUB);
    await resolveSessionRow(b.tx as never, "x'); DROP TABLE identity.sessions;--", "y' OR '1'='1");
    expect(b.calls[0]!.text).toBe(a.calls[0]!.text);
    expect(b.calls[0]!.text).not.toMatch(/DROP|OR '1'/);
  });
  it('DB errors propagate', async () => {
    const tx = { async query() { throw new Error('boom'); } };
    await expect(resolveSessionRow(tx as never, SID, SUB)).rejects.toThrow('boom');
  });
});

describe('static: the repo reaches identity tables only through the DEFINER (FORCE RLS stays on for lims_api)', () => {
  const src = read('../sessions.repo.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  it('no direct FROM/JOIN/UPDATE/INSERT/DELETE on identity.* or core.* tables', () => {
    expect(src).not.toMatch(/\b(from|join|update|into|delete\s+from)\s+(identity|core|audit)\./i);
  });
  it('does not set app.pre_* / app.maintenance GUCs itself (only the DEFINER may; 05-SCHEMA §5.4, §11 test 24)', () => {
    expect(src).not.toMatch(/app\.pre_|app\.maintenance|set_config/i);
  });
  it('is not a SECURITY-bypass: no role switching or RLS toggling', () => {
    expect(src).not.toMatch(/set\s+(local\s+)?role|session_authorization|row_level_security|bypassrls/i);
  });
});

describe('manifest registration (done_when: "registered in manifest"; 02-TRD §3.2, CR-C2-005)', () => {
  const idx = read('../../index.ts');
  it('modules/identity/index.ts imports the resolver and sets manifest.claimsResolver', () => {
    expect(idx).toMatch(/from\s+['"]\.\/claims\/resolver\.js['"]/);
    expect(idx).toMatch(/claimsResolver\s*[:,]/);
  });
  it('resolver.ts is the only claims source: it does not read JWT claims for tenant/role data', () => {
    const r = read('../../claims/resolver.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(r).not.toMatch(/jwt\.(tenant|tenant_id|role|app_metadata|user_metadata)\b/);
  });
});
