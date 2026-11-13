// Report snapshot (02-TRD §4.6; 05-SCHEMA §6 JSON Schemas; PRD AC-09.7, AC-10.5, AC-15.2, AC-16.1). Pure: no I/O, inputs are never mutated.
// The caller loads the rows (and the code -> display maps); this file decides what is in the snapshot, builds the generated summary text, enforces the size guard
// BEFORE ajv (a violation is the client-visible 422 micro.report_incomplete, so an ajv failure stays a programming error = 500 common.internal, logged without content).
// [CONV] a plate_read / gram_stain that another observation corrects (corrects_observation_id) is superseded and ignored; the DB row stays (AC-04.4).
import { createRequire } from 'node:module';
import { LimsError } from '../../../core/errors.js';

type Row = Record<string, any>;

export const SNAPSHOT_MAX_ISOLATES = 20;
export const SNAPSHOT_MAX_AST = 600;
const SUMMARY_MAX = 4000;
const STANDARDS = ['CLSI', 'EUCAST', 'ECOFF'];

export interface SnapshotInput {
  phase: 'preliminary' | 'final';
  isolates: Row[]; ast: Row[]; observations: Row[];
  organisms: Record<string, string>; antibiotics: Record<string, string>;
  growthCodes: Record<string, { display: string; indicates_growth: boolean }>;
  outcome?: { code: string; display: string; result_flag: 'N' | 'A' } | undefined;
  summaryText?: string | undefined;
  isCritical: boolean;
}
export interface Snapshot {
  isolates: Array<{ seq: number; organism_code: string; organism_display: string; growth_text: string }>;
  ast: Array<{ isolate_seq: number; antibiotic_code: string; antibiotic_display: string; method: string; raw_value: string; category_code: string; standard: string; standard_version: string }>;
  culture_summary_text: string; submission_kind: 'ast_panel' | 'organism' | 'structured'; flag: 'N' | 'A'; is_critical: boolean;
}

const ms = (v: unknown): number => new Date(v as string | number | Date).getTime();
const byTime = (a: Row, b: Row): number => ms(a['observed_at']) - ms(b['observed_at']) || String(a['id']).localeCompare(String(b['id']));
const has = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/** Isolates that go on the report: identified, reportable (withdrawn / pending_id never), by isolate_seq. */
export const snapshotIsolates = (rows: readonly Row[]): Row[] =>
  rows.filter((i) => i['status'] === 'identified' && i['is_reportable'] === true && has(i['organism_code'])).sort((a, b) => Number(a['isolate_seq']) - Number(b['isolate_seq']));

/** AST rows that are candidates for the report: reportable, shown (suppressed_by_rule stays stored, AC-16.1), of a snapshot isolate. */
export function candidateAst(rows: readonly Row[], isolates: readonly Row[]): Row[] {
  const ids = new Set(isolates.map((i) => i['id']));
  return rows.filter((a) => a['is_reportable'] === true && a['report_visibility'] === 'shown' && ids.has(a['isolate_id']));
}

/** A candidate row is complete when the §6 schema can hold it: value, category, a known standard and its version. */
export const astComplete = (a: Row): boolean => has(a['raw_value']) && has(a['category_code']) && STANDARDS.includes(a['standard']) && has(a['standard_version']);

/** Observations that no other observation corrects. */
const current = (obs: readonly Row[]): Row[] => {
  const corrected = new Set(obs.map((o) => o['corrects_observation_id']).filter((x) => x != null));
  return obs.filter((o) => !corrected.has(o['id']));
};

const tooMany = (path: string): { path: string; code: string; message: string } => ({ path, code: 'too_many_items', message: 'Too many items for a report snapshot' });

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const obs = current(input.observations).sort(byTime);
  const reads = obs.filter((o) => o['kind'] === 'plate_read');
  const iso = snapshotIsolates(input.isolates);
  const seqOf = new Map(iso.map((i) => [i['id'], Number(i['isolate_seq'])]));
  const growthDisplay = (code: unknown): string => (typeof code === 'string' ? input.growthCodes[code]?.display ?? '' : '');

  const isolates = iso.map((i) => {
    const onPlate = reads.filter((r) => r['plate_id'] != null && r['plate_id'] === i['plate_id']);
    const growth = has(i['quantity_text']) ? String(i['quantity_text']) : growthDisplay(onPlate[onPlate.length - 1]?.['growth_code']);
    return { seq: Number(i['isolate_seq']), organism_code: String(i['organism_code']), organism_display: input.organisms[i['organism_code']] ?? String(i['organism_code']), growth_text: growth };
  });
  const display = (a: Row): string => input.antibiotics[a['antibiotic_code']] ?? String(a['antibiotic_code']);
  const panelOrder = (a: Row): number => (a['panel_sort_order'] == null ? Number.MAX_SAFE_INTEGER : Number(a['panel_sort_order']));
  const ast = candidateAst(input.ast, iso).filter(astComplete)
    .map((a) => ({ a, seq: seqOf.get(a['isolate_id'])! }))
    .sort((x, y) => x.seq - y.seq || panelOrder(x.a) - panelOrder(y.a) || display(x.a).localeCompare(display(y.a)))
    .map(({ a, seq }) => ({ isolate_seq: seq, antibiotic_code: String(a['antibiotic_code']), antibiotic_display: display(a), method: String(a['method']), raw_value: String(a['raw_value']),
      category_code: String(a['category_code']), standard: String(a['standard']), standard_version: String(a['standard_version']) }));

  const guard = [...(isolates.length > SNAPSHOT_MAX_ISOLATES ? [tooMany('/isolates')] : []), ...(ast.length > SNAPSHOT_MAX_AST ? [tooMany('/ast')] : [])];
  if (guard.length > 0) throw new LimsError('micro.report_incomplete', undefined, guard);   // AC-09.7, review m#28: before ajv

  const final = input.phase === 'final';
  if (final && !input.outcome) throw new LimsError('common.internal');   // the service refuses a final without an outcome (AC-10.1) before this point
  const flag: 'N' | 'A' = final ? input.outcome!.result_flag
    : isolates.length > 0 || reads.some((r) => input.growthCodes[r['growth_code']]?.indicates_growth === true) ? 'A' : 'N';
  return {
    isolates, ast,
    culture_summary_text: input.summaryText ?? generatedSummary(input, obs, reads, isolates),
    submission_kind: ast.length > 0 ? 'ast_panel' : isolates.length > 0 ? 'organism' : 'structured',
    flag, is_critical: input.isCritical,
  };
}

/** [CONV] generated text (02-TRD §4.6): line 1, Gram stain, one line per snapshot isolate, "No growth after <h> h"; lines joined with \n; cut to 4000 with "…". */
function generatedSummary(input: SnapshotInput, obs: Row[], reads: Row[], isolates: Snapshot['isolates']): string {
  const lines = [input.phase === 'final' ? `Final: ${input.outcome!.display}` : 'Preliminary report'];
  const stain = obs.filter((o) => o['kind'] === 'gram_stain' && has(o['finding_text'])).pop();
  if (stain) lines.push(`Gram stain: ${stain['finding_text']}`);
  for (const i of isolates) lines.push(`Isolate ${i.seq}: ${i.organism_display}${i.growth_text ? ` — ${i.growth_text}` : ''}`);
  const last = reads[reads.length - 1];
  if (input.phase === 'preliminary' && isolates.length === 0 && last && input.growthCodes[last['growth_code']]?.indicates_growth === false && last['hours_since_planting'] != null) {
    lines.push(`No growth after ${Math.floor(Number(last['hours_since_planting']))} h`);
  }
  const text = lines.join('\n');
  const chars = Array.from(text);   // code points: never cut a surrogate pair
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : text;
}

// ---------------------------------------------------------------- ajv (05-SCHEMA §6)
// [CONV] ajv is not a direct services/api dependency (lockfile is C0-0A's, LD-05): load the ajv that @fastify/ajv-compiler ships (same as core/events/publish.ts).
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => { compile(s: object): ((x: unknown) => boolean) };

const ISOLATES_SCHEMA = { type: 'array', maxItems: SNAPSHOT_MAX_ISOLATES, items: { type: 'object', additionalProperties: false, required: ['seq', 'organism_code', 'organism_display', 'growth_text'], properties: {
  seq: { type: 'integer', minimum: 1, maximum: 99 }, organism_code: { type: 'string', minLength: 1, maxLength: 64 },
  organism_display: { type: 'string', minLength: 1, maxLength: 200 }, growth_text: { type: 'string', maxLength: 200 } } } };
const AST_SCHEMA = { type: 'array', maxItems: SNAPSHOT_MAX_AST, items: { type: 'object', additionalProperties: false,
  required: ['isolate_seq', 'antibiotic_code', 'antibiotic_display', 'method', 'raw_value', 'category_code', 'standard', 'standard_version'], properties: {
    isolate_seq: { type: 'integer', minimum: 1, maximum: 99 }, antibiotic_code: { type: 'string', minLength: 1, maxLength: 64 }, antibiotic_display: { type: 'string', minLength: 1, maxLength: 200 },
    method: { enum: ['mic', 'zone_diameter', 'other'] }, raw_value: { type: 'string', minLength: 1, maxLength: 32 }, category_code: { type: 'string', minLength: 1, maxLength: 8 },
    standard: { enum: STANDARDS }, standard_version: { type: 'string', minLength: 1, maxLength: 32 } } } };
let validators: { isolates: (x: unknown) => boolean; ast: (x: unknown) => boolean } | undefined;

/** AC-15.2: any failure is a programming error (common.internal); the error carries no row content and ajv's error list is dropped. */
export function validateSnapshot(s: { isolates: unknown; ast: unknown }): void {
  if (!validators) { const ajv = new Ajv2020({ strict: true, allErrors: false }); validators = { isolates: ajv.compile(ISOLATES_SCHEMA), ast: ajv.compile(AST_SCHEMA) }; }
  if (!validators.isolates(s.isolates) || !validators.ast(s.ast)) throw new LimsError('common.internal');
}
