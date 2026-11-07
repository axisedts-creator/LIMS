// C7 API-T07 — AC-21.2: "CI runs every golden case in drivers/<driver>/testdata/ (*.raw -> *.expected.json) and fails on any difference."
// Layout (02-TRD §15.2), written by the API-T07 writer next to each driver:
//   <case>.raw  <case>.context.json { receivedAt, capturedAt, instrumentTimezone, qcSampleIdPatterns: string[] (RegExp sources), options }
//   <case>.expected.json = the full ParseResult (strict deep equality after a JSON round trip)   SOURCE.md = provenance ("synthetic ...")
// Rules enforced here (TRD §15.2): >= 1 case per generic driver, >= 1 malformed case (astm/hl7), >= 1 QC case when capabilities.qc, no orphans.
// Any testdata dir under drivers/* (sketches included, if present) is also run. Missing dirs for the three generic drivers = failing test.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getDriver } from '../../drivers/registry.js';

const DRIVERS_DIR = fileURLToPath(new URL('../../drivers/', import.meta.url));
const GENERIC = ['astm_generic_e1394', 'hl7v2_generic_oru', 'file_drop_generic'] as const;

const dirs = existsSync(DRIVERS_DIR)
  ? readdirSync(DRIVERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(DRIVERS_DIR, e.name, 'testdata'))).map((e) => e.name)
  : [];
const dataDir = (d: string) => join(DRIVERS_DIR, d, 'testdata');
const files = (d: string) => (existsSync(dataDir(d)) ? readdirSync(dataDir(d)) : []);
const cases = (d: string) => files(d).filter((f) => f.endsWith('.raw')).map((f) => f.slice(0, -'.raw'.length)).sort();
const readJson = (d: string, f: string) => JSON.parse(readFileSync(join(dataDir(d), f), 'utf8'));

function runCase(driverCode: string, name: string) {
  const driver = getDriver(driverCode)!;
  const raw = new Uint8Array(readFileSync(join(dataDir(driverCode), `${name}.raw`)));
  const c = readJson(driverCode, `${name}.context.json`);
  const ctx = { ...c, qcSampleIdPatterns: (c.qcSampleIdPatterns as string[]).map((s) => new RegExp(s)) };
  const actual = JSON.parse(JSON.stringify(driver.parse(raw, ctx)));
  return { actual, expected: readJson(driverCode, `${name}.expected.json`) };
}

describe('AC-21.2 golden layout rules', () => {
  it.each(GENERIC)('%s has testdata with >= 1 case', (d) => {
    expect(cases(d).length).toBeGreaterThanOrEqual(1);
  });

  it.each(GENERIC)('%s: SOURCE.md exists and declares the data synthetic', (d) => {
    expect(files(d)).toContain('SOURCE.md');
    expect(readFileSync(join(dataDir(d), 'SOURCE.md'), 'utf8')).toMatch(/synthetic/i);
  });

  it.each(dirs)('%s: every .raw has .context.json + .expected.json and no orphan files', (d) => {
    const names = new Set(cases(d));
    for (const n of names) {
      expect(files(d), `${d}/${n}`).toContain(`${n}.context.json`);
      expect(files(d), `${d}/${n}`).toContain(`${n}.expected.json`);
      const c = readJson(d, `${n}.context.json`);
      for (const k of ['receivedAt', 'capturedAt', 'instrumentTimezone', 'qcSampleIdPatterns', 'options']) expect(c, `${d}/${n}.context.json`).toHaveProperty(k);
      expect(Array.isArray(c.qcSampleIdPatterns)).toBe(true);
    }
    for (const f of files(d)) {
      const m = /^(.+)\.(context|expected)\.json$/.exec(f);
      if (m) expect(names.has(m[1]!), `orphan ${d}/${f}`).toBe(true);
    }
  });

  it.each(['astm_generic_e1394', 'hl7v2_generic_oru'])('%s: has a malformed case (ok:false, instruments.message_malformed)', (d) => {
    const hit = cases(d).some((n) => {
      const e = readJson(d, `${n}.expected.json`);
      return e.ok === false && e.errorCode === 'instruments.message_malformed';
    });
    expect(hit).toBe(true);
  });

  it.each(['astm_generic_e1394', 'hl7v2_generic_oru'])('%s: has a QC case (a record with recordClass "qc" and a controlIdRaw)', (d) => {
    expect(getDriver(d)!.capabilities.qc).toBe(true);
    const hit = cases(d).some((n) => {
      const e = readJson(d, `${n}.expected.json`);
      return e.ok === true && e.records.some((r: any) => r.recordClass === 'qc' && typeof r.controlIdRaw === 'string' && r.controlIdRaw.length > 0);
    });
    expect(hit).toBe(true);
  });

  it('file_drop_generic: has a case whose expected record is an attachment', () => {
    const hit = cases('file_drop_generic').some((n) => {
      const e = readJson('file_drop_generic', `${n}.expected.json`);
      return e.ok === true && e.records.length === 1 && e.records[0].recordKind === 'attachment';
    });
    expect(hit).toBe(true);
  });
});

describe('AC-21.2 golden cases: parse(raw, context) must equal expected exactly', () => {
  const all = dirs.flatMap((d) => cases(d).map((n) => [d, n] as const));
  it('at least one case exists overall (a vacuous suite is a failure)', () => {
    expect(all.length).toBeGreaterThanOrEqual(GENERIC.length);
  });
  it.each(all)('%s / %s', (d, n) => {
    const { actual, expected } = runCase(d, n);
    expect(actual).toEqual(expected);
  });
  it.each(all)('%s / %s is deterministic (second run identical)', (d, n) => {
    expect(runCase(d, n).actual).toEqual(runCase(d, n).actual);
  });
});
