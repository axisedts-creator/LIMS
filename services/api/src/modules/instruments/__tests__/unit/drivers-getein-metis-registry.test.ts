// C7 MET-T04 (tester) — g_drivers row for getein_metis (CR-C7-020), options schema, registry check (CI job c7-driver-registry-check). 09-ADDENDUM-GETEIN-METIS §8, §10; LD-163 (2026-11-14), LD-161.
// Tests first; synthetic data only. The migration is a CR to C0: a NEW forward-only file in db/migrations whose FIRST statement is `SET LOCAL ROLE lims_owner;` (LD-161: without it the INSERT dies with
// "permission denied for schema instruments"), then ONE INSERT with the columns the truth_h80e row uses, status generic, no UPDATE. The C7 schema migration is applied and immutable.
// SEAM: readRows(migrationsDir) is exported from __tests__/ci/driver-registry-check.ts (tester-owned) so the row is read the way CI reads it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDriverRegistry, readRows } from '../ci/driver-registry-check.js';
import { assertDriverSelectable, getDriver, listDrivers } from '../../drivers/registry.js';

const REPO = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const MIG = join(REPO, 'db', 'migrations');
const C7_SCHEMA_MIGRATION = '20261105002000_instruments__create_instruments_schema.sql';
const H80E_MIGRATION = '20261113230000_instruments__add_truth_h80e_driver.sql';
const drv = () => getDriver('getein_metis')!;
const dirs: string[] = [];
const tmpMig = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'met-t04-')); dirs.push(d); mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const sqlFiles = () => readdirSync(MIG).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');
/** the file without `--` comment lines and blank lines, split on `;` into statements */
const stmts = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
const holders = () => sqlFiles().filter((f) => /instruments\.g_drivers/i.test(read(f)) && /'getein_metis'/.test(read(f)));

describe('MET-T04 instruments.g_drivers row for getein_metis (09-ADDENDUM §8, CR-C7-020)', () => {
  it('the code driver is registered with the §8 identity: code/version/protocol/status/capabilities/manualRef', () => {
    const d = drv();
    expect(d).toBeTruthy();
    expect([d.code, d.version, d.protocol, d.status]).toEqual(['getein_metis', '0.1.0', 'hl7v2', 'generic']);
    expect(d.capabilities).toMatchObject({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: false, calibration: false });
    expect(d.manualRef).toEqual({ title: 'HL7 Communication Protocol (Applicable to Metis Series Analyzers)', documentId: 'getein-metis-hl7-communication-protocol', revision: 'unversioned' });
  });

  it('db/migrations holds exactly one active getein_metis row, matching the driver (status generic, host query inert until verified)', () => {
    const row = readRows(MIG).get('getein_metis');
    expect(row, 'no INSERT INTO instruments.g_drivers ... getein_metis found in db/migrations').toBeTruthy();
    const d = drv();
    expect(row).toMatchObject({
      code: 'getein_metis', protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', is_active: true,
      cap_host_query: true, cap_worklist_download: false, cap_qc: true, cap_attachments: false, cap_calibration: false,
      manual_title: d.manualRef?.title, manual_document_id: d.manualRef?.documentId, manual_revision: d.manualRef?.revision,
    });
    expect(String(row!['display_name'] ?? '').length).toBeGreaterThan(0);
    expect(String(row!['display_name']).length).toBeLessThanOrEqual(80);      // g_drivers__text__ck
    expect(String(row!['vendor'] ?? '')).toMatch(/Getein/);                    // the columns the truth_h80e row uses include vendor
  });

  it('the row arrives in ONE NEW migration file, not by editing an applied one, and exactly once', () => {
    const h = holders();
    expect(h, 'a new migration with INSERT INTO instruments.g_drivers ... getein_metis').toHaveLength(1);
    expect(h).not.toContain(C7_SCHEMA_MIGRATION);
    expect(h).not.toContain(H80E_MIGRATION);                                   // the immutable truth_h80e migration is untouched
    const inserts = stmts(read(h[0]!)).filter((s) => /^INSERT\s+INTO\s+instruments\.g_drivers/i.test(s));
    expect(inserts).toHaveLength(1);                                           // "one INSERT"
    expect((inserts[0]!.match(/'getein_metis'/g) ?? []).length).toBe(1);       // one row
  });

  it('LD-161: the FIRST statement is SET LOCAL ROLE lims_owner; (like every other migration), before the INSERT', () => {
    const f = holders()[0];
    expect(f, 'migration file').toBeTruthy();
    const s = stmts(read(f!));
    expect(s[0]).toMatch(/^SET\s+LOCAL\s+ROLE\s+lims_owner$/i);
    expect(s.findIndex((x) => /^INSERT\s+INTO\s+instruments\.g_drivers/i.test(x))).toBeGreaterThan(0);
    expect(s.filter((x) => /^SET\s+(LOCAL\s+)?ROLE/i.test(x))).toHaveLength(1); // single role switch, never RESET ROLE / a second switch
  });

  it('the file name follows the repo pattern and sorts AFTER the schema and truth_h80e migrations (forward-only order, unique timestamp)', () => {
    const f = holders()[0]!;
    expect(f, 'migration file').toBeTruthy();
    expect(f).toMatch(/^\d{14}_instruments__[a-z0-9_]+\.sql$/);
    expect(f > H80E_MIGRATION).toBe(true);
    const ts = sqlFiles().map((x) => x.slice(0, 14));
    expect(ts.filter((t) => t === f.slice(0, 14))).toHaveLength(1);
  });

  it('forward-only: no UPDATE / DELETE / DROP / promotion to verified anywhere for getein_metis (that is a later reviewed migration, §9 item 9)', () => {
    const f = holders()[0]!;
    expect(f, 'migration file').toBeTruthy();
    const body = stmts(read(f)).join(';\n');
    expect(body).not.toMatch(/\bUPDATE\b/i);
    expect(body).not.toMatch(/\bDELETE\b/i);
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).not.toMatch(/\bON\s+CONFLICT\b/i);                            // a plain INSERT: a duplicate row must fail loudly, not be swallowed
    for (const g of holders()) expect(read(g)).not.toMatch(/status\s*=\s*'verified'/i);
  });

  it('the INSERT uses the same column list as the truth_h80e row', () => {
    expect(holders()[0], 'migration file').toBeTruthy();
    const cols = (sql: string) => /INSERT\s+INTO\s+instruments\.g_drivers\s*\(([^)]*)\)/i.exec(sql)?.[1]?.split(',').map((c) => c.trim().toLowerCase());
    expect(cols(read(holders()[0]!))).toEqual(cols(read(H80E_MIGRATION)));
    expect(cols(read(H80E_MIGRATION))).toEqual(['code', 'display_name', 'protocol', 'vendor', 'status', 'driver_version', 'cap_host_query', 'cap_worklist_download', 'cap_qc', 'cap_attachments', 'cap_calibration', 'manual_title', 'manual_document_id', 'manual_revision']);
  });

  it('the earlier six rows are untouched: truth_h80e still has its row and values', () => {
    expect(readRows(MIG).get('truth_h80e')).toMatchObject({ status: 'generic', driver_version: '0.1.0', cap_attachments: true });
    expect([...readRows(MIG).keys()].sort()).toEqual(['astm_generic_e1394', 'file_drop_generic', 'getein_metis', 'hl7v2_generic_oru', 'mindray_bc5380_sketch', 'mindray_bs200_sketch', 'truth_h80e']);
  });

  it('LD-163: status stays generic — selectable for create/commissioning, never for live', () => {
    const d = drv();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'create' })).not.toThrow();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'commissioning' })).not.toThrow();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'live' })).toThrow(expect.objectContaining({ code: 'instruments.driver_not_available' }));
  });
});

describe('MET-T04 CI job c7-driver-registry-check (code drivers <-> g_drivers) passes with getein_metis generic', () => {
  it('REAL repo: every registered driver incl. truth_h80e and getein_metis agrees with db/migrations', () => {
    const r = checkDriverRegistry({ drivers: listDrivers() as never, migrationsDir: MIG });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('REAL repo: removing the getein_metis row makes the check fail naming getein_metis (the check is not vacuous)', () => {
    const f = holders()[0];
    expect(f, 'migration file').toBeTruthy();
    const copy: Record<string, string> = {};
    for (const g of sqlFiles()) if (g !== f) copy[g] = read(g);
    const r = checkDriverRegistry({ drivers: listDrivers() as never, migrationsDir: tmpMig(copy) });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('getein_metis: implementation has no instruments.g_drivers row');
  });

  const INSERT = (caps: string) => `INSERT INTO instruments.g_drivers (code, display_name, protocol, status, driver_version, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration, manual_title, manual_document_id, manual_revision) VALUES
    ('getein_metis','Getein Metis','hl7v2','generic','0.1.0',${caps},'T','D','unversioned');`;
  const only = (drivers: unknown[], sql: string) => checkDriverRegistry({ drivers: drivers as never, migrationsDir: tmpMig({ '001.sql': sql }) });
  const OK = 'true,false,true,false,false';

  it('a matching row passes; a missing row, a wrong status and each capability drift are caught', () => {
    const d = drv();
    expect(only([d], INSERT(OK)).ok).toBe(true);
    expect(only([d], '-- nothing').problems.join('\n')).toContain('getein_metis');
    expect(only([d], INSERT('false,false,true,false,false')).problems.join('\n')).toContain('cap_host_query differs');
    expect(only([d], INSERT('true,true,true,false,false')).problems.join('\n')).toContain('cap_worklist_download differs');
    expect(only([d], INSERT('true,false,false,false,false')).problems.join('\n')).toContain('cap_qc differs');
    expect(only([d], INSERT('true,false,true,true,false')).problems.join('\n')).toContain('cap_attachments differs');
    expect(only([d], INSERT('true,false,true,false,true')).problems.join('\n')).toContain('cap_calibration differs');
    expect(only([{ ...d, status: 'verified' }], INSERT(OK)).problems.join('\n')).toContain('status differs');
  });

  it('promotion to verified is only legal as a later UPDATE migration, and then the code must change too (a half promotion fails)', () => {
    const d = drv();
    const promote = `UPDATE instruments.g_drivers SET status = 'verified' WHERE code = 'getein_metis';`;
    const dir = tmpMig({ '001.sql': INSERT(OK), '002.sql': promote });
    expect(checkDriverRegistry({ drivers: [d] as never, migrationsDir: dir }).problems.join('\n')).toContain('status differs');
    expect(checkDriverRegistry({ drivers: [{ ...d, status: 'verified' }] as never, migrationsDir: dir }).ok).toBe(true);
  });
});

describe('MET-T04 optionsSchema as in addendum §8', () => {
  const s = () => drv().optionsSchema as any;
  const props = () => s().properties as Record<string, any>;
  it('declares exactly the five §8 options and rejects unknown keys; none is required', () => {
    expect(s().type).toBe('object');
    expect(s().additionalProperties).toBe(false);
    expect(Object.keys(props()).sort()).toEqual(['dsr_item_details', 'name_script', 'qc_level_map', 'specimen_type_map', 'type_flag_field']);
    expect(s().required ?? []).toEqual([]);
  });

  it('type_flag_field defaults to MSH.16 and is a field reference (no free text)', () => {
    expect(props()['type_flag_field'].type).toBe('string');
    expect(props()['type_flag_field'].default).toBe('MSH.16');
    const re = new RegExp(props()['type_flag_field'].pattern);
    for (const ok of ['MSH.16', 'OBR.15', 'OBX.3.1']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['', 'msh.16', 'MSH.0', 'MSH-16', 'MSH.16; DROP', ' MSH.16']) expect(re.test(bad), bad).toBe(false);
  });

  it('qc_level_map is an object defaulting to the contract level words low/mid/high (03-IC §3.15 control_level, maxLength 16)', () => {
    const p = props()['qc_level_map'];
    expect(p.type).toBe('object');
    expect(p.default).toEqual({ L: 'low', M: 'mid', H: 'high' });
    expect(p.additionalProperties).toMatchObject({ type: 'string' });
    expect(p.additionalProperties.maxLength).toBeLessThanOrEqual(16);          // the contract's control_level maxLength
    expect(p.additionalProperties.minLength).toBeGreaterThanOrEqual(1);
    expect(typeof p.maxProperties).toBe('number');                             // bounded: hostile options cannot grow without limit
  });

  it('name_script: as_registered (default) | latin_if_available', () => {
    expect(props()['name_script'].default).toBe('as_registered');
    expect(props()['name_script'].enum).toEqual(['as_registered', 'latin_if_available']);
  });

  it('specimen_type_map is a bounded string map', () => {
    const p = props()['specimen_type_map'];
    expect(p.type).toBe('object');
    expect(p.additionalProperties).toMatchObject({ type: 'string' });
    expect(typeof p.maxProperties).toBe('number');
  });

  it('dsr_item_details: id_only (default) | full', () => {
    expect(props()['dsr_item_details'].default).toBe('id_only');
    expect(props()['dsr_item_details'].enum).toEqual(['id_only', 'full']);
  });
});
