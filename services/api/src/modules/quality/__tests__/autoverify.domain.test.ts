// C9 T-15 — pure domain: DSL validation (02-TRD §8.2; AC-10.1, AC-10.2: errors as JSON Pointers) and the version state machine (03-APP-FLOW §2.3; AC-10.3, AC-11.4; 08 A17 D-55).
// Seams: autoverify.helpers.ts header. Pointers here are relative to the definition root.
import { describe, expect, it } from 'vitest';
import { validateRuleSetDefinition } from '../domain/autoverify-dsl.js';
import { isTerminal, nextStatus, type VersionAction, type VersionStatus } from '../domain/ruleset.state.js';
import { ANALYTE, INSTR, TEST, catalogMap, def, rule, type Row } from './autoverify.helpers.js';

const errs = (d: unknown, withCatalog = false) => validateRuleSetDefinition(d, withCatalog ? catalogMap() : undefined);
const paths = (d: unknown, withCatalog = false) => errs(d, withCatalog).map((e) => e.path);
const POINTER = /^(\/([^~/]|~[01])*)*$/;

describe('AC-10.1 valid definitions', () => {
  it('the TRD §8.2 example passes (structure + catalog)', () => { expect(errs(def(rule(1)), true)).toEqual([]); });
  it('zero rules is valid (0..2000)', () => { expect(errs(def())).toEqual([]); });
  it('2000 rules valid; 2001 -> error at /rules', () => {
    const many = (n: number) => def(...Array.from({ length: n }, (_, i) => rule(1, { key: `R${i}`, analyte_id: ANALYTE(1), instrument_id: `0190a000-0000-7000-8000-${(0x9000 + i).toString(16).padStart(12, '0')}` })));
    expect(errs(many(2000))).toEqual([]);
    expect(paths(many(2001))).toContain('/rules');
  });
  it('same analyte on different instruments, or one instrument-specific + one any-instrument, is allowed (key is (analyte, instrument ?? "*"))', () => {
    expect(errs(def(rule(1, { key: 'A', instrument_id: INSTR(1) }), rule(1, { key: 'B', instrument_id: INSTR(2) }), rule(1, { key: 'C' })))).toEqual([]);
  });
  it('a disabled opt-out rule needs only key/test_id/analyte_id/enabled', () => {
    expect(errs(def({ key: 'OFF', test_id: TEST(1), analyte_id: ANALYTE(1), enabled: false }))).toEqual([]);
  });
  it('limits: one bound is enough; low == high is allowed; "3.50" vs "3.5" compare as numbers', () => {
    expect(errs(def(rule(1, { limits: { low: '3.5' } })))).toEqual([]);
    expect(errs(def(rule(1, { limits: { high: '5.1' } })))).toEqual([]);
    expect(errs(def(rule(1, { limits: { low: '3.5', high: '3.50' } })))).toEqual([]);
  });
  it('flags N, L, H in any non-empty unique subset', () => { expect(errs(def(rule(1, { allowed_range_flags: ['N', 'L', 'H'] })))).toEqual([]); });
});

describe('AC-10.2 invalid definitions -> JSON Pointer errors (all of them, not just the first)', () => {
  it('duplicate rule key -> pointer at the later rule key', () => {
    const e = errs(def(rule(1, { key: 'DUP' }), rule(2, { key: 'DUP' })));
    expect(e.map((x) => x.path)).toEqual(['/rules/1/key']);
  });
  it('duplicate (analyte, instrument) pair -> pointer at the later rule analyte_id; same analyte on the any-instrument key twice collides', () => {
    expect(paths(def(rule(1, { key: 'A' }), rule(1, { key: 'B' })))).toEqual(['/rules/1/analyte_id']);
    expect(paths(def(rule(1, { key: 'A', instrument_id: INSTR(1) }), rule(1, { key: 'B', instrument_id: INSTR(1) })))).toEqual(['/rules/1/analyte_id']);
  });
  it('low > high -> /rules/<i>/limits; compared numerically, not as strings ("10" > "9.5")', () => {
    expect(paths(def(rule(1, { limits: { low: '5.2', high: '5.1' } })))).toEqual(['/rules/0/limits']);
    expect(paths(def(rule(1, { limits: { low: '10', high: '9.5' } })))).toEqual(['/rules/0/limits']);
    expect(paths(def(rule(1, { limits: { low: '-1', high: '-2' } })))).toEqual(['/rules/0/limits']);
    expect(errs(def(rule(1, { limits: { low: '-2', high: '-1' } })))).toEqual([]);
  });
  it('empty limits object, non-decimal bound -> pointer', () => {
    expect(paths(def(rule(1, { limits: {} })))).toEqual(['/rules/0/limits']);
    expect(paths(def(rule(1, { limits: { low: '3,5' } })))).toEqual(['/rules/0/limits/low']);
    expect(paths(def(rule(1, { limits: { high: 5.1 } })))).toEqual(['/rules/0/limits/high']);
  });
  it('a range flag other than N/L/H (LL, HH, A, lower-case, empty list, duplicate) -> pointer at the flag / list', () => {
    expect(paths(def(rule(1, { allowed_range_flags: ['N', 'LL'] })))).toEqual(['/rules/0/allowed_range_flags/1']);
    expect(paths(def(rule(1, { allowed_range_flags: ['A'] })))).toEqual(['/rules/0/allowed_range_flags/0']);
    expect(paths(def(rule(1, { allowed_range_flags: ['n'] })))).toEqual(['/rules/0/allowed_range_flags/0']);
    expect(paths(def(rule(1, { allowed_range_flags: [] })))).toEqual(['/rules/0/allowed_range_flags']);
    expect(paths(def(rule(1, { allowed_range_flags: ['N', 'N'] })))).toEqual(['/rules/0/allowed_range_flags']);
  });
  it('unknown field anywhere (additionalProperties false) -> common.unknown_field at that pointer', () => {
    expect(errs({ ...def(rule(1)), extra: 1 })).toEqual([{ path: '/extra', code: 'common.unknown_field' }]);
    expect(errs(def(rule(1, { tenant_id: 'x' })))).toEqual([{ path: '/rules/0/tenant_id', code: 'common.unknown_field' }]);
    expect(errs(def(rule(1, { limits: { low: '1', mid: '2' } })))).toEqual([{ path: '/rules/0/limits/mid', code: 'common.unknown_field' }]);
  });
  it('missing required -> common.field_required (schema_version, rules, key, test_id, analyte_id, enabled)', () => {
    expect(errs({ rules: [] })).toEqual([{ path: '/schema_version', code: 'common.field_required' }]);
    expect(errs({ schema_version: 1 })).toEqual([{ path: '/rules', code: 'common.field_required' }]);
    const r = rule(1) as Row; delete r['enabled'];
    expect(errs(def(r))).toEqual([{ path: '/rules/0/enabled', code: 'common.field_required' }]);
  });
  it('schema_version other than 1; key pattern/length; notes/flag-list bounds -> field_invalid at the pointer', () => {
    expect(errs({ schema_version: 2, rules: [] })).toEqual([{ path: '/schema_version', code: 'common.field_invalid' }]);
    expect(paths(def(rule(1, { key: 'has space' })))).toEqual(['/rules/0/key']);
    expect(paths(def(rule(1, { key: 'K'.repeat(41) })))).toEqual(['/rules/0/key']);
    expect(paths(def(rule(1, { note: 'n'.repeat(201) })))).toEqual(['/rules/0/note']);
    expect(paths(def(rule(1, { instrument_flags_allowed: Array.from({ length: 21 }, (_, i) => `F${i}`) })))).toEqual(['/rules/0/instrument_flags_allowed']);
    expect(paths(def(rule(1, { instrument_flags_allowed: ['X'.repeat(17)] })))).toEqual(['/rules/0/instrument_flags_allowed/0']);
    expect(paths(def(rule(1, { test_id: 'not-a-uuid' })))).toEqual(['/rules/0/test_id']);
    expect(paths(def(rule(1, { enabled: 'yes' })))).toEqual(['/rules/0/enabled']);
  });
  it('non-object roots -> a root-level error, never a throw', () => {
    for (const bad of [null, undefined, 7, 'x', [], true]) { const e = errs(bad); expect(e).toHaveLength(1); expect(e[0]!.path).toBe(''); }
    expect(paths({ schema_version: 1, rules: {} })).toEqual(['/rules']);
    expect(paths({ schema_version: 1, rules: [null] })).toEqual(['/rules/0']);
  });
  it('several faults are all reported, each with a valid RFC 6901 pointer and a field code', () => {
    const e = errs(def(rule(1, { key: 'D' }), rule(2, { key: 'D', limits: { low: '9', high: '1' }, allowed_range_flags: ['LL'] })));
    expect(e.map((x) => x.path).sort()).toEqual(['/rules/1/allowed_range_flags/0', '/rules/1/key', '/rules/1/limits']);
    for (const x of e) { expect(x.path).toMatch(POINTER); expect(x.code).toMatch(/^common\.(field_invalid|field_required|unknown_field)$/); }
  });
  it('prototype-pollution / hostile shapes do not throw and are rejected', () => {
    const hostile = JSON.parse('{"schema_version":1,"rules":[],"__proto__":{"x":1},"constructor":{"y":1}}');
    expect(() => errs(hostile)).not.toThrow();
    expect(errs(hostile).length).toBeGreaterThan(0);
    expect(({} as Row)['x']).toBeUndefined();
  });
});

describe('analyte must belong to test_id and be numeric (CatalogPort.getTest) — only with a catalog', () => {
  it('analyte of another test -> /rules/<i>/analyte_id', () => { expect(paths(def(rule(1, { analyte_id: ANALYTE(4) })), true)).toEqual(['/rules/0/analyte_id']); });
  it('non-numeric analyte (ordinal) -> /rules/<i>/analyte_id', () => { expect(paths(def(rule(3)), true)).toEqual(['/rules/0/analyte_id']); });
  it('unknown test (catalog has no entry) -> /rules/<i>/test_id, and no second error for that rule', () => { expect(paths(def(rule(1, { test_id: TEST(9) })), true)).toEqual(['/rules/0/test_id']); });
  it('test id the catalog map does not mention at all is also unknown', () => { expect(paths(def(rule(1, { test_id: TEST(7) })), true)).toEqual(['/rules/0/test_id']); });
  it('without a catalog the same definition passes (structure only)', () => { expect(errs(def(rule(3)))).toEqual([]); });
});

// ------------------------------------------------------------------------------------------------ state machine
const STATUSES: VersionStatus[] = ['draft', 'simulating', 'stopped', 'active', 'retired', 'discarded'];
const ACTIONS: VersionAction[] = ['edit', 'startSimulation', 'stopSimulation', 'activate', 'retire', 'discard'];
const LEGAL: Array<[VersionStatus, VersionAction, VersionStatus]> = [
  ['draft', 'edit', 'draft'], ['draft', 'startSimulation', 'simulating'], ['simulating', 'stopSimulation', 'stopped'],
  ['simulating', 'activate', 'active'], ['active', 'retire', 'retired'], ['draft', 'discard', 'discarded'],
];

describe('ruleset.state — 03-APP-FLOW §2.3 (AV1-AV7)', () => {
  it.each(LEGAL)('%s --%s--> %s', (from, action, to) => { expect(nextStatus(from, action)).toBe(to); });
  const illegal = STATUSES.flatMap((s) => ACTIONS.map((a) => [s, a] as const)).filter(([s, a]) => !LEGAL.some(([f, x]) => f === s && x === a));
  it('the table is exactly 6 legal moves of 36 (30 refused)', () => { expect(illegal).toHaveLength(30); });
  it.each(illegal)('%s --%s--> refused with quality.rule_set_invalid_transition', (from, action) => {
    expect(() => nextStatus(from, action)).toThrowError(expect.objectContaining({ code: 'quality.rule_set_invalid_transition' }));
  });
  it('AC-11.4 stopped is terminal: nothing leaves it (D-55); retired and discarded too; draft/simulating/active are not terminal', () => {
    for (const s of ['stopped', 'retired', 'discarded'] as const) { expect(isTerminal(s)).toBe(true); for (const a of ACTIONS) expect(() => nextStatus(s, a)).toThrow(); }
    for (const s of ['draft', 'simulating', 'active'] as const) expect(isTerminal(s)).toBe(false);
  });
  it('draft -> active directly is forbidden; stopped -> draft/simulating/active are forbidden', () => {
    expect(() => nextStatus('draft', 'activate')).toThrow();
    for (const a of ['edit', 'startSimulation', 'activate'] as const) expect(() => nextStatus('stopped', a)).toThrow();
  });
  it('an unknown status or action is refused, not passed through', () => {
    expect(() => nextStatus('bogus' as never, 'edit')).toThrow();
    expect(() => nextStatus('draft', 'bogus' as never)).toThrow();
  });
});
