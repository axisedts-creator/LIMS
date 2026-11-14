// C7 H80-T05 (tester) — g_drivers row, registry check (CI job c7-driver-registry-check), options schema (08-ADDENDUM-TRUTH-H80E §8; LD-139, 2026-11-13).
// Tests first; synthetic data only. The migration is a CR to C0: it must be a NEW file in db/migrations (the C7 schema migration is applied and immutable)
// that INSERTs the truth_h80e row into instruments.g_drivers exactly as the code driver declares it (status generic, capabilities, manualRef).
// SEAM: readRows(migrationsDir) is exported from __tests__/ci/driver-registry-check.ts (tester-owned) so the row can be read the way CI reads it.
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
const drv = () => getDriver('truth_h80e')!;
const dirs: string[] = [];
const tmpMig = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'h80-t05-')); dirs.push(d); mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('H80-T05 instruments.g_drivers row for truth_h80e (08-ADDENDUM §8)', () => {
  it('the code driver is registered with the §8 identity: code/version/protocol/status/capabilities/manualRef', () => {
    const d = drv();
    expect(d).toBeTruthy();
    expect([d.code, d.version, d.protocol, d.status]).toEqual(['truth_h80e', '0.1.0', 'hl7v2', 'generic']);
    expect(d.capabilities).toMatchObject({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: true, attachments: true, calibration: false });
    expect(d.manualRef).toEqual({ title: 'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer', documentId: 'truth-h80e-hl7-interface-user-manual', revision: '1.5' });
  });

  it('db/migrations holds exactly one active truth_h80e row, matching the driver (status generic, host query inert until verified)', () => {
    const row = readRows(MIG).get('truth_h80e');
    expect(row, 'no INSERT INTO instruments.g_drivers ... truth_h80e found in db/migrations').toBeTruthy();
    const d = drv();
    expect(row).toMatchObject({
      code: 'truth_h80e', protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', is_active: true,
      cap_host_query: true, cap_worklist_download: false, cap_qc: true, cap_attachments: true, cap_calibration: false,
      manual_title: d.manualRef?.title, manual_document_id: d.manualRef?.documentId, manual_revision: d.manualRef?.revision,
    });
    expect(String(row!['display_name'] ?? '').length).toBeGreaterThan(0);
    expect(String(row!['display_name']).length).toBeLessThanOrEqual(80);      // g_drivers__text__ck
  });

  it('the row arrives in a NEW migration file, not by editing the applied C7 schema migration; that file is forward-only (no UPDATE to verified)', () => {
    const files = readdirSync(MIG).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
    const holders = files.filter((f) => /instruments\.g_drivers/i.test(readFileSync(join(MIG, f), 'utf8')) && /'truth_h80e'/.test(readFileSync(join(MIG, f), 'utf8')));
    expect(holders.length).toBeGreaterThan(0);
    expect(holders).not.toContain(C7_SCHEMA_MIGRATION);
    for (const f of holders) expect(readFileSync(join(MIG, f), 'utf8')).not.toMatch(/status\s*=\s*'verified'/i);   // promotion is a later reviewed migration (§9 item 9)
  });

  it('LD-139: status stays generic — selectable for create/commissioning, never for live', () => {
    const d = drv();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'create' })).not.toThrow();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'commissioning' })).not.toThrow();
    expect(() => assertDriverSelectable(d, { allowSketchDrivers: false, purpose: 'live' })).toThrow(expect.objectContaining({ code: 'instruments.driver_not_available' }));
  });
});

describe('H80-T05 CI job c7-driver-registry-check (code drivers <-> g_drivers) passes with truth_h80e generic', () => {
  it('REAL repo: every registered driver incl. truth_h80e agrees with db/migrations', () => {
    const r = checkDriverRegistry({ drivers: listDrivers() as never, migrationsDir: MIG });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  const INSERT = (caps: string) => `INSERT INTO instruments.g_drivers (code, display_name, protocol, status, driver_version, cap_host_query, cap_qc, cap_attachments, manual_title, manual_document_id, manual_revision) VALUES
    ('truth_h80e','Truth H80E','hl7v2','generic','0.1.0',${caps},'T','D','1.5');`;
  const only = (drivers: unknown[], sql: string) => checkDriverRegistry({ drivers: drivers as never, migrationsDir: tmpMig({ '001.sql': sql }) });

  it('a matching row passes; a missing row, a wrong status and each capability drift are caught', () => {
    const d = drv();
    expect(only([d], INSERT('true,true,true')).ok).toBe(true);
    expect(only([d], '-- nothing').problems.join('\n')).toContain('truth_h80e');
    expect(only([d], INSERT('false,true,true')).problems.join('\n')).toContain('cap_host_query differs');
    expect(only([d], INSERT('true,false,true')).problems.join('\n')).toContain('cap_qc differs');
    expect(only([d], INSERT('true,true,false')).problems.join('\n')).toContain('cap_attachments differs');
    expect(only([{ ...d, status: 'verified' }], INSERT('true,true,true')).problems.join('\n')).toContain('status differs');
  });

  it('promotion to verified is only legal as a later UPDATE migration, and then the code must change too (a half promotion fails)', () => {
    const d = drv();
    const promote = `UPDATE instruments.g_drivers SET status = 'verified' WHERE code = 'truth_h80e';`;
    const dir = tmpMig({ '001.sql': INSERT('true,true,true'), '002.sql': promote });
    expect(checkDriverRegistry({ drivers: [d] as never, migrationsDir: dir }).problems.join('\n')).toContain('status differs');           // row verified, code generic
    expect(checkDriverRegistry({ drivers: [{ ...d, status: 'verified' }] as never, migrationsDir: dir }).ok).toBe(true);                    // both promoted
  });
});

describe('H80-T05 optionsSchema as in addendum §8', () => {
  const props = () => (drv().optionsSchema as any).properties as Record<string, any>;
  it('declares exactly the five §8 options with their defaults, and rejects unknown keys', () => {
    const s: any = drv().optionsSchema;
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(props()).sort()).toEqual(['detection_mode_field', 'host_query_detection_mode', 'name_script', 'qc_level_map', 'type_flag_field']);
    expect(props()['detection_mode_field'].default).toBe('OBR.15');
    expect(props()['type_flag_field'].default).toBe('MSH.16');
    expect(props()['host_query_detection_mode'].default).toBe(0);
    expect(props()['host_query_detection_mode'].enum).toEqual([0, 1, 2]);
    expect(props()['name_script'].default).toBe('as_registered');
    expect(props()['name_script'].enum).toEqual(['as_registered', 'latin_if_available']);
    expect(props()['qc_level_map'].default).toEqual({ L: 'low' });
  });
});
