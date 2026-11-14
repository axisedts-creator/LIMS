// C7 API-T07 — CI scripts (CR-C7-013; 02-TRD §16): driver-registry-check, synthetic-scan (AC-21.4), fixture-copy-check.
// Interface expected from the writer (each script module also works as a CLI, but its main() MUST NOT run on import — guard on import.meta.url;
// CLI exit code = result.ok ? 0 : 1; all functions may be sync or async, tests `await` them). Names are SEAM:
//   ../ci/driver-registry-check.ts : checkDriverRegistry({ drivers, migrationsDir }): { ok: boolean; problems: string[] }
//       drivers = [{ code, status, capabilities:{hostQuery,worklistDownload,qc,attachments,calibration} }] (as listDrivers()).
//       Rows come from every *.sql in migrationsDir (name order): `INSERT INTO instruments.g_drivers (cols) VALUES (...),(...)` honouring the column
//       list (omitted cap_* default false, is_active default true) and later `UPDATE instruments.g_drivers SET ... WHERE code = '<c>'`.
//       Problems (each string names the driver code and the field 'status' / 'cap_<name>'): code vs row mismatch of status or any cap_*;
//       active row without implementation; implementation without row. A row with is_active=false and no implementation is fine.
//   ../ci/synthetic-scan.ts : scanSyntheticData(roots: string[], opts?: { allowedNames?: string[] }): { ok: boolean; violations: { file: string; line?: number; reason: string }[] }
//       Recursively scans every file under each root. Flags a non-empty patient NAME: ASTM `P` record field 6 (P.6) and HL7 `PID` segment field 5 (PID.5),
//       not in allowedNames. Records are found after CR/LF, the `<CR>` mnemonic, an STX+frame digit prefix (`<STX>2P|...`) or a literal \r / \n escape.
//       Missing root = not ok (fail closed). Violations never echo the matched value.
//   ../ci/fixture-copy-check.ts : checkFixtureCopies(dirA: string, dirB: string): { ok: boolean; problems: string[] }
//       byte-for-byte compare of two trees (same relative paths, same bytes); every difference/missing/extra file is a problem naming the relative path;
//       a missing directory is a problem (never a silent pass).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDriverRegistry } from '../ci/driver-registry-check.js';
import { scanSyntheticData } from '../ci/synthetic-scan.js';
import { checkFixtureCopies } from '../ci/fixture-copy-check.js';
import { listDrivers } from '../../drivers/registry.js';

const REPO = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const DRIVERS_DIR = fileURLToPath(new URL('../../drivers/', import.meta.url));
const tmps: string[] = [];
afterAll(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });
function tmp(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'lims-c7-t07-'));
  tmps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const settle = async <T>(f: () => T | Promise<T>): Promise<T | { ok: false; threw: true }> => { try { return await f(); } catch { return { ok: false, threw: true }; } };

// ───────────────────────── driver-registry-check ─────────────────────────
describe('driver-registry-check: code drivers <-> instruments.g_drivers rows (status, cap_*)', () => {
  const caps = (o: Partial<Record<string, boolean>> = {}) => ({ resultUpload: true, hostQuery: false, worklistDownload: false, qc: false, attachments: false, calibration: false, ...o });
  const A = { code: 'alpha_generic', status: 'generic', capabilities: caps({ qc: true }) };
  const B = { code: 'beta_sketch', status: 'sketch_blocked', capabilities: caps({ hostQuery: true }) };
  const INSERT = `INSERT INTO instruments.g_drivers (code, display_name, protocol, vendor, status, driver_version, cap_host_query, cap_qc, cap_attachments) VALUES
 ('alpha_generic','Alpha','astm',NULL,'generic','0.1.0',false,true,false),
 ('beta_sketch','Beta (sketch)','hl7v2','V','sketch_blocked','0.0.1',true,false,false);`;
  const run = (drivers: unknown[], sql: Record<string, string>) =>
    checkDriverRegistry({ drivers: drivers as never, migrationsDir: tmp(Object.fromEntries(Object.entries(sql).map(([k, v]) => [k, v]))) }) as Promise<any> | any;
  const hasProblem = (r: any, ...needles: string[]) => (r.problems as string[]).some((p) => needles.every((n) => p.includes(n)));

  it('matching code and rows -> ok', async () => {
    const r = await run([A, B], { '001_x.sql': INSERT });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('status mismatch is reported with code and field', async () => {
    const r = await run([{ ...A, status: 'verified' }, B], { '001_x.sql': INSERT });
    expect(r.ok).toBe(false);
    expect(hasProblem(r, 'alpha_generic', 'status')).toBe(true);
  });

  it.each([['hostQuery', 'cap_host_query'], ['worklistDownload', 'cap_worklist_download'], ['qc', 'cap_qc'], ['attachments', 'cap_attachments'], ['calibration', 'cap_calibration']])(
    'capability %s flipped in code -> problem naming %s', async (cap, col) => {
      const flipped = { ...A, capabilities: { ...A.capabilities, [cap]: !(A.capabilities as Record<string, boolean>)[cap] } };
      const r = await run([flipped, B], { '001_x.sql': INSERT });
      expect(r.ok).toBe(false);
      expect(hasProblem(r, 'alpha_generic', col)).toBe(true);
    });

  it('active row without implementation, and implementation without row, are both problems', async () => {
    const noImpl = await run([A], { '001_x.sql': INSERT });
    expect(noImpl.ok).toBe(false);
    expect(hasProblem(noImpl, 'beta_sketch')).toBe(true);
    const noRow = await run([A, B, { code: 'gamma_generic', status: 'generic', capabilities: caps() }], { '001_x.sql': INSERT });
    expect(noRow.ok).toBe(false);
    expect(hasProblem(noRow, 'gamma_generic')).toBe(true);
  });

  it('row with is_active = false and no implementation is allowed', async () => {
    const sql = `INSERT INTO instruments.g_drivers (code, display_name, protocol, status, driver_version, is_active) VALUES ('old_retired','Old','astm','generic','0.1.0',false);`;
    const r = await run([A, B], { '001_x.sql': INSERT, '002_y.sql': sql });
    expect(r.ok).toBe(true);
  });

  it('a later migration that promotes a driver (UPDATE) makes a stale code status a problem; updated code passes', async () => {
    const promote = `UPDATE instruments.g_drivers SET status = 'verified', manual_document_id = 'DOC-1' WHERE code = 'alpha_generic';`;
    const stale = await run([A, B], { '001_x.sql': INSERT, '002_promote.sql': promote });
    expect(stale.ok).toBe(false);
    expect(hasProblem(stale, 'alpha_generic', 'status')).toBe(true);
    const fixed = await run([{ ...A, status: 'verified' }, B], { '001_x.sql': INSERT, '002_promote.sql': promote });
    expect(fixed.ok).toBe(true);
  });

  it('no g_drivers rows at all (wrong dir / parser miss) is NOT a pass while drivers exist', async () => {
    const r = await settle(() => run([A, B], { '001_other.sql': 'SELECT 1;' }));
    expect(r.ok).toBe(false);
  });

  it('REAL repo: shipped drivers and db/migrations agree', async () => {
    const r: any = await checkDriverRegistry({ drivers: listDrivers() as never, migrationsDir: join(REPO, 'db', 'migrations') });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────── synthetic-scan (AC-21.4) ─────────────────────────
describe('synthetic-scan: rejects name-like P / PID content outside the synthetic allowlist (AC-21.4)', () => {
  const NAME = 'SMITH^JOHN';
  const scan = (files: Record<string, string>, opts?: { allowedNames?: string[] }) => scanSyntheticData([tmp(files)], opts) as Promise<any> | any;
  const flagged = (r: any, file: string) => (r.violations as { file: string }[]).some((v) => v.file.replace(/\\/g, '/').endsWith(file));

  it('clean synthetic ASTM + HL7 files pass', async () => {
    const r = await scan({
      'a/case1.raw': 'H|\\^&|||SIM\rP|1\rO|1|E2600000042||^^^GLU\rR|1|^^^GLU|5.4|mmol/L\rL|1|N\r',
      'b/case2.raw': 'MSH|^~\\&|SIM|LAB|LIS|CTR|20261107101500||ORU^R01|M1|P|2.3.1\rPID|1||E2600000042\rOBX|1|NM|GLU^G||5.4\r',
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('ASTM P.6 name -> violation (file named, line given)', async () => {
    const r = await scan({ 'x/bad.raw': `H|\\^&|||SIM\rP|1||||${NAME}||19800101|M\rL|1|N\r` });
    expect(r.ok).toBe(false);
    expect(flagged(r, 'x/bad.raw')).toBe(true);
  });

  it('HL7 PID.5 name -> violation', async () => {
    const r = await scan({ 'x/bad.hl7': `MSH|^~\\&|SIM\rPID|1||P0001||DOE^JANE||19800101|F\r` });
    expect(r.ok).toBe(false);
    expect(flagged(r, 'x/bad.hl7')).toBe(true);
  });

  it('LF-separated files are scanned too', async () => {
    const r = await scan({ 'x/lf.raw': `H|\\^&\nP|1||||${NAME}\n` });
    expect(r.ok).toBe(false);
  });

  it('simulator sessions: <STX>n framed P record, <CR> mnemonic, and escaped \\r forms are all caught', async () => {
    const json = (bytes: string) => JSON.stringify({ name: 's', steps: [{ from: 'instrument', bytes }] });
    const stx = await scan({ 'sessions/a.session.json': json(`<STX>2P|1||||${NAME}<CR><ETX>00<CR><LF>`) });
    expect(stx.ok).toBe(false);
    const esc = await scan({ 'sessions/b.session.json': json('H|\\^&\\rP|1||||' + NAME + '\\r') });
    expect(esc.ok).toBe(false);
    const hl7 = await scan({ 'sessions/c.session.json': json(`<VT>MSH|^~\\&|SIM<CR>PID|1||X||DOE^JANE<CR><FS><CR>`) });
    expect(hl7.ok).toBe(false);
  });

  it('allowlisted synthetic names pass; others in the same file still fail', async () => {
    const allowed = { allowedNames: ['SYNTHETIC^PATIENT'] };
    const okRun = await scan({ 'x/ok.raw': 'H|\\^&\rP|1||||SYNTHETIC^PATIENT\r' }, allowed);
    expect(okRun.ok).toBe(true);
    const bad = await scan({ 'x/mixed.raw': `H|\\^&\rP|1||||SYNTHETIC^PATIENT\rP|2||||${NAME}\r` }, allowed);
    expect(bad.ok).toBe(false);
  });

  it('allowlist match is whole-value, not a prefix/substring (SYNTHETIC^PATIENTX is not SYNTHETIC^PATIENT)', async () => {
    const r = await scan({ 'x/near.raw': 'H|\\^&\rP|1||||SYNTHETIC^PATIENTX\r' }, { allowedNames: ['SYNTHETIC^PATIENT'] });
    expect(r.ok).toBe(false);
  });

  it('a name in the P record of a NESTED directory is found; non-name fields (ids, dob, sex) are not name-like', async () => {
    const r = await scan({ 'a/b/c/deep.raw': `H|\\^&\rP|1|PRAC1|LAB1|ID3||||19800101|M\r`, 'a/b/c/deep2.raw': `H|\\^&\rP|1||||${NAME}\r` });
    expect(flagged(r, 'a/b/c/deep2.raw')).toBe(true);
    expect(flagged(r, 'a/b/c/deep.raw')).toBe(false);
  });

  it('violations never echo the matched name (CI logs stay free of PHI)', async () => {
    const r = await scan({ 'x/bad.raw': `H|\\^&\rP|1||||${NAME}\r`, 'x/bad2.raw': `PID|1||X||DOE^JANE\r` });
    const out = JSON.stringify(r);
    expect(out).not.toContain('SMITH');
    expect(out).not.toContain('JOHN');
    expect(out).not.toContain('DOE');
    expect(out).not.toContain('JANE');
  });

  it('missing root fails closed', async () => {
    const r: any = await settle(() => scanSyntheticData([join(tmpdir(), 'lims-c7-no-such-dir-' + Date.now())]) as never);
    expect(r.ok).toBe(false);
  });

  it('REAL repo: every drivers/**/testdata (and apps/bridge-agent/testdata when present) is synthetic', async () => {
    const roots = existsSync(DRIVERS_DIR)
      ? readdirSync(DRIVERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(DRIVERS_DIR, e.name, 'testdata'))).map((e) => join(DRIVERS_DIR, e.name, 'testdata'))
      : [];
    expect(roots.length).toBeGreaterThanOrEqual(3); // the three generic drivers ship testdata
    const agent = join(REPO, 'apps', 'bridge-agent', 'testdata');
    if (existsSync(agent)) roots.push(agent);
    const r: any = await scanSyntheticData(roots);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────── fixture-copy-check ─────────────────────────
describe('fixture-copy-check: byte-for-byte compare of shared config/canonical-JSON fixtures', () => {
  const bin = new Uint8Array([0, 1, 2, 250, 251, 13, 10, 255]);
  const base = { 'canon/a.json': '{"a":1}', 'canon/sub/b.json': '{"b":[1,2]}', 'k.bin': bin };
  const cmp = (a: Record<string, string | Uint8Array>, b: Record<string, string | Uint8Array>) => checkFixtureCopies(tmp(a), tmp(b)) as Promise<any> | any;
  const has = (r: any, needle: string) => (r.problems as string[]).some((p) => p.replace(/\\/g, '/').includes(needle));

  it('identical trees (nested + binary) -> ok', async () => {
    const r = await cmp(base, { ...base });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('one differing byte -> problem naming the relative path', async () => {
    const r = await cmp(base, { ...base, 'canon/sub/b.json': '{"b":[1,3]}' });
    expect(r.ok).toBe(false);
    expect(has(r, 'canon/sub/b.json')).toBe(true);
  });

  it('CRLF vs LF is a difference (byte-for-byte, no newline normalisation)', async () => {
    const r = await cmp({ 'a.json': '{\n}\n' }, { 'a.json': '{\r\n}\r\n' });
    expect(r.ok).toBe(false);
  });

  it('a single trailing byte or BOM is a difference', async () => {
    expect((await cmp({ 'a.json': '{}' }, { 'a.json': '{}\n' })).ok).toBe(false);
    expect((await cmp({ 'a.json': '{}' }, { 'a.json': '﻿{}' })).ok).toBe(false);
  });

  it('file only in A / only in B -> problem naming it', async () => {
    const onlyA = await cmp({ ...base, 'extra.json': '{}' }, base);
    expect(onlyA.ok).toBe(false);
    expect(has(onlyA, 'extra.json')).toBe(true);
    const onlyB = await cmp(base, { ...base, 'extra2.json': '{}' });
    expect(onlyB.ok).toBe(false);
    expect(has(onlyB, 'extra2.json')).toBe(true);
  });

  it('a missing directory is a problem, never a silent pass', async () => {
    const a = tmp(base);
    const r: any = await settle(() => checkFixtureCopies(a, join(tmpdir(), 'lims-c7-no-such-dir-' + Date.now())) as never);
    expect(r.ok).toBe(false);
  });

  it('two empty directories are not a pass (an empty fixture set proves nothing)', async () => {
    const r: any = await settle(() => cmp({}, {}));
    expect(r.ok).toBe(false);
  });
});
