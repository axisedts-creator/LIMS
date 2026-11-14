// T0A-05 / TRD §3.5 `catalog/`, 08 A13 D-17, CR-C3-007; C3 TRD §8.2 (columns) + C3 05-SCHEMA §8 (content).
// ASSUMED: generator `packages/test-fixtures/catalog/generate.mjs --out <dir>` writes the two .xlsx files into <dir>
// (default = its own directory); output is deterministic (identical entry contents on regeneration).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workbookInfo } from './_xlsx.mjs';

const dir = fileURLToPath(new URL('../catalog/', import.meta.url));
const MASTER = join(dir, 'starter_catalog_master.xlsx');
const PRICE = join(dir, 'starter_price_list.xlsx');
const GEN = join(dir, 'generate.mjs');

describe('catalog starter workbooks exist and are generated', () => {
  it('generator script + both workbooks are present', () => {
    assert.ok(existsSync(GEN), 'catalog/generate.mjs');
    assert.ok(existsSync(MASTER), 'starter_catalog_master.xlsx');
    assert.ok(existsSync(PRICE), 'starter_price_list.xlsx');
  });
  it('regenerating reproduces the committed workbooks (never hand-edited)', () => {
    const out = mkdtempSync(join(tmpdir(), 'cat-'));
    const r = spawnSync(process.execPath, [GEN, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['starter_catalog_master.xlsx', 'starter_price_list.xlsx']) {
      const a = workbookInfo(join(dir, f)).z;
      const b = workbookInfo(join(out, f)).z;
      assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort(), f);
      for (const [k, v] of a) assert.equal(b.get(k), v, `${f}:${k}`);
    }
  });
});

describe('catalog_master workbook (C3 TRD §8.2)', () => {
  const w = () => workbookInfo(MASTER);
  it('has the Instructions sheet, hidden _meta sheet and every §8.2 data sheet', () => {
    const names = w().sheets.map((s) => s.name);
    for (const n of ['Instructions', '_meta', 'Departments', 'SpecimenTypes', 'Containers', 'Methods', 'Units',
      'ValueSets', 'Tests', 'Analytes', 'ReferenceRanges', 'CriticalLimits', 'Panels', 'PanelMembers',
      'CommentCodes', 'TatTargets']) assert.ok(names.includes(n), n);
    assert.equal(w().sheets.find((s) => s.name === '_meta').hidden, true);
  });
  it('_meta carries template_kind=catalog_master and template_version=1', () => {
    const t = w().texts;
    assert.ok(t.includes('template_kind') && t.includes('catalog_master'));
    assert.ok(t.includes('template_version'));
  });
  it('header columns present for Tests and Analytes (exact lower-snake keys)', () => {
    const t = w().texts;
    for (const c of ['department_code', 'workflow_type', 'specimen_type_codes', 'container_code', 'analyte_code',
      'print_name', 'result_type', 'unit_code', 'value_set_code', 'formula']) assert.ok(t.includes(c), c);
  });
  it('content per C3 05-SCHEMA §8: departments, specimen types, LIPID/CBC/HP_ELITE_M/Mentzer/K', () => {
    const t = new Set(w().texts);
    for (const c of ['HAEM', 'BIOCHEM', 'CLINPATH', 'MICRO', 'EDTA_WB', 'SERUM', 'FL_PLASMA', 'URINE',
      'HP_ELITE_M', 'LIPID', 'MENTZER', 'NLR', 'PLR']) assert.ok(t.has(c), c);
    assert.ok(t.has('FASTING PLASMA FL.'));
  });
  it('every value labelled SYNTHETIC in the Instructions sheet', () => {
    assert.ok(w().texts.some((s) => /SYNTHETIC/.test(s)));
  });
});

describe('price_list workbook (C3 TRD §8.2)', () => {
  const w = () => workbookInfo(PRICE);
  it('has Instructions, hidden _meta and Prices sheets; kind=price_list, version 1, base_version_no', () => {
    const names = w().sheets.map((s) => s.name);
    for (const n of ['Instructions', '_meta', 'Prices']) assert.ok(names.includes(n), n);
    assert.equal(w().sheets.find((s) => s.name === '_meta').hidden, true);
    const t = w().texts;
    for (const k of ['template_kind', 'price_list', 'template_version', 'price_list_id', 'base_version_no']) {
      assert.ok(t.includes(k), k);
    }
  });
  it('Prices header uses the exact column keys; SYNTHETIC label present', () => {
    const t = w().texts;
    for (const c of ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr']) {
      assert.ok(t.includes(c), c);
    }
    assert.ok(t.some((s) => /SYNTHETIC/.test(s)));
  });
});

describe('security: formula-injection guard + no real data (08 R12e, REQ-SEC-136)', () => {
  for (const f of [MASTER, PRICE]) {
    it(`${f.split(/[\\/]/).pop()}: no formula cells; no text cell starts with = + - @ (neutralised)`, () => {
      const w = workbookInfo(f);
      assert.equal(w.hasFormula, false);
      for (const s of w.texts) assert.ok(!/^[=+@]/.test(s) && !/^-[^0-9.]/.test(s), s);
    });
    it(`${f.split(/[\\/]/).pop()}: emails only under .invalid, no Nepali mobile numbers`, () => {
      const joined = workbookInfo(f).texts.join('\n');
      for (const m of joined.matchAll(/[\w.+-]+@[\w.-]+/g)) assert.match(m[0], /\.invalid$/, m[0]);
      assert.ok(!/\+977|\b9[78]\d{8}\b/.test(joined));
    });
  }
});
