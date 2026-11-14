// C11.T-17 — published view contract `anatomic.v_pub_report_content` (06-PLAN row T-17; 05-SCHEMA §5 JSON shapes, §8 view, §11 test 5; 03-IC §6.8 + CR-C11-001;
// PRD AC-09.8; 07-SECURITY REQ-SEC-031 + view probes). LD-140 (UI work only) does not apply: backend contract test, no screens.
// File name: the brief names `view.contract.ts`; vitest only collects `*.test.ts`, so this file is `view.contract.test.ts` (same folder) — the writer must not rename it.
// Part 1 (no DB): the 05-SCHEMA §5 JSON Schemas transcribed INDEPENDENTLY of the code (not imported from domain/), probed with accept/reject fixtures, then checked against the
//   real output of domain/report-content.ts buildContent (so a drift in either copy fails) and against 05-SCHEMA §8's column list (parsed from the spec file).
// Part 2 (live DB, same harness + gate as the other C11 *.live tests: LIMS_TEST_DATABASE_URL superuser + LIMS_TEST_APP_DATABASE_URL lims_app, migrated incl. the anatomic DDL and
//   the C0 view): catalog (kind, 24 columns in order + types, security_invoker, grants, dependencies), AC-09.8 (exactly one row per (entity_id, version_no), equal to the signed
//   content, JSON validates), probes (tenant, centre, unsubmitted version not visible), immutability, DB half of the jsonb contract (report_versions__json__ck).
//   Without the URLs part 2 skips; LIMS_T17_REQUIRE_DB=1 turns the skip into a failure ("database is provided").
//   FAILS NOW for the right reason: the view `anatomic.v_pub_report_content` (C0 prerequisite) is not in db/migrations yet -> "view exists" assertion.
// ASSUMED (spec silent): DecimalString = ^-?\d+(\.\d+)?$; IsoUtc = ISO-8601 with Z; images.object_path = <uuid>/<yyyy>/<mm>/<uuid>.(png|jpg) (05-SCHEMA §9); a version without an
//   item_submissions row is NOT in the view (the view starts FROM item_submissions); the file contracts/views/anatomic.v_pub_report_content.schema.json is C0's transcription:
//   when present it must hold all eight schemas, when absent that test skips (the repo has no contracts/views yet).
// NOT RUN against a database in the tester session; fixture seeding (superuser, session_replication_role=replica) may need column tweaks, never assertion weakening.
// Synthetic data only.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { buildContent } from '../../domain/report-content.js';
import { caseRow, CENTRE_A1, CENTRE_A2, CENTRE_B1, CLAIMS, LIVE, openHarness, SYS, TENANT_A, TENANT_B, uid, type Harness } from '../integration/setup.js';

type Row = Record<string, any>;

// ------------------------------------------------------------------ 05-SCHEMA §5 JSON Schemas, transcribed
const ID = (c: string) => `urn:lims:view:anatomic.v_pub_report_content.${c}`;
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const arr = (col: string, maxItems: number, items: object) => ({ $id: ID(col), type: 'array', maxItems, items });
const obj = (required: string[], properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required, properties });
const str = (maxLength: number) => ({ type: 'string', maxLength });

const SCHEMAS = {
  images: arr('images', 24, obj(['bucket', 'object_path', 'sha256'], {
    bucket: { const: 'anatomic-images' }, object_path: { type: 'string', pattern: '^[0-9a-f-]{36}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.(png|jpg)$' },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, caption: str(200) })),
  synoptic: arr('synoptic', 5, obj(['template_key', 'template_version', 'title', 'sections'], {
    template_key: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' }, template_version: { type: 'integer', minimum: 1 }, title: str(200),
    sections: { type: 'array', items: obj(['heading', 'items'], { heading: str(200), items: { type: 'array', items: obj(['label', 'value'], { label: str(200), value: str(4000) }) } }) } })),
  specimen_parts: arr('specimen_parts', 52, obj(['letter', 'site_text'], { letter: { type: 'string', pattern: '^[A-Z]{1,2}$' }, site_text: str(200), description_text: str(1000) })),
  slides: arr('slides', 200, obj(['label', 'stain_display'], { label: { type: 'string', pattern: '^[A-Z0-9-]{1,32}$' }, stain_display: str(120), adequacy_display: str(300), finding_text: str(2000) })),
  ancillary: arr('ancillary', 50, obj(['stain_kind', 'stain_code', 'stain_display', 'result_text'], {
    stain_kind: { enum: ['special', 'ihc'] }, stain_code: str(32), stain_display: str(120), block_label: str(32), result_text: str(2000) })),
  molecular: arr('molecular', 50, obj(['assay_code', 'assay_display', 'target_code', 'target_display', 'result_code', 'result_display', 'is_abnormal'], {
    assay_code: str(32), assay_display: str(120), target_code: str(32), target_display: str(120), result_code: str(32), result_display: str(120), is_abnormal: { type: 'boolean' },
    value_decimal: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' }, unit_code: str(32), method_text: str(200), kit_name: str(120), kit_lot: str(64),
    kit_expiry_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, batch_no: str(20), comment_text: str(1000) })),
  addenda: arr('addenda', 50, obj(['seq', 'kind', 'text', 'signed_by_membership_id', 'signed_at'], {
    seq: { type: 'integer', minimum: 1 }, kind: { enum: ['ihc', 'special_stain', 'molecular', 'other'] }, text: str(8000),
    signed_by_membership_id: { type: 'string', pattern: UUID_RE }, signed_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' } })),
  diagnosis_codes: arr('diagnosis_codes', 20, obj(['code', 'display', 'system'], { code: str(64), display: str(300), system: str(32), system_version: str(32) })),
} as const;
type Col = keyof typeof SCHEMAS;
const JSON_COLS = Object.keys(SCHEMAS) as Col[];

/** 03-IC §6.8 + CR-C11-001, in 05-SCHEMA §8 order. A view reports every column nullable in the catalog, so nullability is proven by data (change_reason_code null round-trips). */
const COLUMNS: readonly [string, string][] = [
  ['tenant_id', 'uuid'], ['entity_id', 'uuid'], ['version_no', 'int4'], ['order_item_id', 'uuid'], ['accession_no', 'text'], ['case_kind', 'text'],
  ['gross_text', 'text'], ['microscopy_text', 'text'], ['impression_text', 'text'], ['synoptic', 'jsonb'], ['images', 'jsonb'],
  ['signed_by_membership_id', 'uuid'], ['signed_at', 'timestamptz'],
  ['version_kind', 'text'], ['scope', 'text'], ['change_reason_code', 'text'], ['clinical_history_text', 'text'], ['comment_text', 'text'],
  ['specimen_parts', 'jsonb'], ['slides', 'jsonb'], ['ancillary', 'jsonb'], ['molecular', 'jsonb'], ['addenda', 'jsonb'], ['diagnosis_codes', 'jsonb'],
];

const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => { compile(s: object): ((x: unknown) => boolean) & { errors?: unknown[] | null } };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validators = Object.fromEntries(JSON_COLS.map((c) => [c, ajv.compile(SCHEMAS[c])])) as Record<Col, ((x: unknown) => boolean) & { errors?: unknown[] | null }>;
const errs = (c: Col, x: unknown): string[] => (validators[c](x) ? [] : (validators[c].errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`));

// ------------------------------------------------------------------ fixtures (valid element per column; synthetic)
const U1 = '0190c411-0000-7000-8000-000000009001';
const SHA = 'a'.repeat(64);
const IMG = { bucket: 'anatomic-images', object_path: `${TENANT_A}/2026/11/${U1}.jpg`, sha256: SHA, caption: 'Synthetic field 1' };
const SYN = { template_key: 'breast_invasive', template_version: 1, title: 'Synthetic checklist', sections: [{ heading: 'Tumour', items: [{ label: 'Site', value: 'Antrum' }] }] };
const PART = { letter: 'A', site_text: 'Antrum', description_text: 'Two fragments' };
const SLIDE = { label: 'A1-HE', stain_display: 'Haematoxylin and eosin', adequacy_display: 'Adequate', finding_text: 'Mild gastritis' };
const ANC = { stain_kind: 'ihc', stain_code: 'ck7', stain_display: 'CK7', block_label: 'A1', result_text: 'Positive' };
const MOL = { assay_code: 'egfr', assay_display: 'EGFR panel', target_code: 'l858r', target_display: 'L858R', result_code: 'detected', result_display: 'Detected', is_abnormal: true,
  value_decimal: '12.50', unit_code: 'pct', method_text: 'Synthetic PCR', kit_name: 'Synthetic kit', kit_lot: 'LOT-1', kit_expiry_on: '2027-01-31', batch_no: 'B-001', comment_text: 'Synthetic comment' };
const ADD = { seq: 1, kind: 'ihc', text: 'CK7 positive.', signed_by_membership_id: U1, signed_at: '2026-11-13T06:00:00.000Z' };
const DX = { code: 'K29.5', display: 'Chronic gastritis', system: 'icd10', system_version: '2019' };
const VALID: Record<Col, Row> = { images: IMG, synoptic: SYN, specimen_parts: PART, slides: SLIDE, ancillary: ANC, molecular: MOL, addenda: ADD, diagnosis_codes: DX };
const MAX: Record<Col, number> = { images: 24, synoptic: 5, specimen_parts: 52, slides: 200, ancillary: 50, molecular: 50, addenda: 50, diagnosis_codes: 20 };
const omit = (o: Row, k: string): Row => { const { [k]: _x, ...r } = o; return r; };

// ================================================================== part 1 — contract, no database
describe('T-17 view JSON contract (05-SCHEMA §5), no database', () => {
  it.each(JSON_COLS)('AC-09.8 %s: `[]`, a complete element and an element with every optional key omitted are accepted', (col) => {
    expect(errs(col, [])).toEqual([]);
    expect(errs(col, [VALID[col]])).toEqual([]);
    const required = (SCHEMAS[col].items as any).required as string[];
    expect(errs(col, [Object.fromEntries(required.map((k) => [k, VALID[col]![k]]))])).toEqual([]);
  });

  it.each(JSON_COLS)('AC-09.8 %s: a missing required key, an extra key and a non-array are rejected', (col) => {
    for (const k of (SCHEMAS[col].items as any).required as string[]) expect(errs(col, [omit(VALID[col], k)]).length, `missing ${k}`).toBeGreaterThan(0);
    expect(errs(col, [{ ...VALID[col], id: U1 }]).length, 'extra key id').toBeGreaterThan(0);
    expect(errs(col, [{ ...VALID[col], tenant_id: TENANT_A }]).length, 'extra key tenant_id').toBeGreaterThan(0);
    expect(errs(col, { ...VALID[col] }).length, 'object instead of array').toBeGreaterThan(0);
    expect(errs(col, null).length, 'null').toBeGreaterThan(0);
  });

  it.each(JSON_COLS)('AC-09.8 %s: exactly the §5 maximum number of elements passes, one more fails', (col) => {
    expect(errs(col, Array.from({ length: MAX[col] }, () => VALID[col]))).toEqual([]);
    expect(errs(col, Array.from({ length: MAX[col] + 1 }, () => VALID[col])).length).toBeGreaterThan(0);
  });

  it.each<[Col, string, Row]>([
    ['images', 'bucket other than anatomic-images', { ...IMG, bucket: 'other' }], ['images', 'sha256 upper-case', { ...IMG, sha256: 'A'.repeat(64) }], ['images', 'sha256 63 chars', { ...IMG, sha256: 'a'.repeat(63) }],
    ['images', 'caption 201 chars', { ...IMG, caption: 'x'.repeat(201) }], ['images', 'object_path with a traversal', { ...IMG, object_path: '../../etc/passwd' }],
    ['images', 'object_path with another extension', { ...IMG, object_path: `${TENANT_A}/2026/11/${U1}.svg` }],
    ['synoptic', 'template_key upper-case start', { ...SYN, template_key: 'Breast' }], ['synoptic', 'template_key 41 chars', { ...SYN, template_key: 'a'.repeat(41) }],
    ['synoptic', 'template_version 0', { ...SYN, template_version: 0 }], ['synoptic', 'title 201 chars', { ...SYN, title: 'x'.repeat(201) }],
    ['synoptic', 'item value 4001 chars', { ...SYN, sections: [{ heading: 'h', items: [{ label: 'l', value: 'x'.repeat(4001) }] }] }],
    ['synoptic', 'item label 201 chars', { ...SYN, sections: [{ heading: 'h', items: [{ label: 'x'.repeat(201), value: 'v' }] }] }],
    ['synoptic', 'section heading 201 chars', { ...SYN, sections: [{ heading: 'x'.repeat(201), items: [] }] }],
    ['synoptic', 'section with an extra key', { ...SYN, sections: [{ heading: 'h', items: [], key: 'k' }] }],
    ['synoptic', 'item value as number', { ...SYN, sections: [{ heading: 'h', items: [{ label: 'l', value: 3 }] }] }],
    ['specimen_parts', 'letter lower-case', { ...PART, letter: 'a' }], ['specimen_parts', 'letter 3 chars', { ...PART, letter: 'AAA' }], ['specimen_parts', 'site_text 201 chars', { ...PART, site_text: 'x'.repeat(201) }],
    ['specimen_parts', 'description_text 1001 chars', { ...PART, description_text: 'x'.repeat(1001) }],
    ['slides', 'label lower-case', { ...SLIDE, label: 'a1-he' }], ['slides', 'label 33 chars', { ...SLIDE, label: 'A'.repeat(33) }], ['slides', 'stain_display 121 chars', { ...SLIDE, stain_display: 'x'.repeat(121) }],
    ['slides', 'adequacy_display 301 chars', { ...SLIDE, adequacy_display: 'x'.repeat(301) }], ['slides', 'finding_text 2001 chars', { ...SLIDE, finding_text: 'x'.repeat(2001) }],
    ['slides', 'include_in_report leaked', { ...SLIDE, include_in_report: true }],
    ['ancillary', 'stain_kind routine', { ...ANC, stain_kind: 'routine' }], ['ancillary', 'stain_code 33 chars', { ...ANC, stain_code: 'x'.repeat(33) }],
    ['ancillary', 'result_text 2001 chars', { ...ANC, result_text: 'x'.repeat(2001) }], ['ancillary', 'block_label 33 chars', { ...ANC, block_label: 'x'.repeat(33) }],
    ['molecular', 'is_abnormal as string', { ...MOL, is_abnormal: 'true' }], ['molecular', 'value_decimal not a decimal string', { ...MOL, value_decimal: '1e5' }],
    ['molecular', 'value_decimal as number', { ...MOL, value_decimal: 12.5 }], ['molecular', 'kit_expiry_on not a date', { ...MOL, kit_expiry_on: '31/01/2027' }],
    ['molecular', 'batch_no 21 chars', { ...MOL, batch_no: 'x'.repeat(21) }], ['molecular', 'kit_lot 65 chars', { ...MOL, kit_lot: 'x'.repeat(65) }], ['molecular', 'comment_text 1001 chars', { ...MOL, comment_text: 'x'.repeat(1001) }],
    ['molecular', 'assay_display 121 chars', { ...MOL, assay_display: 'x'.repeat(121) }],
    ['addenda', 'seq 0', { ...ADD, seq: 0 }], ['addenda', 'kind not in enum', { ...ADD, kind: 'note' }], ['addenda', 'text 8001 chars', { ...ADD, text: 'x'.repeat(8001) }],
    ['addenda', 'signed_by_membership_id not a uuid', { ...ADD, signed_by_membership_id: 'abc' }], ['addenda', 'signed_at without Z', { ...ADD, signed_at: '2026-11-13 06:00:00' }],
    ['addenda', 'signed_at as Date-like number', { ...ADD, signed_at: 1763013600000 }],
    ['diagnosis_codes', 'code 65 chars', { ...DX, code: 'x'.repeat(65) }], ['diagnosis_codes', 'display 301 chars', { ...DX, display: 'x'.repeat(301) }],
    ['diagnosis_codes', 'system 33 chars', { ...DX, system: 'x'.repeat(33) }], ['diagnosis_codes', 'system_version 33 chars', { ...DX, system_version: 'x'.repeat(33) }],
  ])('AC-09.8 %s element rejected: %s', (col, _n, el) => { expect(errs(col, [el]).length).toBeGreaterThan(0); });

  it.each([['A'], ['Z'], ['AA'], ['ZZ']])('AC-09.8 specimen_parts letter %s accepted; ancillary kinds special/ihc and addendum kinds ihc/special_stain/molecular/other accepted', (letter) => {
    expect(errs('specimen_parts', [{ ...PART, letter }])).toEqual([]);
    for (const stain_kind of ['special', 'ihc']) expect(errs('ancillary', [{ ...ANC, stain_kind }])).toEqual([]);
    for (const kind of ['ihc', 'special_stain', 'molecular', 'other']) expect(errs('addenda', [{ ...ADD, kind }])).toEqual([]);
  });

  it('AC-09.8 the real snapshot builder agrees with the contract: buildContent output (scope full, every section filled) validates against all eight schemas', () => {
    const DEF = { schema_version: 1, title: 'Synthetic checklist', applies_to_case_kinds: ['histology'], sections: [{ key: 'tumour', heading: 'Tumour', fields: [
      { key: 'site', label: 'Site', type: 'text', required: true },
      { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] },
      { key: 'size_mm', label: 'Size', type: 'integer', required: false, unit_text: 'mm' }] }] };
    const out = buildContent({
      scope: 'full', clinical_history_text: 'Epigastric pain.',
      draft: { gross_text: 'g', microscopy_text: 'm', impression_text: 'i', comment_text: 'c', flag: 'A', is_critical: true },
      parts: [{ id: 'p', tenant_id: TENANT_A, letter: 'B', site_text: 'Body' }, { id: 'p2', tenant_id: TENANT_A, ...PART }],
      synoptic: [{ template_key: 'breast_invasive', template_version: 1, definition: DEF, values: { site: 'Antrum', grade: 'g1', size_mm: 12 } }],
      images: [{ id: 'i', tenant_id: TENANT_A, state: 'ready', ...IMG }], slides: [{ id: 's', include_in_report: true, ...SLIDE }, { id: 's2', include_in_report: false, label: 'A2-HE', stain_display: 'x' }],
      ancillary: [{ id: 'a', ...ANC }], molecular: [{ id: 'm', tenant_id: TENANT_A, ...MOL }], addenda: [{ id: 'd', ...ADD, signed_at: new Date('2026-11-13T06:00:00.000Z') }], diagnosis_codes: [{ id: 'c', ...DX }],
    } as never) as Row;
    for (const col of JSON_COLS) { expect(errs(col, out[col]), col).toEqual([]); expect(out[col].length, `${col} non-empty`).toBeGreaterThan(0); }
    expect(out['slides']).toHaveLength(1);
  });

  it('AC-09.8 the real snapshot builder agrees with the contract for scope addendum_only (header + addenda only) and for an empty case', () => {
    const empty = { scope: 'full', draft: {}, parts: [], synoptic: [], images: [], slides: [], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [] };
    for (const input of [empty, { ...empty, scope: 'addendum_only', addenda: [{ ...ADD }], ancillary: [{ ...ANC }], molecular: [{ ...MOL }], images: [{ ...IMG }] }]) {
      const out = buildContent(input as never) as Row;
      for (const col of JSON_COLS) expect(errs(col, out[col]), `${input.scope} ${col}`).toEqual([]);
    }
  });

  const SPEC = join(REPO_ROOT, 'spec', 'chunks', 'C11-specialty-pathology', '05-SCHEMA.md');
  it.skipIf(!existsSync(SPEC))('AC-09.8 the COLUMNS list of this test equals the column list of 05-SCHEMA §8 (names and order) — no drift between spec and contract test', () => {
    const text = readFileSync(SPEC, 'utf8');
    const start = text.indexOf('CREATE VIEW anatomic.v_pub_report_content'); const end = text.indexOf('FROM anatomic.item_submissions', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const names = [...text.slice(start, end).matchAll(/\bAS (\w+),?\s*(?:--|\n)/g)].map((m) => m[1]);
    expect(names).toEqual(COLUMNS.map(([n]) => n));
  });

  const FILE = join(REPO_ROOT, 'contracts', 'views', 'anatomic.v_pub_report_content.schema.json');
  it.skipIf(!existsSync(FILE))('C0 transcription contracts/views/anatomic.v_pub_report_content.schema.json holds the eight schemas, equal to 05-SCHEMA §5', () => {
    const doc = JSON.parse(readFileSync(FILE, 'utf8'));
    const found: Row[] = []; const walk = (n: any): void => { if (n && typeof n === 'object') { if (typeof n['$id'] === 'string') found.push(n); for (const v of Object.values(n)) walk(v); } }; walk(doc);
    const by = Object.fromEntries(found.map((s) => [s['$id'], s]));
    for (const col of JSON_COLS) expect(by[ID(col)], col).toBeDefined();
    // compile C0's copy and require it to accept/reject exactly like the transcription above
    for (const col of JSON_COLS) {
      const v = new Ajv2020({ strict: false, allErrors: true }).compile(by[ID(col)]);
      expect(v([VALID[col]]), `${col} valid`).toBe(true); expect(v([{ ...VALID[col], id: U1 }]), `${col} extra key`).toBe(false);
      expect(v(Array.from({ length: MAX[col] + 1 }, () => VALID[col])), `${col} over max`).toBe(false);
    }
  });
});

// ================================================================== part 2 — the view in the migrated database
const REQUIRE = process.env['LIMS_T17_REQUIRE_DB'] === '1';
const VIEW = 'anatomic.v_pub_report_content';
const TS = '2026-11-01T00:00:00.000Z';
const base = { created_at: TS, updated_at: TS, created_by: SYS, updated_by: SYS, version: 1 };
const N = (n: number) => uid(17000 + n); // fixture ids 0190c411-… (removed by h.cleanup()); 17xxx cannot collide with the other C11 live tests
const SIGNER = '01a1a98a-ac40-7000-8000-00000000a500';

describe.skipIf(!LIVE && !REQUIRE)('T-17 anatomic.v_pub_report_content (live DB)', () => {
  let h: Harness;
  it('database is provided', () => { expect(LIVE, 'set LIMS_TEST_DATABASE_URL (superuser) and LIMS_TEST_APP_DATABASE_URL (lims_app)').toBe(true); });
  beforeAll(async () => { if (!LIVE) return; h = await openHarness(); await h.cleanup(); }, 120_000);
  afterAll(async () => { if (h) { await h.cleanup().catch(() => undefined); await h.close(); } });

  const su = async (sql: string, v: unknown[] = []): Promise<Row[]> => h.asSuperuser(async (tx) => (await tx.query(sql, v)).rows);
  const app = async (claims: Record<string, unknown>, sql: string, v: unknown[] = []): Promise<Row[]> => h.asApp(claims, async (tx: any) => (await tx.query(sql, v)).rows);

  /** one signed case: case + item + report version(s) + submission(s). n = fixture number (1..): ids N(n*100 + k). */
  const CONTENT = (v: number): Row => ({
    clinical_history_text: 'Epigastric pain for 3 months.', gross_text: `Gross ${v}`, microscopy_text: `Micro ${v}`, impression_text: `Impression ${v}`, comment_text: v === 1 ? '' : 'Synthetic comment',
    synoptic: [SYN], images: [IMG], specimen_parts: [PART], slides: [SLIDE], ancillary: [ANC], molecular: [MOL], addenda: v === 1 ? [] : [ADD], diagnosis_codes: [DX],
  });
  async function seedSigned(n: number, o: { tenant?: string; centre?: string; versions?: number[]; unsubmitted?: number[]; kind?: string } = {}) {
    const tenant = o.tenant ?? TENANT_A, centre = o.centre ?? CENTRE_A1;
    const caseId = N(n * 100 + 1), itemId = N(n * 100 + 2), orderItemId = N(n * 100 + 3);
    const accession = `S99-17${String(n).padStart(2, '0')}`;
    await h.seed('anatomic.cases', { ...caseRow(caseId, tenant, centre, { order_id: N(n * 100 + 4), patient_id: N(n * 100 + 5), status: 'signed_out', accession_no: accession, accessioned_at: TS, signed_out_at: TS,
      current_version_no: Math.max(...(o.versions ?? [1])), case_kind: o.kind ?? 'histology', clinical_history_text: 'Epigastric pain for 3 months.' }), ...base, molecular_rev: 0, profile_missing: false });
    await h.seed('anatomic.case_items', { id: itemId, tenant_id: tenant, centre_id: centre, case_id: caseId, order_item_id: orderItemId, test_id: N(n * 100 + 6), role: 'primary', lab_approved_version_no: 0, lab_approved_at: null, is_active: true, ...base });
    const rows: Row[] = [];
    for (const v of [...(o.versions ?? [1]), ...(o.unsubmitted ?? [])]) {
      const kind = v === 1 ? 'original' : 'amendment';
      const rv: Row = { id: N(n * 100 + 10 + v), tenant_id: tenant, centre_id: centre, case_id: caseId, version_no: v, version_kind: kind, scope: 'full', change_reason_code: v === 1 ? null : 'typographical_error',
        ...CONTENT(v), flag: 'N', is_critical: false, signed_by_membership_id: SIGNER, signed_at: `2026-11-0${v}T06:00:00.000Z`, created_at: TS, created_by: SYS };
      await h.seed('anatomic.report_versions', rv); rows.push(rv);
      if (!(o.unsubmitted ?? []).includes(v)) {
        await h.seed('anatomic.item_submissions', { id: N(n * 100 + 30 + v), tenant_id: tenant, centre_id: centre, case_id: caseId, case_item_id: itemId, item_version_no: v, report_version_id: rv['id'],
          idempotency_key: `anatomic:${itemId}:${v}`, lab_result_id: N(n * 100 + 50 + v), lab_version_no: v, lab_status: 'resulted', replayed: false, submitted_at: TS, created_at: TS, created_by: SYS });
      }
    }
    return { caseId, itemId, orderItemId, accession, rows };
  }
  const viewRows = (claims: Record<string, unknown>, entity: string) => app(claims, `SELECT * FROM ${VIEW} WHERE entity_id = $1 ORDER BY version_no`, [entity]);
  const same = (a: unknown, b: unknown) => new Date(a as never).getTime() === new Date(b as never).getTime();

  describe('catalog: the view is the published contract (05-SCHEMA §8, §11 test 5, REQ-SEC-031)', () => {
    it('is a plain view in schema anatomic with exactly the 24 columns of 03-IC §6.8 + CR-C11-001, in order, with the contract types', async () => {
      const rel = await su(`SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'anatomic' AND c.relname = 'v_pub_report_content'`);
      expect(rel, 'view anatomic.v_pub_report_content exists (C0 prerequisite: not in db/migrations yet)').toEqual([{ relkind: 'v' }]);
      const cols = await su(`SELECT a.attname AS name, t.typname AS type FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = 'anatomic.v_pub_report_content'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
      expect(cols.map((r) => [r['name'], r['type']])).toEqual(COLUMNS.map(([n, t]) => [n, t]));
      expect(cols).toHaveLength(24);
    });

    it('REQ-SEC-031 security_invoker is on (reloptions)', async () => {
      const [r] = await su(`SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'anatomic' AND c.relname = 'v_pub_report_content'`);
      expect((r?.['reloptions'] as string[] | null) ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/^security_invoker=(true|on)$/)]));
    });

    it('the view reads exactly item_submissions, case_items, report_versions and cases (pg_depend); no other table feeds a column', async () => {
      const deps = await su(`SELECT DISTINCT d.refobjid::regclass::text AS rel FROM pg_rewrite r JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
        WHERE r.ev_class = 'anatomic.v_pub_report_content'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> 'anatomic.v_pub_report_content'::regclass ORDER BY 1`);
      expect(deps.map((r) => r['rel'])).toEqual(['anatomic.case_items', 'anatomic.cases', 'anatomic.item_submissions', 'anatomic.report_versions']);
    });

    it('grants (C0 §9 rule 3): lims_app and lims_analytics have SELECT; nobody gets INSERT/UPDATE/DELETE/TRUNCATE on the view', async () => {
      const [g] = await su(`SELECT has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'SELECT') AS app_s, has_table_privilege('lims_analytics', 'anatomic.v_pub_report_content', 'SELECT') AS an_s,
        has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'INSERT') AS i, has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'UPDATE') AS u,
        has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'DELETE') AS d, has_table_privilege('lims_app', 'anatomic.v_pub_report_content', 'TRUNCATE') AS t`);
      expect(g).toEqual({ app_s: true, an_s: true, i: false, u: false, d: false, t: false });
    });

    it('columns the view must NOT publish (id, case_id, centre_id, flag, is_critical, change_reason_text, addon/addendum ids, lab_*, created_by, report_phase) are not selectable (SQLSTATE 42703)', async () => {
      for (const col of ['id', 'case_id', 'centre_id', 'flag', 'is_critical', 'change_reason_text', 'addon_case_item_id', 'addendum_id', 'lab_result_id', 'created_by', 'report_phase', 'patient_id']) {
        const r = await h.rawApp(CLAIMS.sysA, `SELECT ${col} FROM ${VIEW} LIMIT 1`);
        expect(r, col).toMatch(/^E42703\|/);
      }
    });
  });

  describe('AC-09.8 exactly one row per submitted (entity_id, version_no), equal to the signed content', () => {
    it('two submitted versions: each lookup returns one row whose 24 columns equal the stored version, case and item values; JSON columns validate; change_reason_code NULL for the original', async () => {
      const s = await seedSigned(1, { versions: [1, 2] });
      for (const v of [1, 2]) {
        const rows = await app(CLAIMS.sysA, `SELECT * FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = $3`, [TENANT_A, s.itemId, v]);
        expect(rows, `version ${v}`).toHaveLength(1);
        const row = rows[0]!; const st = s.rows[v - 1]!;
        expect(Object.keys(row)).toEqual(COLUMNS.map(([n]) => n));
        expect(row).toMatchObject({ tenant_id: TENANT_A, entity_id: s.itemId, version_no: v, order_item_id: s.orderItemId, accession_no: s.accession, case_kind: 'histology',
          gross_text: st['gross_text'], microscopy_text: st['microscopy_text'], impression_text: st['impression_text'], signed_by_membership_id: SIGNER, version_kind: st['version_kind'], scope: 'full',
          change_reason_code: st['change_reason_code'], clinical_history_text: st['clinical_history_text'], comment_text: st['comment_text'] });
        expect(same(row['signed_at'], st['signed_at'])).toBe(true);
        for (const col of JSON_COLS) { expect(row[col], `${col} equals the stored jsonb`).toEqual(st[col]); expect(errs(col, row[col]), `v${v} ${col}`).toEqual([]); }
      }
      expect((await viewRows(CLAIMS.sysA, s.itemId)).map((r) => [r['version_no'], r['version_kind']])).toEqual([[1, 'original'], [2, 'amendment']]);
      expect((await viewRows(CLAIMS.sysA, s.itemId))[0]!['change_reason_code']).toBeNull();
      expect(await app(CLAIMS.sysA, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 3`, [TENANT_A, s.itemId])).toEqual([]);
    });

    it('case_kind comes from the case (cytology / ihc / molecular), accession_no from the case', async () => {
      const m = await seedSigned(2, { kind: 'molecular' }); const c = await seedSigned(3, { kind: 'cytology' });
      expect((await viewRows(CLAIMS.sysA, m.itemId))[0]).toMatchObject({ case_kind: 'molecular', accession_no: m.accession });
      expect((await viewRows(CLAIMS.sysA, c.itemId))[0]).toMatchObject({ case_kind: 'cytology', accession_no: c.accession });
    });

    it('a signed version with no item_submissions row (not yet handed to C5 via A1) is NOT in the view; the submitted ones are', async () => {
      const s = await seedSigned(4, { versions: [1], unsubmitted: [2] });
      expect((await viewRows(CLAIMS.sysA, s.itemId)).map((r) => r['version_no'])).toEqual([1]);
    });

    it('the stored jsonb is guarded by the table: non-array jsonb, more than 24 images and more than 5 synoptic blocks are refused (report_versions__json__ck, SQLSTATE 23514)', async () => {
      const s = await seedSigned(5);
      const bad = async (over: Row, id: number) => h.seed('anatomic.report_versions', { ...s.rows[0]!, id: N(500 + id), version_no: 9, version_kind: 'amendment', change_reason_code: 'typographical_error', ...over }).then(() => undefined, (e: unknown) => e as any);
      for (const [i, over] of [{ synoptic: {} }, { images: 'x' }, { slides: {} }, { molecular: {} }, { images: Array.from({ length: 25 }, () => IMG) }, { synoptic: Array.from({ length: 6 }, () => SYN) }].entries()) {
        expect((await bad(over, i) as any)?.code, JSON.stringify(Object.keys(over))).toBe('23514');
      }
    });
  });

  describe('probes (07-SECURITY view probes; 05-SCHEMA §11 test 5): tenant and centre scope through security_invoker', () => {
    it('tenant A claims read zero rows of tenant B — unfiltered, by tenant_id and by entity; B claims read their own', async () => {
      const a = await seedSigned(6, { tenant: TENANT_A, centre: CENTRE_A1 }); const b = await seedSigned(7, { tenant: TENANT_B, centre: CENTRE_B1 });
      expect((await app(CLAIMS.sysA, `SELECT DISTINCT tenant_id FROM ${VIEW}`)).map((r) => r['tenant_id'])).toEqual([TENANT_A]);
      expect(await app(CLAIMS.sysA, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1`, [TENANT_B])).toEqual([]);
      expect(await viewRows(CLAIMS.sysA, b.itemId)).toEqual([]);
      expect(await app(CLAIMS.sysA, `SELECT 1 FROM ${VIEW} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 1`, [TENANT_B, b.itemId])).toEqual([]);
      expect((await viewRows(CLAIMS.sysB, b.itemId)).map((r) => r['entity_id'])).toEqual([b.itemId]);
      expect(await viewRows(CLAIMS.sysB, a.itemId)).toEqual([]);
    });

    it('centre scope: a centre-A1-only staff user sees A1 versions and none of A2; the all-centres user and the tenant system actor (C6) see both; filtering by the A2 entity gives zero rows, not an error', async () => {
      const a1 = await seedSigned(8, { centre: CENTRE_A1 }); const a2 = await seedSigned(9, { centre: CENTRE_A2 });
      expect((await viewRows(CLAIMS.a1Only, a1.itemId)).map((r) => r['version_no'])).toEqual([1]);
      expect(await viewRows(CLAIMS.a1Only, a2.itemId)).toEqual([]);
      expect((await app(CLAIMS.a1Only, `SELECT DISTINCT entity_id FROM ${VIEW} WHERE entity_id = ANY($1::uuid[])`, [[a1.itemId, a2.itemId]])).map((r) => r['entity_id'])).toEqual([a1.itemId]);
      for (const who of [CLAIMS.allA, CLAIMS.sysA]) {
        expect((await app(who, `SELECT DISTINCT entity_id FROM ${VIEW} WHERE entity_id = ANY($1::uuid[])`, [[a1.itemId, a2.itemId]])).map((r) => r['entity_id']).sort()).toEqual([a1.itemId, a2.itemId].sort());
      }
    });

    it('security_invoker is honoured, not the owner: the view returns the same (entity_id, version_no) pairs as the joined base tables read under the same claims', async () => {
      const a1 = await seedSigned(10, { centre: CENTRE_A1, versions: [1, 2] }); const a2 = await seedSigned(11, { centre: CENTRE_A2 });
      for (const who of [CLAIMS.a1Only, CLAIMS.allA]) {
        const ids = [a1.itemId, a2.itemId];
        const viaView = await app(who, `SELECT entity_id, version_no FROM ${VIEW} WHERE entity_id = ANY($1::uuid[]) ORDER BY 1, 2`, [ids]);
        const viaTables = await app(who, `SELECT s.case_item_id AS entity_id, s.item_version_no AS version_no FROM anatomic.item_submissions s WHERE s.case_item_id = ANY($1::uuid[]) ORDER BY 1, 2`, [ids]);
        expect(viaView).toEqual(viaTables);
      }
    });
  });

  describe('immutability: a submitted (entity_id, version_no) row never changes (05-SCHEMA §8 contract notes; 05-SCHEMA §11 test 4)', () => {
    it('appending v2 and later case/item edits leave the v1 view row byte-identical; v2 only appends', async () => {
      const s = await seedSigned(12, { versions: [1] });
      const before = JSON.stringify((await viewRows(CLAIMS.sysA, s.itemId))[0]);
      // a later version arrives, and the case gets a later (allowed) working-row change
      const rv: Row = { ...s.rows[0]!, id: N(1299), version_no: 2, version_kind: 'amendment', change_reason_code: 'typographical_error', ...CONTENT(2), signed_at: '2026-11-02T06:00:00.000Z' };
      await h.seed('anatomic.report_versions', rv);
      await h.seed('anatomic.item_submissions', { id: N(1298), tenant_id: TENANT_A, centre_id: CENTRE_A1, case_id: s.caseId, case_item_id: s.itemId, item_version_no: 2, report_version_id: rv['id'], idempotency_key: `anatomic:${s.itemId}:2`,
        lab_result_id: N(1297), lab_version_no: 2, lab_status: 'resulted', replayed: false, submitted_at: TS, created_at: TS, created_by: SYS });
      await su(`UPDATE anatomic.cases SET priority = 'urgent', updated_at = now() WHERE id = $1`, [s.caseId]);
      const after = await viewRows(CLAIMS.sysA, s.itemId);
      expect(after.map((r) => r['version_no'])).toEqual([1, 2]);
      expect(JSON.stringify(after[0])).toBe(before);
    });

    it('lims_app cannot change what the view shows: UPDATE / DELETE / INSERT on report_versions and item_submissions are refused (SQLSTATE 42501); UPDATE / DELETE / INSERT through the view are refused', async () => {
      const s = await seedSigned(13);
      for (const sql of [
        `UPDATE anatomic.report_versions SET impression_text = 'changed' WHERE id = '${s.rows[0]!['id']}'`, `DELETE FROM anatomic.report_versions WHERE id = '${s.rows[0]!['id']}'`,
        `UPDATE anatomic.item_submissions SET lab_status = 'cancelled' WHERE case_item_id = '${s.itemId}'`, `DELETE FROM anatomic.item_submissions WHERE case_item_id = '${s.itemId}'`,
        `UPDATE ${VIEW} SET impression_text = 'changed' WHERE entity_id = '${s.itemId}'`, `DELETE FROM ${VIEW} WHERE entity_id = '${s.itemId}'`,
      ]) expect(await h.rawApp(CLAIMS.sysA, sql), sql).toMatch(/^E42501\|/);
      expect((await viewRows(CLAIMS.sysA, s.itemId))[0]).toMatchObject({ impression_text: 'Impression 1' });
    });

    it('the same (entity_id, version_no) cannot be submitted twice: item_submissions unique key keeps the view at one row (SQLSTATE 23505)', async () => {
      const s = await seedSigned(14);
      const e: any = await h.seed('anatomic.item_submissions', { id: N(1498), tenant_id: TENANT_A, centre_id: CENTRE_A1, case_id: s.caseId, case_item_id: s.itemId, item_version_no: 1, report_version_id: s.rows[0]!['id'],
        idempotency_key: `anatomic:${s.itemId}:1:dup`, lab_result_id: N(1497), lab_version_no: 1, lab_status: 'resulted', replayed: false, submitted_at: TS, created_at: TS, created_by: SYS }).then(() => undefined, (x: unknown) => x);
      expect(e?.code === '23505' || e?.code === '23514', `unique or key CHECK, got ${e?.code}`).toBe(true);
      expect(await viewRows(CLAIMS.sysA, s.itemId)).toHaveLength(1);
    });
  });
});
