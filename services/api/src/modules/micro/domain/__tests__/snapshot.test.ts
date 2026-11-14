// C10 T-15 — domain/snapshot.ts, pure (no I/O): report snapshot builder + ajv validation + size guard
// (02-TRD §4.6; 05-SCHEMA §6 JSON Schemas; PRD AC-09.7, AC-10.5, AC-15.2, AC-16.1; 06-IMPLEMENTATION-PLAN T-15).
// SEAM (the spec names the file, not the functions - ASSUMED, flagged so a ruling can overrule): domain/snapshot.ts exports
//   buildSnapshot(input) -> { isolates, ast, culture_summary_text, submission_kind, flag, is_critical }       (throws LimsError micro.report_incomplete on the size guard, before ajv)
//   validateSnapshot({ isolates, ast, culture_summary_text? }) -> void                                        (ajv, 05-SCHEMA §6; failure = LimsError common.internal, no row content in message/detail)
//   SNAPSHOT_MAX_ISOLATES = 20, SNAPSHOT_MAX_AST = 600
// input (all plain rows as read from the tables / coded-set views; the builder does no I/O, the caller loads them):
//   { phase: 'preliminary'|'final', isolates: isolate rows, ast: ast_results rows, observations: culture_observations rows, organisms: { code -> display }, antibiotics: { code -> display },
//     growthCodes: { code -> { display, indicates_growth } }, outcome?: { code, display, result_flag }, summaryText?: string (client supplied), isCritical: boolean, plantedAt: Date | null }
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { buildSnapshot, SNAPSHOT_MAX_AST, SNAPSHOT_MAX_ISOLATES, validateSnapshot } from '../snapshot.js';

type Row = Record<string, any>;
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CULTURE = u(1), PLATE1 = u(0x21), PLATE2 = u(0x22);
const PLANTED = new Date('2026-11-04T05:00:00.000Z');

const iso = (seq: number, over: Row = {}): Row => ({ id: u(0x100 + seq), culture_id: CULTURE, isolate_seq: seq, plate_id: PLATE1, status: 'identified', organism_code: 'syn_ecoli', is_reportable: true, quantity_text: null,
  withdraw_reason_code: null, ...over });
const astRow = (isolateSeq: number, abx: string, over: Row = {}): Row => ({ id: u(0x1000 + isolateSeq * 100 + abx.length), isolate_id: u(0x100 + isolateSeq), antibiotic_code: abx, method: 'mic', raw_value: '2', category_code: 'S',
  standard: 'CLSI', standard_version: 'M100-2026', is_reportable: true, report_visibility: 'shown', panel_sort_order: 1, ...over });
const obs = (n: number, kind: string, over: Row = {}): Row => ({ id: u(0x500 + n), culture_id: CULTURE, kind, plate_id: kind === 'plate_read' ? PLATE1 : null, growth_code: kind === 'plate_read' ? 'syn_growth' : null,
  finding_text: kind === 'plate_read' ? null : 'x', observed_at: new Date(`2026-11-04T0${n}:00:00.000Z`), hours_since_planting: 4 * n, corrects_observation_id: null, ...over });

const BASE = () => ({
  phase: 'final' as 'preliminary' | 'final', isolates: [] as Row[], ast: [] as Row[], observations: [] as Row[],
  organisms: { syn_ecoli: 'Synthetic E. coli', syn_staph: 'Synthetic S. aureus' } as Record<string, string>,
  antibiotics: { syn_amp: 'Synthetic ampicillin', syn_cip: 'Synthetic ciprofloxacin', syn_gen: 'Synthetic gentamicin' } as Record<string, string>,
  growthCodes: { syn_growth: { display: 'Synthetic growth', indicates_growth: true }, no_growth: { display: 'No growth', indicates_growth: false }, syn_few: { display: 'Synthetic few colonies', indicates_growth: true } } as Record<string, { display: string; indicates_growth: boolean }>,
  outcome: { code: 'growth_reported', display: 'Growth - see isolates', result_flag: 'A' } as { code: string; display: string; result_flag: 'N' | 'A' } | undefined,
  summaryText: undefined as string | undefined, isCritical: false, plantedAt: PLANTED as Date | null, now: new Date('2026-11-05T05:00:00.000Z'),
});
const snap = (over: Row = {}) => buildSnapshot({ ...BASE(), ...over } as any) as Row;

describe('C10-T15 snapshot: isolates[] (02-TRD §4.6, AC-10.5)', () => {
  it('only identified, reportable isolates, ordered by isolate_seq; keys exactly seq, organism_code, organism_display, growth_text (AC-15.2)', () => {
    const s = snap({ isolates: [iso(3), iso(1, { organism_code: 'syn_staph' }), iso(2, { status: 'pending_id', organism_code: null }), iso(4, { is_reportable: false }), iso(5, { status: 'withdrawn', withdraw_reason_code: 'duplicate' })] });
    expect(s['isolates'].map((i: Row) => i['seq'])).toEqual([1, 3]);
    expect(Object.keys(s['isolates'][0]).sort()).toEqual(['growth_text', 'organism_code', 'organism_display', 'seq']);
    expect(s['isolates'][0]).toMatchObject({ seq: 1, organism_code: 'syn_staph', organism_display: 'Synthetic S. aureus' });
  });
  it('growth_text = isolate quantity_text if set, else the display of the latest growth code read on the isolate\'s plate, else "" (05-SCHEMA §6)', () => {
    const observations = [obs(1, 'plate_read', { growth_code: 'syn_few' }), obs(2, 'plate_read', { growth_code: 'syn_growth' }), obs(3, 'plate_read', { plate_id: PLATE2, growth_code: 'no_growth' })];
    const s = snap({ isolates: [iso(1, { quantity_text: 'Synthetic heavy' }), iso(2), iso(3, { plate_id: null })], observations });
    expect(s['isolates'].map((i: Row) => i['growth_text'])).toEqual(['Synthetic heavy', 'Synthetic growth', '']);
  });
});

describe('C10-T15 snapshot: ast[] (02-TRD §4.6, AC-10.5, AC-16.1)', () => {
  const isolates = [iso(1), iso(2), iso(3, { is_reportable: false }), iso(4, { status: 'pending_id', organism_code: null })];
  it('only reportable AST rows of snapshot isolates with report_visibility = shown and a category; rows stay in the input (AC-16.1: suppressed_by_rule is excluded, never deleted)', () => {
    const rows = [astRow(1, 'syn_amp'), astRow(1, 'syn_cip', { report_visibility: 'suppressed_by_rule' }), astRow(1, 'syn_gen', { is_reportable: false }), astRow(1, 'syn_ast_nocat', { category_code: null }),
      astRow(2, 'syn_amp'), astRow(3, 'syn_amp'), astRow(4, 'syn_amp')];
    const before = JSON.stringify(rows);
    const s = snap({ isolates, ast: rows, antibiotics: { ...BASE().antibiotics, syn_ast_nocat: 'Synthetic no category' } });
    expect(s['ast'].map((a: Row) => `${a['isolate_seq']}:${a['antibiotic_code']}`)).toEqual(['1:syn_amp', '2:syn_amp']);
    expect(JSON.stringify(rows)).toBe(before);                                  // inputs untouched
  });
  it('keys per 05-SCHEMA §6 only (no id, no is_reportable, no panel_sort_order); antibiotic_display snapshotted from the coded set; raw_value carries the qualifier as entered', () => {
    const s = snap({ isolates, ast: [astRow(1, 'syn_amp', { raw_value: '<=0.25', method: 'mic' })] });
    expect(Object.keys(s['ast'][0]).sort()).toEqual(['antibiotic_code', 'antibiotic_display', 'category_code', 'isolate_seq', 'method', 'raw_value', 'standard', 'standard_version']);
    expect(s['ast'][0]).toMatchObject({ isolate_seq: 1, antibiotic_code: 'syn_amp', antibiotic_display: 'Synthetic ampicillin', method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026' });
  });
  it('ordered by isolate_seq, then panel sort order, then antibiotic_display', () => {
    const rows = [astRow(2, 'syn_amp', { panel_sort_order: 1 }), astRow(1, 'syn_gen', { panel_sort_order: 2 }), astRow(1, 'syn_cip', { panel_sort_order: 1 }), astRow(1, 'syn_amp', { panel_sort_order: 2 })];
    const s = snap({ isolates, ast: rows });
    expect(s['ast'].map((a: Row) => `${a['isolate_seq']}:${a['antibiotic_code']}`)).toEqual(['1:syn_cip', '1:syn_amp', '1:syn_gen', '2:syn_amp']);   // seq 1: sort 1 cip; sort 2 amp < gen by display
  });
});

describe('C10-T15 snapshot: size guard (AC-09.7, review m#28) - before ajv', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => iso(i + 1));
  it('limits are 20 isolates and 600 AST rows', () => { expect([SNAPSHOT_MAX_ISOLATES, SNAPSHOT_MAX_AST]).toEqual([20, 600]); });
  it('20 isolates and 600 AST rows pass', () => {
    const rows = Array.from({ length: 600 }, (_, i) => astRow(1 + (i % 20), `syn_abx_${i}`));
    const antibiotics = Object.fromEntries(rows.map((r) => [r['antibiotic_code'], `Synthetic ${r['antibiotic_code']}`]));
    const s = snap({ isolates: many(20), ast: rows, antibiotics });
    expect([s['isolates'].length, s['ast'].length]).toEqual([20, 600]);
  });
  it('21 identified reportable isolates -> micro.report_incomplete with errors[] path /isolates, code too_many_items', () => {
    let e: any; try { snap({ isolates: many(21) }); } catch (x) { e = x; }
    expect(isLimsError(e, 'micro.report_incomplete'), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(422);
    expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/isolates', code: 'too_many_items' })]));
  });
  it('601 reportable AST rows -> micro.report_incomplete with errors[] path /ast, code too_many_items; both over the limit report both paths', () => {
    const rows = Array.from({ length: 601 }, (_, i) => astRow(1 + (i % 20), `syn_abx_${i}`));
    const antibiotics = Object.fromEntries(rows.map((r) => [r['antibiotic_code'], `Synthetic ${r['antibiotic_code']}`]));
    let e: any; try { snap({ isolates: many(20), ast: rows, antibiotics }); } catch (x) { e = x; }
    expect(isLimsError(e, 'micro.report_incomplete')).toBe(true);
    expect(e.errors).toEqual([expect.objectContaining({ path: '/ast', code: 'too_many_items' })]);
    let e2: any; try { snap({ isolates: many(21), ast: rows, antibiotics }); } catch (x) { e2 = x; }
    expect(e2.errors.map((x: Row) => x.path).sort()).toEqual(['/ast', '/isolates']);
  });
  it('rows that are NOT in the snapshot do not count: 30 withdrawn isolates + 700 suppressed AST rows are fine', () => {
    const s = snap({ isolates: [iso(1), ...Array.from({ length: 30 }, (_, i) => iso(i + 2, { status: 'withdrawn', withdraw_reason_code: 'duplicate' }))],
      ast: Array.from({ length: 700 }, (_, i) => astRow(1, `syn_abx_${i}`, { report_visibility: 'suppressed_by_rule' })) });
    expect([s['isolates'].length, s['ast'].length]).toEqual([1, 0]);
  });
});

describe('C10-T15 snapshot: submission_kind and flag (02-TRD §4.6)', () => {
  const a = [astRow(1, 'syn_amp')];
  it('submission_kind: ast_panel when ast[] is non-empty, else organism when isolates[] is non-empty, else structured', () => {
    expect(snap({ isolates: [iso(1)], ast: a })['submission_kind']).toBe('ast_panel');
    expect(snap({ isolates: [iso(1)] })['submission_kind']).toBe('organism');
    expect(snap({ outcome: { code: 'no_growth', display: 'No growth', result_flag: 'N' } })['submission_kind']).toBe('structured');
  });
  it('final: flag = outcome.result_flag (N and A)', () => {
    expect(snap({ outcome: { code: 'no_growth', display: 'No growth', result_flag: 'N' } })['flag']).toBe('N');
    expect(snap({ isolates: [iso(1)], outcome: { code: 'growth_reported', display: 'Growth', result_flag: 'A' } })['flag']).toBe('A');
    expect(snap({ outcome: { code: 'mixed_growth_contamination', display: 'Mixed growth', result_flag: 'A' } })['flag']).toBe('A');   // result_flag wins over the isolates
  });
  it('preliminary: flag A when isolates[] is non-empty or any plate_read indicates growth, else N', () => {
    const p = { phase: 'preliminary', outcome: undefined };
    expect(snap({ ...p, isolates: [iso(1)] })['flag']).toBe('A');
    expect(snap({ ...p, observations: [obs(1, 'plate_read', { growth_code: 'syn_growth' })] })['flag']).toBe('A');
    expect(snap({ ...p, observations: [obs(1, 'plate_read', { growth_code: 'no_growth' }), obs(2, 'gram_stain')] })['flag']).toBe('N');
    expect(snap({ ...p, observations: [obs(1, 'gram_stain')] })['flag']).toBe('N');
  });
  it('is_critical is the request value, never derived', () => {
    expect(snap({ isCritical: true })['is_critical']).toBe(true);
    expect(snap({ isolates: [iso(1, { organism_code: 'syn_staph' })], isCritical: false })['is_critical']).toBe(false);
  });
});

describe('C10-T15 snapshot: culture_summary_text (02-TRD §4.6, [CONV] generated text)', () => {
  it('client text wins (verbatim, up to 4000)', () => { expect(snap({ summaryText: 'Synthetic client summary' })['culture_summary_text']).toBe('Synthetic client summary'); });
  it('generated final: "Final: <outcome display>", Gram stain line (latest gram_stain finding_text), one "Isolate <seq>: <organism display>[ — <growth_text>]" per snapshot isolate; lines joined with \\n', () => {
    const observations = [obs(1, 'gram_stain', { finding_text: 'Old stain' }), obs(2, 'gram_stain', { finding_text: 'Synthetic gram-negative rods' })];
    const t = snap({ isolates: [iso(1, { quantity_text: 'Synthetic heavy' }), iso(2, { organism_code: 'syn_staph' })], observations })['culture_summary_text'];
    expect(t).toBe('Final: Growth - see isolates\nGram stain: Synthetic gram-negative rods\nIsolate 1: Synthetic E. coli — Synthetic heavy\nIsolate 2: Synthetic S. aureus');
  });
  it('generated preliminary: "Preliminary report"; no isolate and latest read no_growth -> "No growth after <floor(hours_since_planting)> h"', () => {
    const t = snap({ phase: 'preliminary', outcome: undefined, observations: [obs(1, 'plate_read', { growth_code: 'no_growth', hours_since_planting: 11.9 })] })['culture_summary_text'];
    expect(t).toBe('Preliminary report\nNo growth after 11 h');
    expect(snap({ phase: 'preliminary', outcome: undefined, observations: [obs(1, 'plate_read', { growth_code: 'syn_growth' })] })['culture_summary_text']).toBe('Preliminary report');
  });
  it('generated text over 4000 characters is truncated to 4000 ending with "…"', () => {
    const rows = Array.from({ length: 20 }, (_, i) => iso(i + 1, { quantity_text: 'x'.repeat(200) }));
    const t: string = snap({ isolates: rows, observations: [obs(1, 'gram_stain', { finding_text: 'g'.repeat(2000) })] })['culture_summary_text'];
    expect(t.length).toBe(4000); expect(t.endsWith('…')).toBe(true);
  });
});

describe('C10-T15 validateSnapshot: ajv over the 05-SCHEMA §6 schemas (AC-15.2)', () => {
  const good = () => ({ isolates: [{ seq: 1, organism_code: 'syn_ecoli', organism_display: 'Synthetic E. coli', growth_text: '' }],
    ast: [{ isolate_seq: 1, antibiotic_code: 'syn_amp', antibiotic_display: 'Synthetic ampicillin', method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026' }] });
  const fails = (x: unknown) => { let e: any; try { validateSnapshot(x as any); } catch (err) { e = err; } return e; };
  it('a snapshot built by buildSnapshot validates', () => {
    const s = snap({ isolates: [iso(1)], ast: [astRow(1, 'syn_amp')] });
    expect(() => validateSnapshot(s as any)).not.toThrow();
    expect(() => validateSnapshot(good())).not.toThrow();
    expect(() => validateSnapshot({ isolates: [], ast: [] })).not.toThrow();       // [] allowed
  });
  it.each<[string, (g: Row) => void]>([
    ['missing key (isolate growth_text)', (g) => { delete g['isolates'][0].growth_text; }],
    ['extra key on an isolate', (g) => { g['isolates'][0].id = u(1); }],
    ['extra key on an AST row', (g) => { g['ast'][0].is_reportable = true; }],
    ['missing AST key (standard_version)', (g) => { delete g['ast'][0].standard_version; }],
    ['seq 0', (g) => { g['isolates'][0].seq = 0; }],
    ['seq 100', (g) => { g['isolates'][0].seq = 100; }],
    ['empty organism_display', (g) => { g['isolates'][0].organism_display = ''; }],
    ['organism_display > 200', (g) => { g['isolates'][0].organism_display = 'x'.repeat(201); }],
    ['growth_text > 200', (g) => { g['isolates'][0].growth_text = 'x'.repeat(201); }],
    ['method not in mic / zone_diameter / other', (g) => { g['ast'][0].method = 'disk'; }],
    ['standard not in CLSI / EUCAST / ECOFF (unknown)', (g) => { g['ast'][0].standard = 'unknown'; }],
    ['raw_value > 32', (g) => { g['ast'][0].raw_value = '1'.repeat(33); }],
    ['empty raw_value', (g) => { g['ast'][0].raw_value = ''; }],
    ['category_code > 8', (g) => { g['ast'][0].category_code = 'x'.repeat(9); }],
    ['standard_version > 32', (g) => { g['ast'][0].standard_version = 'v'.repeat(33); }],
  ])('invalid: %s -> LimsError common.internal (a programming error, 02-TRD §4.6)', (_n, mutate) => {
    const g = good(); mutate(g as Row);
    const e = fails(g);
    expect(isLimsError(e, 'common.internal'), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(500);
  });
  it('21 isolates / 601 AST rows fail the schema maxItems (the size guard normally answers first)', () => {
    const g = good();
    expect(isLimsError(fails({ ...g, isolates: Array.from({ length: 21 }, (_, i) => ({ ...g.isolates[0], seq: i + 1 })) }), 'common.internal')).toBe(true);
    expect(isLimsError(fails({ ...g, ast: Array.from({ length: 601 }, () => ({ ...g.ast[0] })) }), 'common.internal')).toBe(true);
  });
  it('the failure never carries row content (REQ-SEC: logged without content)', () => {
    const g = good(); g.isolates[0]!.organism_display = 'SECRET-SYNTHETIC-CONTENT'; (g.isolates[0] as Row)['extra'] = 'SECRET-SYNTHETIC-CONTENT';
    const e = fails(g);
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('SECRET-SYNTHETIC-CONTENT');
  });
});
