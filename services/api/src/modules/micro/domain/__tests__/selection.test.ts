// C10 T-04 — pure domain: plating protocol + AST panel precedence (02-TRD §4.2), AC-03.2. Synthetic data only.
// Seams expected from the writer (spec does not fix signatures):
//   ../selection.ts
//     export function selectPlatingProtocol(
//       keys: readonly { protocol_code: string; test_id: string | null; specimen_type_code: string | null; is_active: boolean }[],
//       req: { test_id: string; specimen_type_code: string },
//     ): string | null;                      // protocol_code of the winning key; null = no match (caller supplies plates, schedule from settings)
//     export function selectAstPanel(
//       panels: readonly { id: string; code: string; organism_code: string | null; organism_group_code: string | null;
//                          specimen_site_code: string | null; is_active: boolean; superseded_at: Date | null }[],
//       req: { organism_code: string; organism_group_code: string | null; specimen_site_code: string | null },
//     ): { id: string; code: string } | null;   // the winning panel; null = none (service answers 400 /ast_panel_id)
import { describe, expect, it } from 'vitest';
import { selectAstPanel, selectPlatingProtocol } from '../selection.js';

const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';
const key = (protocol_code: string, test_id: string | null, specimen_type_code: string | null, is_active = true) => ({ protocol_code, test_id, specimen_type_code, is_active });
const req = { test_id: T1, specimen_type_code: 'synthetic_spec_a' };

describe('plating protocol precedence (AC-03.2)', () => {
  const all = [key('p_default', null, null), key('p_type', null, 'synthetic_spec_a'), key('p_test', T1, null), key('p_both', T1, 'synthetic_spec_a')];
  it('level 1: (test + specimen type) wins', () => expect(selectPlatingProtocol(all, req)).toBe('p_both'));
  it('level 2: (test) beats (specimen type) and default', () => expect(selectPlatingProtocol(all.filter((k) => k.protocol_code !== 'p_both'), req)).toBe('p_test'));
  it('level 3: (specimen type) beats tenant default', () => expect(selectPlatingProtocol([all[0]!, all[1]!], req)).toBe('p_type'));
  it('level 4: tenant default (any, any)', () => expect(selectPlatingProtocol([all[0]!], req)).toBe('p_default'));
  it('order of the input does not matter', () => expect(selectPlatingProtocol([...all].reverse(), req)).toBe('p_both'));
  it('no match -> null (explicit plates; settings default hours)', () => {
    expect(selectPlatingProtocol([], req)).toBeNull();
    expect(selectPlatingProtocol([key('p_x', T2, null), key('p_y', null, 'synthetic_spec_z'), key('p_z', T2, 'synthetic_spec_a')], req)).toBeNull();
  });
  it('inactive keys are ignored', () => {
    expect(selectPlatingProtocol([key('p_both', T1, 'synthetic_spec_a', false), key('p_default', null, null)], req)).toBe('p_default');
  });
  it('a key for the right test but a different specimen type does not match', () => {
    expect(selectPlatingProtocol([key('p_x', T1, 'synthetic_spec_z')], req)).toBeNull();
  });
  it('does not mutate its input', () => {
    const keys = [...all]; const snap = JSON.stringify(keys);
    selectPlatingProtocol(keys, req);
    expect(JSON.stringify(keys)).toBe(snap);
  });
});

describe('AST panel precedence: (o,s) > (o,any) > (g,s) > (g,any) > (any,s) > (any,any)', () => {
  let n = 0;
  const panel = (code: string, organism_code: string | null, organism_group_code: string | null, specimen_site_code: string | null, over: Record<string, unknown> = {}) =>
    ({ id: `id_${String(++n).padStart(3, '0')}`, code, organism_code, organism_group_code, specimen_site_code, is_active: true, superseded_at: null, ...over });
  const O = 'synthetic_org_a'; const G = 'synthetic_grp_x'; const S = 'synthetic_site_1';
  const r = { organism_code: O, organism_group_code: G, specimen_site_code: S };
  const levels = () => [
    panel('l6_any_any', null, null, null), panel('l5_any_s', null, null, S), panel('l4_g_any', null, G, null),
    panel('l3_g_s', null, G, S), panel('l2_o_any', O, null, null), panel('l1_o_s', O, null, S),
  ];
  it.each(['l1_o_s', 'l2_o_any', 'l3_g_s', 'l4_g_any', 'l5_any_s', 'l6_any_any'])('winner %s when it and all lower levels are present', (code) => {
    const ps = levels(); const from = ps.findIndex((p) => p.code === code);
    // keep `code` and every lower-priority panel (levels() is ordered lowest priority first)
    expect(selectAstPanel(ps.slice(0, from + 1), r)?.code).toBe(code);
  });
  it('organism-any beats group-site (organism outranks site)', () => {
    expect(selectAstPanel([panel('g_s', null, G, S), panel('o_any', O, null, null)], r)?.code).toBe('o_any');
  });
  it('panel for another organism / group / site never matches', () => {
    const ps = [panel('o_z', 'synthetic_org_z', null, null), panel('g_z', null, 'synthetic_grp_z', null), panel('any_z', null, null, 'synthetic_site_z')];
    expect(selectAstPanel(ps, r)).toBeNull();
  });
  it('culture without a site only matches site-less panels', () => {
    expect(selectAstPanel([panel('o_s', O, null, S)], { ...r, specimen_site_code: null })).toBeNull();
    expect(selectAstPanel([panel('o_s', O, null, S), panel('g_any', null, G, null)], { ...r, specimen_site_code: null })?.code).toBe('g_any');
  });
  it('organism without a group never matches a group panel', () => {
    expect(selectAstPanel([panel('g_any', null, G, null)], { ...r, organism_group_code: null })).toBeNull();
  });
  it('inactive and superseded panels are ignored', () => {
    const ps = [panel('o_s_inactive', O, null, S, { is_active: false }), panel('o_any_sup', O, null, null, { superseded_at: new Date('2030-01-01T00:00:00Z') }), panel('any_any', null, null, null)];
    expect(selectAstPanel(ps, r)?.code).toBe('any_any');
  });
  it('tie at the winning level: lowest code, then lowest id', () => {
    const a = panel('b_panel', O, null, S); const b = panel('a_panel', O, null, S);
    expect(selectAstPanel([a, b], r)?.code).toBe('a_panel');
    const c = { ...panel('same', O, null, S), id: 'id_900' }; const d = { ...panel('same', O, null, S), id: 'id_100' };
    expect(selectAstPanel([c, d], r)?.id).toBe('id_100');
    expect(selectAstPanel([d, c], r)?.id).toBe('id_100');
  });
  it('tie-break only applies within the winning level', () => {
    const ps = [panel('a_low', null, null, null), panel('z_o_s', O, null, S)];
    expect(selectAstPanel(ps, r)?.code).toBe('z_o_s');
  });
  it('no panels -> null', () => expect(selectAstPanel([], r)).toBeNull());
});
