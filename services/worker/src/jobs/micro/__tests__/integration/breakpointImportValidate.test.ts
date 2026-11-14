// C10 T-12 integration — task micro.breakpoint_import_validate (02-TRD §9, §9.1; 01-PRD AC-12.2, AC-12.4; 07-SECURITY T-B3, T-B4, S-12, S-13).
// No DB: the in-memory fake of helpers/microDb.ts (SQL dialect + semantics documented there). Spec-silent SEAMS the writer must match:
//   tasks/micro.breakpoint_import_validate.ts exports `breakpointImportValidate: TaskHandler` (the name of 02-TRD §8.2); payload `{ tenant_id, set_id }` (as T-11 enqueues it);
//   file = `ctx.storage.read('micro-imports', set.file_object_path)`; config read per run from `loadMicroConfig(process.env)` (LIMS_MICRO_IMPORT_TIMEOUT_MS / _MAX_LINES);
//   the first `uploaded → validating` UPDATE is committed through `ctx.db.tx` (it must survive a failed attempt; a retry finds `validating` and issues NO status UPDATE);
//   rows / bands / issues are INSERTed only inside the final transaction, together with the counts + `validated`/`invalid` (+ validated_at) UPDATE;
//   a set that is no longer `uploaded`/`validating` (validated/invalid/active/retired/discarded) is a silent no-op (no write, no throw);
//   a set not visible to ctx.tenantId (RLS) is not touched (the handler may resolve or reject);
//   parse-level outcomes (too_many_rows, parse_timeout, header, encoding, …) and validation errors END the job as `invalid` with the issue stored — the handler RESOLVES (a retry cannot change them);
//   only an unexpected failure (storage/DB) rejects; on the FINAL attempt (attempt === maxAttempts) the set becomes `invalid` with one `file.processing_failed` issue persisted through
//   ctx.db.tx (the handler may then still reject => dead letter); the stored message never carries the underlying error text.
//   Dictionary reads: SELECTs on micro.g_cs_* / cs_* / g_ast_category_restrictions (WHERE is not evaluated by the fake => merge/filter in code; tenant cs_* shadow global by code).
import { afterEach, describe, expect, it } from 'vitest';
import { breakpointImportValidate } from '../../tasks/micro.breakpoint_import_validate.js';
import { JOB_CODES, NOTE, WARNING_CODES, band, bigFile, bytes, file } from '../helpers/csv.js';
import { SET_ID, SET_PATH, SYS, TENANT_A, TENANT_B, makeWorld, type Row } from '../helpers/microDb.js';

const PAYLOAD = { tenant_id: TENANT_A, set_id: SET_ID };
const store = (text: string | Uint8Array) => ({ read: async () => (typeof text === 'string' ? bytes(text) : text) });
const writes = (w: { calls: { text: string }[] }) => w.calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.text));
const issueCodes = (w: { issues: Row[] }) => w.issues.map((i) => i.code);
afterEach(() => { delete process.env.LIMS_MICRO_IMPORT_TIMEOUT_MS; delete process.env.LIMS_MICRO_IMPORT_MAX_LINES; });

async function validate(text: string | Uint8Array, opts: Parameters<typeof makeWorld>[0] = {}) {
  const world = makeWorld(opts);
  const res = await world.run(breakpointImportValidate, PAYLOAD, { storage: store(text) });
  return { ...world, res };
}

describe('C10-T12 job: a clean file (AC-12.2)', () => {
  it('reads micro-imports/<set path>, stores rows + bands, counts, validated_at and status validated in one go', async () => {
    const { w, set, res } = await validate(file(
      band({ cat: 'S', hi: '2', hiInc: 'true' }), band({ cat: 'R', lo: '2', loInc: 'false', hi: '', hiInc: '' }),
      band({ scope: 'organism', org: 'syn_org_a', abx: 'syn_abx_b', method: 'zone_diameter', site: 'syn_site', qual: 'syn_q', cat: 'I', lo: '12', hi: '12.5' }),
    ));
    expect(res.error).toBeUndefined();
    expect(w.storageReads).toEqual([['micro-imports', SET_PATH]]);
    const s = set();
    expect(s).toMatchObject({ status: 'validated', row_count: 2, band_count: 3, error_count: 0, warning_count: 0 });
    expect(s.validation_started_at).toBeInstanceOf(Date);
    expect(s.validated_at).toBeInstanceOf(Date);
    expect(w.issues).toEqual([]);
    expect(w.rows).toHaveLength(2);
    expect(w.rows.every((r) => r.tenant_id === TENANT_A && r.set_id === SET_ID && r.created_by === SYS)).toBe(true);
    expect(w.rows.map((r) => [r.line_no, r.organism_scope, r.organism_code ?? null, r.antibiotic_code, r.method, r.specimen_site_code ?? null, r.qualifier_code ?? null]))
      .toEqual([[2, 'any', null, 'syn_abx_a', 'mic', null, null], [4, 'organism', 'syn_org_a', 'syn_abx_b', 'zone_diameter', 'syn_site', 'syn_q']]);
    const first = w.rows[0]!;
    const bands = w.bands.filter((b) => b.row_id === first.id).sort((a, b) => a.band_no - b.band_no);
    expect(bands.map((b) => [b.band_no, b.category_code, b.lower_value == null ? null : Number(b.lower_value), b.lower_inclusive, b.upper_value == null ? null : Number(b.upper_value), b.upper_inclusive, b.note]))
      .toEqual([[1, 'S', null, true, 2, true, NOTE], [2, 'R', 2, false, null, true, NOTE]]);
    expect(w.bands.every((b) => b.tenant_id === TENANT_A && b.set_id === SET_ID && b.created_by === SYS)).toBe(true);
  });

  it('a category added to the standard in data (no code change) is accepted; ECOFF and I^ work; tenant cs_* additions are known codes', async () => {
    const dict = {
      g_cs_ast_interpretations: [{ standard: 'CLSI', code: 'S', is_active: true }, { standard: 'CLSI', code: 'I^', is_active: true }, { standard: 'CLSI', code: 'SYN', is_active: true }],
      cs_antibiotics: [{ code: 'syn_abx_tenant', is_active: true, tenant_id: TENANT_A }],
    };
    const { set, w, res } = await validate(file(band({ cat: 'SYN' }), band({ abx: 'syn_abx_tenant', cat: 'I^' })), { dict });
    expect(res.error).toBeUndefined();
    expect(w.issues).toEqual([]);
    expect(set().status).toBe('validated');
    const ecoff = await validate(file(band({ cat: 'WT' })), { set: { standard: 'ECOFF' } });
    expect(ecoff.set().status).toBe('validated');
  });

  it('warnings alone (gap between bands, inactive code) keep the set validated, with warning_count', async () => {
    const { set, w } = await validate(file(
      band({ scope: 'organism', org: 'syn_org_inactive', cat: 'S', hi: '2' }), band({ scope: 'organism', org: 'syn_org_inactive', cat: 'R', lo: '4', loInc: 'true', hi: '', hiInc: '' }),
    ));
    expect(set()).toMatchObject({ status: 'validated', error_count: 0, warning_count: 2 });
    expect(issueCodes(w).sort()).toEqual(['row.code_inactive', 'row.gap_between_bands']);
    expect(w.issues.every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('C10-T12 job: every dictionary / standard / lifecycle issue code has a fixture (AC-12.2)', () => {
  const FIX: Record<string, { text: string; set?: Partial<Row>; line?: number; status: string }> = {
    'row.organism_unknown': { text: file(band({ scope: 'organism', org: 'syn_org_zzz' })), line: 2, status: 'invalid' },
    'row.group_unknown': { text: file(band({ scope: 'group', org: 'syn_group_zzz' })), line: 2, status: 'invalid' },
    'row.antibiotic_unknown': { text: file(band({ abx: 'syn_abx_zzz' })), line: 2, status: 'invalid' },
    'row.site_unknown': { text: file(band({ site: 'syn_site_zzz' })), line: 2, status: 'invalid' },
    'row.category_invalid': { text: file(band({ cat: 'SDD' })), set: { standard: 'EUCAST' }, line: 2, status: 'invalid' },       // SDD is a CLSI category only
    'row.category_restricted': { text: file(band({ abx: 'syn_colistin', cat: 'S' })), line: 2, status: 'invalid' },                // CLSI colistin: I/R only
    'row.code_inactive': { text: file(band({ scope: 'organism', org: 'syn_org_inactive' })), line: 2, status: 'validated' },
  };
  it('the table covers the dictionary-level codes; file.processing_failed has its own test below', () => {
    expect([...Object.keys(FIX), 'file.processing_failed'].sort()).toEqual([...JOB_CODES].sort());
  });
  for (const [code, f] of Object.entries(FIX)) {
    it(code, async () => {
      const { set, w, res } = await validate(f.text, { set: f.set });
      expect(res.error).toBeUndefined();
      expect(issueCodes(w)).toEqual([code]);
      const i = w.issues[0]!;
      expect(i).toMatchObject({ tenant_id: TENANT_A, set_id: SET_ID, line_no: f.line, severity: WARNING_CODES.includes(code) ? 'warning' : 'error', created_by: SYS });
      expect(String(i.message).length).toBeLessThanOrEqual(200);
      expect(set().status).toBe(f.status);
      expect(set()).toMatchObject({ error_count: WARNING_CODES.includes(code) ? 0 : 1, warning_count: WARNING_CODES.includes(code) ? 1 : 0 });
    });
  }

  it('a restricted antibiotic accepts its allowed categories; the standard comes from the SET, not from the file', async () => {
    expect((await validate(file(band({ abx: 'syn_colistin', cat: 'I', hi: '2' }), band({ abx: 'syn_colistin', cat: 'R', lo: '2', loInc: 'false', hi: '', hiInc: '' })))).set().status).toBe('validated');
    expect((await validate(file(band({ cat: 'SDD' })))).set().status).toBe('validated');              // CLSI set
  });

  it('tenant isolation of dictionaries: a code that exists only in tenant B is unknown for tenant A', async () => {
    const dict = { cs_organisms: [{ code: 'syn_org_b_only', is_active: true, tenant_id: TENANT_B }] };
    const { w } = await validate(file(band({ scope: 'organism', org: 'syn_org_b_only' })), { dict });
    expect(issueCodes(w)).toEqual(['row.organism_unknown']);
  });

  it('parser-level errors and dictionary errors are all stored, one issue per offending line, counts match', async () => {
    const { set, w } = await validate(file(band({ method: 'disk' }), band({ abx: 'syn_abx_zzz', qual: 'k' }), band({ qual: 'ok' })));
    expect(w.issues.map((i) => [i.line_no, i.code]).sort()).toEqual([[2, 'row.method_invalid'], [3, 'row.antibiotic_unknown']]);
    expect(set()).toMatchObject({ status: 'invalid', error_count: 2, warning_count: 0 });
  });
});

describe('C10-T12 job: retry semantics (AC-12.2, 02-TRD §9, review m#20)', () => {
  it('a failed attempt leaves the set `validating` and writes nothing else; the retry issues no status UPDATE until the final one, and succeeds', async () => {
    const world = makeWorld();
    const failing = { read: async () => { throw new Error('SECRET-STORAGE-DETAIL'); } };
    const r1 = await world.run(breakpointImportValidate, PAYLOAD, { attempt: 1, storage: failing });
    expect(r1.error).toBeDefined();
    expect(world.set().status).toBe('validating');
    expect(world.set().validation_started_at).toBeInstanceOf(Date);
    expect([world.w.rows.length, world.w.bands.length, world.w.issues.length]).toEqual([0, 0, 0]);
    const startedAt = world.set().validation_started_at;
    const before = world.w.calls.length;

    const r2 = await world.run(breakpointImportValidate, PAYLOAD, { attempt: 2, storage: store(file(band())) });
    expect(r2.error).toBeUndefined();                                            // the guard has no validating -> validating: any such UPDATE would have thrown
    expect(world.set()).toMatchObject({ status: 'validated', row_count: 1, band_count: 1 });
    expect(world.set().validation_started_at).toEqual(startedAt);
    const statusUpdates = world.w.calls.slice(before).filter((c) => /^\s*UPDATE/i.test(c.text) && /status/i.test(c.text));
    expect(statusUpdates).toHaveLength(1);
    expect(world.w.issues).toEqual([]);
  });

  it('a crash while inserting bands rolls the whole final transaction back (no rows, no issues, still validating); the retry then yields no duplicates', async () => {
    const world = makeWorld();
    world.w.failInsertInto = 'breakpoint_bands';
    const r1 = await world.run(breakpointImportValidate, PAYLOAD, { attempt: 1, storage: store(file(band(), band({ qual: 'k2' }))) });
    expect(r1.error).toBeDefined();
    expect([world.w.rows.length, world.w.bands.length, world.w.issues.length]).toEqual([0, 0, 0]);
    expect(world.set()).toMatchObject({ status: 'validating', row_count: 0, band_count: 0 });
    world.w.failInsertInto = undefined;
    const r2 = await world.run(breakpointImportValidate, PAYLOAD, { attempt: 2, storage: store(file(band(), band({ qual: 'k2' }))) });
    expect(r2.error).toBeUndefined();
    expect(world.set()).toMatchObject({ status: 'validated', row_count: 2, band_count: 2 });
    expect([world.w.rows.length, world.w.bands.length]).toEqual([2, 2]);
  });

  it('final attempt failing: set becomes invalid with one file.processing_failed issue; the underlying error text is not stored or logged', async () => {
    const world = makeWorld();
    const failing = { read: async () => { throw new Error('SECRET-STORAGE-DETAIL /var/secret/path'); } };
    await world.run(breakpointImportValidate, PAYLOAD, { attempt: 1, storage: failing });
    await world.run(breakpointImportValidate, PAYLOAD, { attempt: 3, maxAttempts: 3, storage: failing });   // outcome (resolve | reject => dead letter) is not pinned
    expect(world.set()).toMatchObject({ status: 'invalid', error_count: 1, warning_count: 0, row_count: 0, band_count: 0 });
    expect(world.w.issues).toHaveLength(1);
    expect(world.w.issues[0]).toMatchObject({ code: 'file.processing_failed', severity: 'error', set_id: SET_ID, tenant_id: TENANT_A, line_no: null });
    expect(JSON.stringify([world.w.issues, world.w.logs])).not.toContain('SECRET-STORAGE-DETAIL');
  });

  it('duplicate delivery after the job finished (validated/invalid/active/retired/discarded) is a no-op: no write, status unchanged', async () => {
    for (const status of ['validated', 'invalid', 'active', 'retired', 'discarded']) {
      const world = makeWorld({ set: { status, effective_from: new Date('2026-01-01T00:00:00Z') } });
      const r = await world.run(breakpointImportValidate, PAYLOAD, { storage: store(file(band())) });
      expect(r.error, status).toBeUndefined();
      expect(writes(world.w), status).toEqual([]);
      expect(world.set().status).toBe(status);
    }
  });
});

describe('C10-T12 job: limits and timeout (AC-12.4, S-12)', () => {
  it('20,000 lines: validated, 10,000 rows / 20,000 bands, ≤ 30 s, every statement within the 65,535 bind-parameter limit', async () => {
    const t = Date.now();
    const { set, w, res } = await validate(bigFile(10_000));
    expect(Date.now() - t).toBeLessThanOrEqual(30_000);
    expect(res.error).toBeUndefined();
    expect(set()).toMatchObject({ status: 'validated', row_count: 10_000, band_count: 20_000, error_count: 0 });
    expect([w.rows.length, w.bands.length, w.issues.length]).toEqual([10_000, 20_000, 0]);
    expect(Math.max(...w.calls.map((c) => c.params.length))).toBeLessThanOrEqual(65_535);
  }, 60_000);

  it('20,001 lines -> invalid + file.too_many_rows (error), nothing retried, no rows stored', async () => {
    const { set, w, res } = await validate(bigFile(10_000) + band({ qual: 'extra' }) + '\n');
    expect(res.error).toBeUndefined();
    expect(set()).toMatchObject({ status: 'invalid', row_count: 0, band_count: 0 });
    expect(issueCodes(w)).toEqual(['file.too_many_rows']);
    expect(w.issues[0]).toMatchObject({ severity: 'error', line_no: null });
    expect(set().error_count).toBe(1);
  });

  it('LIMS_MICRO_IMPORT_MAX_LINES is honoured (read per run)', async () => {
    process.env.LIMS_MICRO_IMPORT_MAX_LINES = '2';
    const { set, w } = await validate(file(band({ qual: 'a' }), band({ qual: 'b' }), band({ qual: 'c' })));
    expect(issueCodes(w)).toEqual(['file.too_many_rows']);
    expect(set().status).toBe('invalid');
  });

  it('parse timeout (LIMS_MICRO_IMPORT_TIMEOUT_MS) -> invalid + file.parse_timeout, resolved not retried, quickly', async () => {
    process.env.LIMS_MICRO_IMPORT_TIMEOUT_MS = '1';
    const t = Date.now();
    const { set, w, res } = await validate(bigFile(10_000));
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(res.error).toBeUndefined();
    expect(issueCodes(w)).toEqual(['file.parse_timeout']);
    expect(w.issues[0]).toMatchObject({ severity: 'error' });
    expect(set()).toMatchObject({ status: 'invalid', error_count: 1, row_count: 0 });
  }, 60_000);

  it('file-level parse failures end as invalid with a single issue: encoding, header, empty, unbalanced quote', async () => {
    const cases: Array<[string, string | Uint8Array]> = [
      ['file.encoding_invalid', new Uint8Array([0xff, 0xfe, 0x00])],
      ['file.header_mismatch', 'a,b,c\n1,2,3\n'],
      ['file.empty', file().replace(/\n\n$/, '\n')],
      ['file.quote_unbalanced', file(band().replace(NOTE, '"NOT CLINICAL'))],
    ];
    for (const [code, input] of cases) {
      const { set, w, res } = await validate(input);
      expect(res.error, code).toBeUndefined();
      expect(issueCodes(w), code).toEqual([code]);
      expect(set(), code).toMatchObject({ status: 'invalid', error_count: 1, row_count: 0 });
    }
  });
});

describe('C10-T12 job: isolation and injection (S-01, S-13)', () => {
  it('a set of tenant A is not visible to a job running as tenant B: nothing is written or changed', async () => {
    const world = makeWorld();
    await world.run(breakpointImportValidate, { tenant_id: TENANT_B, set_id: SET_ID }, { tenantId: TENANT_B, storage: store(file(band())) });
    expect(writes(world.w)).toEqual([]);
    expect(world.set()).toMatchObject({ status: 'uploaded', row_count: 0 });
  });

  it('hostile cells (formula / HTML, > 40 chars) never appear in an issue message, a field or a log line; the note of a valid line is plain text', async () => {
    const hostile = "=cmd|'/C calc'!A0<script>alert(1)</script>" + 'a'.repeat(30);
    const { w, set } = await validate(file(band({ scope: 'organism', org: hostile }), band({ qual: 'ok', note: '"=1+1 NOT CLINICAL"' })));
    expect(set().status).toBe('invalid');
    const unknown = w.issues.find((i) => i.code === 'row.organism_unknown')!;
    expect(unknown).toBeDefined();
    expect(String(unknown.message).length).toBeLessThanOrEqual(200);
    expect(String(unknown.message)).not.toContain('<script>alert(1)</script>');
    expect(String(unknown.message)).not.toContain('=cmd|');
    expect(JSON.stringify(w.logs)).not.toContain('=cmd|');
    expect(w.issues.every((i) => (i.field ?? '').length <= 40)).toBe(true);
    expect(w.bands.find((b) => b.note === '=1+1 NOT CLINICAL')).toBeDefined();
  });
});
