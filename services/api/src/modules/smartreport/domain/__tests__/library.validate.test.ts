// C14 T10 — validateLibrary V1-V14 (02-TRD §9.4, §9.3, §4.9, §9.5). Unit; every rule has a passing and a failing fixture.
// ACs: AC-02.5 (starter: only V14), AC-03.3 (digits), AC-03.4 ({dose}), AC-05.2 (inactive follow-up test), AC-06.1-06.4, AC-18.4 (links/contact). Security: AB-4 (V5), AB-11 (deny), ReDoS.
// Seams (spec silent): see ../../__tests__/t10.fixtures.ts header. Fails now: ../library.validate.js does not exist.
import { describe, expect, it } from 'vitest';
import { GLOBAL_DENY, sid, starterLibrary, type LibBlock, type LibInput, type LibRule } from '../../__tests__/t10.fixtures.js';
import { validateLibrary } from '../library.validate.js';

const env = (o: { terms?: string[]; inactiveTests?: string[]; inactiveAnalytes?: string[] } = {}) => ({
  denyTerms: (o.terms ?? GLOBAL_DENY).map((term) => ({ term })),
  inactiveTestIds: new Set(o.inactiveTests ?? []),
  inactiveAnalyteIds: new Set(o.inactiveAnalytes ?? []),
});
const MAP = { id: sid(900), analyteId: sid(901), groupCode: 'blood_counts' };
/** Starter + one mapping = a library with no issue at all. */
const good = (): LibInput => ({ ...starterLibrary(), mappings: [{ ...MAP }] });
const run = (l: LibInput, e = env()) => validateLibrary(l, e);
const codes = (r: { errors: { code: string }[] }) => r.errors.map((i) => i.code);
const issue = (r: any, code: string) => [...r.errors, ...r.warnings].filter((i: any) => i.code === code);
const block = (l: LibInput, key: string): LibBlock => l.blocks.find((b) => b.blockKey === key)!;
const withText = (key: string, textEn: string | null, textNe?: string | null): LibInput => {
  const l = good();
  Object.assign(block(l, key), { textEn, ...(textNe !== undefined ? { textNe } : {}) });
  return l;
};
const extraBlock = (l: LibInput, b: Partial<LibBlock> & { id: string }, rule?: Partial<LibRule>): LibInput => {
  const nb: LibBlock = { blockKey: `x.${b.id.slice(-4)}`, kind: 'advice', textEn: 'A neutral sentence.', ...b };
  l.blocks.push(nb);
  if (rule) l.rules.push({ id: sid(5000 + l.rules.length), ruleKind: nb.kind, triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 100, blockId: nb.id, blockKind: nb.kind, ...rule });
  return l;
};
const NE = {
  deranged: '{analyte_name} यस प्रयोगशालाको सन्दर्भ दायरा भन्दा बाहिर छ।', disclaimer: 'यो सारांशले पूर्ण प्रयोगशाला प्रतिवेदन प्रतिस्थापन गर्दैन।',
  score: 'यो अंकले मापन गरिएका नतिजा सन्दर्भ दायरा भित्र कति छन् भनेर देखाउँछ।', advice: 'सबै नतिजा सन्दर्भ दायरा भित्र छन्।',
};
const neLibrary = (): LibInput => {
  const l = good();
  l.language = 'ne';
  for (const b of l.blocks) b.textNe = b.kind === 'deranged' ? NE.deranged : b.kind === 'disclaimer' ? NE.disclaimer : b.kind === 'score_explanation' ? NE.score : NE.advice;
  return l;
};

describe('baseline + report shape', () => {
  it('starter + one mapping: valid, no errors, no warnings; report is { valid, errors, warnings }', () => {
    const r = run(good());
    expect(r).toEqual({ valid: true, errors: [], warnings: [] });
  });
  it('every issue has code, severity matching its list, and a string path', () => {
    const l = good(); l.mappings = []; l.blocks.push({ id: sid(77), blockKey: 'orphan.block', kind: 'advice', textEn: 'Unused text.' });
    const r = run(l);
    for (const i of r.errors) { expect(i.severity).toBe('error'); expect(typeof i.path).toBe('string'); }
    for (const i of r.warnings) { expect(i.severity).toBe('warning'); expect(typeof i.path).toBe('string'); }
    expect(r.errors.length).toBeGreaterThan(0); expect(r.warnings.length).toBeGreaterThan(0);
  });
  it('collects every problem (no stop at first) and valid = no error issue', () => {
    const l = good(); l.mappings = [];
    l.blocks = l.blocks.filter((b) => b.kind !== 'disclaimer'); Object.assign(block(l, 'advice.all_in_range'), { textEn: 'Repeat in 3 months.' });
    const r = run(l);
    expect(codes(r)).toEqual(expect.arrayContaining(['disclaimer_missing', 'digits_not_allowed', 'no_mappings']));
    expect(r.valid).toBe(false);
  });
  it('is pure: does not mutate frozen input and gives the same report twice', () => {
    const l = good();
    const freeze = (o: any): any => { Object.values(o).forEach((v) => typeof v === 'object' && v && freeze(v)); return Object.freeze(o); };
    freeze(l);
    expect(run(l)).toEqual(run(l));
  });
  it('size/perf: a 500-block / 1000-rule / 2000-mapping library validates quickly', () => {
    const l = good(); l.mappings = [];
    for (let i = 0; i < 494; i++) l.blocks.push({ id: sid(10000 + i), blockKey: `adv.k${i}`, kind: 'advice', textEn: 'Neutral text.' });
    for (let i = 0; i < 996; i++) l.rules.push({ id: sid(20000 + i), ruleKind: 'advice', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 100, blockId: sid(10000 + (i % 494)), blockKind: 'advice' });
    for (let i = 0; i < 2000; i++) l.mappings.push({ id: sid(30000 + i), analyteId: sid(40000 + i), groupCode: 'other' });
    const t = Date.now(); const r = run(l);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(issue(r, 'library_too_large')).toEqual([]);
  });
});

describe('V1 disclaimer (AC-06.1)', () => {
  it('pass: exactly one non-empty disclaimer', () => expect(issue(run(good()), 'disclaimer_missing')).toEqual([]));
  it('fail: none -> disclaimer_missing, valid=false', () => {
    const l = good(); l.blocks = l.blocks.filter((b) => b.kind !== 'disclaimer');
    const r = run(l);
    expect(r.valid).toBe(false); expect(codes(r)).toContain('disclaimer_missing');
  });
  it('fail: two -> disclaimer_duplicate', () => {
    const l = extraBlock(good(), { id: sid(80), kind: 'disclaimer', blockKey: 'disclaimer.second', textEn: 'Another disclaimer.' });
    expect(codes(run(l))).toContain('disclaimer_duplicate');
  });
  it.each([['empty', ''], ['whitespace', '   \n '], ['null', null]])('fail: %s text in the library language -> disclaimer_missing', (_n, t) => {
    expect(codes(run(withText('disclaimer.main', t as any)))).toContain('disclaimer_missing');
  });
  it('fail: ne library whose disclaimer has only text_en -> disclaimer_missing', () => {
    const l = neLibrary(); Object.assign(block(l, 'disclaimer.main'), { textNe: null, textEn: 'English only disclaimer.' });
    expect(codes(run(l))).toContain('disclaimer_missing');
  });
  it('pass: ne library with a Devanagari disclaimer', () => expect(run(neLibrary())).toEqual({ valid: true, errors: [], warnings: [] }));
});

describe('V2 score explanation (AC-06.2)', () => {
  it('fail: score_enabled and no score_explanation block', () => {
    const l = good(); l.blocks = l.blocks.filter((b) => b.kind !== 'score_explanation');
    const r = run(l);
    expect(r.valid).toBe(false); expect(codes(r)).toContain('score_explanation_missing');
  });
  it('pass: score disabled and no score_explanation block', () => {
    const l = good(); l.scoreEnabled = false; l.blocks = l.blocks.filter((b) => b.kind !== 'score_explanation');
    expect(issue(run(l), 'score_explanation_missing')).toEqual([]);
  });
  it('fail: score_enabled with two score_explanation blocks ("exactly one")', () => {
    const l = extraBlock(good(), { id: sid(81), kind: 'score_explanation', blockKey: 'score.second', textEn: 'A second explanation.' });
    expect(run(l).valid).toBe(false);
  });
  it('pass: one score_explanation', () => expect(issue(run(good()), 'score_explanation_missing')).toEqual([]));
});

describe('V3 generic deranged rules (AC-06.3)', () => {
  const only = (l: LibInput, keep: (r: LibRule) => boolean) => { l.rules = l.rules.filter(keep); return l; };
  it('pass: any/low + any/high + any/abnormal at borderline (starter)', () => expect(issue(run(good()), 'generic_deranged_missing')).toEqual([]));
  it('pass: one any/any rule at borderline covers all three directions', () => {
    const l = only(good(), (r) => r.ruleKind !== 'deranged'); l.rules.push({ id: sid(82), ruleKind: 'deranged', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 900, blockId: sid(1), blockKind: 'deranged' });
    expect(issue(run(l), 'generic_deranged_missing')).toEqual([]);
  });
  it('fail: missing one direction -> one issue naming exactly that direction', () => {
    const r = run(only(good(), (r) => r.direction !== 'abnormal'));
    const i = issue(r, 'generic_deranged_missing');
    expect(i.map((x: any) => x.direction)).toEqual(['abnormal']); expect(r.valid).toBe(false);
  });
  it('fail: no deranged rule at all -> issues for low, high and abnormal', () => {
    const i = issue(run(only(good(), (r) => r.ruleKind !== 'deranged')), 'generic_deranged_missing');
    expect(i.map((x: any) => x.direction).sort()).toEqual(['abnormal', 'high', 'low']);
  });
  it.each([
    ['min_severity out_of_range', { minSeverity: 'out_of_range' }],
    ['group trigger', { triggerKind: 'group', groupCode: 'liver' }],
    ['analyte trigger', { triggerKind: 'analyte', analyteId: sid(901) }],
  ])('fail: a rule with %s does not count as the generic rule', (_n, patch) => {
    const l = good(); Object.assign(l.rules.find((r) => r.direction === 'high')!, patch);
    expect(issue(run(l), 'generic_deranged_missing').map((x: any) => x.direction)).toEqual(['high']);
  });
});

describe('V4 placeholders (AC-03.4)', () => {
  it('pass: allowed placeholders for the kind', () => {
    const l = withText('deranged.generic.high', '{analyte_name} is {value} {unit} outside {ref_range} in {group_name}.');
    // digits are not in the text; the placeholders themselves are letters
    expect(issue(run(l), 'placeholder_unknown')).toEqual([]);
  });
  it('fail: {dose} in a deranged block -> placeholder_unknown with block path, key and the name', () => {
    const l = withText('deranged.generic.high', '{analyte_name} needs {dose}.');
    const i = issue(run(l), 'placeholder_unknown');
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(1)}`, blockKey: 'deranged.generic.high', placeholder: 'dose' });
  });
  it.each([['advice', 'advice.all_in_range', '{value} was seen.'], ['disclaimer', 'disclaimer.main', 'See {analyte_name}.'], ['score_explanation', 'score.explanation', '{group_name} counts.']])(
    'fail: a placeholder not allowed for kind %s', (_k, key, text) => {
      expect(codes(run(withText(key, text)))).toContain('placeholder_unknown');
    });
  it('fail: unknown placeholder in text_ne is found too', () => {
    const l = neLibrary(); block(l, 'deranged.generic.high').textNe = '{analyte_name} {dose} छ।';
    expect(codes(run(l))).toContain('placeholder_unknown');
  });
  it('fail: advice {analyte_name} used only by a group-triggered rule -> placeholder_unresolvable', () => {
    const l = good(); l.rules = l.rules.filter((r) => r.ruleKind !== 'advice');
    extraBlock(l, { id: sid(83), kind: 'advice', blockKey: 'advice.group', textEn: '{analyte_name} needs attention.' }, { triggerKind: 'group', groupCode: 'liver' });
    expect(issue(run(l), 'placeholder_unresolvable')[0]).toMatchObject({ severity: 'error', blockKey: 'advice.group', placeholder: 'analyte_name' });
  });
  it('pass: the same advice text used by an analyte-triggered rule', () => {
    const l = good(); l.rules = l.rules.filter((r) => r.ruleKind !== 'advice');
    extraBlock(l, { id: sid(83), kind: 'advice', blockKey: 'advice.analyte', textEn: '{analyte_name} needs attention.' }, { triggerKind: 'analyte', analyteId: sid(901) });
    expect(issue(run(l), 'placeholder_unresolvable')).toEqual([]);
  });
  it('fail: advice {analyte_name} used by an all_in_range rule', () => {
    expect(codes(run(withText('advice.all_in_range', '{analyte_name} is fine.')))).toContain('placeholder_unresolvable');
  });
  it('fail: follow-up {analyte_name} under a group trigger; pass under an analyte trigger; {test_name}/{interval_days} always resolve', () => {
    const mk = (trigger: Partial<LibRule>) => extraBlock(good(), { id: sid(84), kind: 'followup', blockKey: 'followup.x', textEn: 'Repeat {test_name} after {interval_days} days for {analyte_name}.' },
      { ruleKind: 'followup', suggestedTestId: sid(100), intervalDays: 90, ...trigger });
    expect(issue(run(mk({ triggerKind: 'group', groupCode: 'liver' })), 'placeholder_unresolvable').map((i: any) => i.placeholder)).toEqual(['analyte_name']);
    expect(issue(run(mk({ triggerKind: 'analyte', analyteId: sid(901) })), 'placeholder_unresolvable')).toEqual([]);
  });
  it('pass: a placeholder with a hostile name shape is plain text, never evaluated', () => {
    expect(codes(run(withText('deranged.generic.high', '{analyte_name} __proto__ constructor.')))).not.toContain('placeholder_unknown');
  });
});

describe('V5 digits (AC-03.3, AB-4)', () => {
  it('pass: no digits', () => expect(issue(run(good()), 'digits_not_allowed')).toEqual([]));
  it.each([['ASCII', 'Repeat in 3 months.'], ['Devanagari', 'तीन महिना पछि ३ फेरि गर्नुहोस्।'], ['mixed', 'abc ०x9']])('fail: %s digit -> digits_not_allowed on that block', (_n, t) => {
    const l = withText('advice.all_in_range', t);
    const i = issue(run(l), 'digits_not_allowed');
    expect(i).toHaveLength(1); expect(i[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(4)}` });
  });
  it('fail: a digit in text_ne of an English library (every text is scanned)', () => {
    const l = good(); block(l, 'advice.all_in_range').textNe = 'सबै ठीक छ ५';
    expect(codes(run(l))).toContain('digits_not_allowed');
  });
  it('pass: digits in block_key are not text', () => {
    const l = good(); block(l, 'advice.all_in_range').blockKey = 'advice.range2';
    expect(issue(run(l), 'digits_not_allowed')).toEqual([]);
  });
});

describe('V6 follow-up test active (AC-05.2) — pure part; catalog lookup is in library.service.test.ts', () => {
  const T_OK = sid(100), T_OFF = sid(107);
  const withFollowups = () => {
    const l = good();
    extraBlock(l, { id: sid(85), kind: 'followup', blockKey: 'followup.a', textEn: 'Repeat {test_name}.' }, { id: sid(86), ruleKind: 'followup', suggestedTestId: T_OK, intervalDays: 90 });
    l.rules.push({ id: sid(87), ruleKind: 'followup', triggerKind: 'any', direction: 'high', minSeverity: 'out_of_range', priority: 100, blockId: sid(85), blockKind: 'followup', suggestedTestId: T_OFF, intervalDays: 30 });
    return l;
  };
  it('pass: all follow-up tests active', () => expect(issue(run(withFollowups(), env()), 'followup_test_inactive')).toEqual([]));
  it('fail: inactive test -> followup_test_inactive on exactly the rule that suggests it', () => {
    const i = issue(run(withFollowups(), env({ inactiveTests: [T_OFF] })), 'followup_test_inactive');
    expect(i.map((x: any) => x.path)).toEqual([`/rules/${sid(87)}`]); expect(i[0].severity).toBe('error');
  });
  it('fail: valid=false because of it', () => expect(run(withFollowups(), env({ inactiveTests: [T_OFF] })).valid).toBe(false));
});

describe('V7 deny terms (AC-06.4, AB-2, AB-11)', () => {
  it('pass: clean text', () => expect(issue(run(good()), 'deny_term')).toEqual([]));
  it('fail: global term "supplement" -> deny_term with block key and the term', () => {
    const i = issue(run(withText('advice.all_in_range', 'Consider a Supplement daily.')), 'deny_term');
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(4)}`, blockKey: 'advice.all_in_range', term: 'supplement' });
  });
  it('fail: zero-width character hides the term', () => expect(codes(run(withText('advice.all_in_range', 'Take a supp​lement.')))).toContain('deny_term'));
  it('fail: upper-case variant is case-folded ("DIAGNOSIS" vs term diagnos)', () => expect(codes(run(withText('advice.all_in_range', 'DIAGNOSIS is not given.')))).toContain('deny_term'));
  it('pass: Latin term inside another word is not a hit ("procure")', () => expect(issue(run(withText('advice.all_in_range', 'We procure samples.')), 'deny_term')).toEqual([]));
  it('fail: tenant term supplied in env.denyTerms is applied; without it the same text passes', () => {
    const l = withText('advice.all_in_range', 'This is a miracle result.');
    expect(issue(run(l), 'deny_term')).toEqual([]);
    expect(issue(run(l, env({ terms: [...GLOBAL_DENY, 'miracle'] })), 'deny_term')[0]).toMatchObject({ term: 'miracle' });
  });
  it('fail: Devanagari tenant term matches as a substring in text_ne', () => {
    const l = neLibrary(); block(l, 'advice.all_in_range').textNe = 'यो औषधी हो।';
    expect(issue(run(l, env({ terms: ['औषधी'] })), 'deny_term')[0]).toMatchObject({ term: 'औषधी' });
  });
  it('fail: the term is found in text_ne of an English library as well', () => {
    const l = good(); block(l, 'advice.all_in_range').textNe = 'supplement';
    expect(codes(run(l))).toContain('deny_term');
  });
  it('starter score explanation passes the global deny list incl. "diagnos" (08 A19 D-108)', () => {
    const l = good(); expect(issue(run(l), 'deny_term')).toEqual([]);
    expect(codes(run(withText('score.explanation', 'This is not a diagnosis.')))).toContain('deny_term');
  });
});

describe('V8 links and contact shapes (AC-18.4)', () => {
  it('pass: plain text', () => expect(issue(run(good()), 'contact_or_link_not_allowed')).toEqual([]));
  it.each([['http', 'Read https://example.org/x for more.'], ['www.', 'Visit www.example.org today.'], ['e-mail', 'Write to lab@example.org please.'], ['bare a@b shape', 'Mail a@b now.'],
    ['phone with plus', 'Call +977 9800000000 now.'], ['phone Devanagari digits', 'फोन ९८००००००००'], ['phone with dashes', 'Dial 555-0100-200']])(
    'fail: %s -> contact_or_link_not_allowed on the block', (_n, t) => {
      const i = issue(run(withText('advice.all_in_range', t)), 'contact_or_link_not_allowed');
      expect(i).toHaveLength(1); expect(i[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(4)}` });
    });
  it('fail: also in text_ne', () => {
    const l = neLibrary(); block(l, 'advice.all_in_range').textNe = 'सम्पर्क www.example.org';
    expect(codes(run(l))).toContain('contact_or_link_not_allowed');
  });
  it('ReDoS: 150k characters without "@" / spaces, and 150k dashes, validate in well under 2 s', () => {
    for (const t of ['a'.repeat(150_000), '-'.repeat(150_000), '1 '.repeat(75_000), '+'.repeat(150_000)]) {
      const s = Date.now(); run(withText('advice.all_in_range', t));
      expect(Date.now() - s, `text starting ${t.slice(0, 4)}`).toBeLessThan(2000);
    }
  });
});

describe('V9 language', () => {
  it('pass: en library, English text', () => expect(issue(run(good()), 'wrong_script')).toEqual([]));
  it('fail: en library, used block with Devanagari in text_en -> wrong_script', () => {
    const i = issue(run(withText('deranged.generic.low', '{analyte_name} कम छ।')), 'wrong_script');
    expect(i[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(2)}` });
  });
  it.each([[null], ['']])('fail: en library, used block without text_en (%j) -> language_text_missing', (t) => {
    const l = withText('deranged.generic.low', t as any, NE.deranged);
    expect(issue(run(l), 'language_text_missing')[0]).toMatchObject({ severity: 'error', path: `/blocks/${sid(2)}` });
  });
  it('pass: ne library, every used block has Devanagari text_ne', () => expect(issue(run(neLibrary()), 'language_text_missing')).toEqual([]));
  it('fail: ne library, text_ne without a Devanagari letter -> wrong_script', () => {
    const l = neLibrary(); block(l, 'deranged.generic.low').textNe = '{analyte_name} is low.';
    expect(codes(run(l))).toContain('wrong_script');
  });
  it('fail: ne library, used block missing text_ne -> language_text_missing', () => {
    const l = neLibrary(); block(l, 'deranged.generic.low').textNe = null;
    expect(codes(run(l))).toContain('language_text_missing');
  });
  it('pass: an UNUSED block is not language-checked (only "used" blocks are)', () => {
    const l = extraBlock(good(), { id: sid(88), kind: 'advice', blockKey: 'advice.unused', textEn: null, textNe: 'केही पाठ' });
    expect(issue(run(l), 'language_text_missing')).toEqual([]);
  });
});

describe('V10 block kind', () => {
  it('pass: rule and block kinds agree', () => expect(issue(run(good()), 'block_kind_mismatch')).toEqual([]));
  it('fail: rule.block_kind differs from the block kind -> block_kind_mismatch on the rule', () => {
    const l = good(); l.rules.find((r) => r.id === sid(14))!.blockId = sid(5);   // advice rule -> disclaimer block
    const i = issue(run(l), 'block_kind_mismatch');
    expect(i[0]).toMatchObject({ severity: 'error', path: `/rules/${sid(14)}` });
  });
  it('fail: rule_kind differs from the block kind', () => {
    const l = good(); l.rules.find((r) => r.id === sid(11))!.blockId = sid(4);    // deranged rule -> advice block
    expect(issue(run(l), 'block_kind_mismatch')[0]).toMatchObject({ path: `/rules/${sid(11)}` });
  });
});

describe('V11 size limits [CONV]', () => {
  const blocks = (l: LibInput, n: number) => { l.blocks = [...l.blocks]; while (l.blocks.length < n) l.blocks.push({ id: sid(50000 + l.blocks.length), blockKey: `pad.b${l.blocks.length}`, kind: 'advice', textEn: 'Neutral.' }); return l; };
  const rules = (l: LibInput, n: number) => { while (l.rules.length < n) l.rules.push({ id: sid(60000 + l.rules.length), ruleKind: 'advice', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 100, blockId: sid(4), blockKind: 'advice' }); return l; };
  const maps = (l: LibInput, n: number) => { l.mappings = []; for (let i = 0; i < n; i++) l.mappings.push({ id: sid(70000 + i), analyteId: sid(80000 + i), groupCode: 'other' }); return l; };
  it.each([['blocks', (l: LibInput, n: number) => blocks(l, n), 500], ['rules', rules, 1000], ['mappings', maps, 2000]] as const)('pass at the limit / fail one over: %s', (_n, fill, limit) => {
    expect(issue(run((fill as any)(good(), limit)), 'library_too_large')).toEqual([]);
    const over = run((fill as any)(good(), limit + 1));
    expect(issue(over, 'library_too_large')[0]).toMatchObject({ severity: 'error' }); expect(over.valid).toBe(false);
  });
});

describe('V12 unused blocks (warning)', () => {
  it('pass: every block referenced, disclaimer/score explanation exempt (starter has none)', () => expect(run(good()).warnings).toEqual([]));
  it('fail: unreferenced advice block -> block_unused WARNING, valid stays true', () => {
    const l = extraBlock(good(), { id: sid(89), kind: 'advice', blockKey: 'advice.orphan' });
    const r = run(l);
    expect(issue(r, 'block_unused')).toHaveLength(1);
    expect(r.warnings.find((w) => w.code === 'block_unused')).toMatchObject({ severity: 'warning', path: `/blocks/${sid(89)}` });
    expect(r.errors).toEqual([]); expect(r.valid).toBe(true);
  });
});

describe('V13 inactive analyte (warning)', () => {
  it('pass: all mapped analytes active', () => expect(issue(run(good(), env()), 'analyte_inactive')).toEqual([]));
  it('fail: mapping to an inactive analyte -> analyte_inactive WARNING on the mapping, valid stays true', () => {
    const r = run(good(), env({ inactiveAnalytes: [MAP.analyteId] }));
    expect(r.warnings.find((w) => w.code === 'analyte_inactive')).toMatchObject({ severity: 'warning', path: `/mappings/${MAP.id}` });
    expect(r.valid).toBe(true); expect(codes(r)).not.toContain('analyte_inactive');
  });
});

describe('V14 no mappings + starter library (AC-02.5, 08 A19 D-108)', () => {
  it('fail: no mapping -> no_mappings error, valid=false', () => {
    const l = good(); l.mappings = [];
    const r = run(l);
    expect(codes(r)).toContain('no_mappings'); expect(r.valid).toBe(false);
  });
  it('pass: one mapping removes it', () => expect(codes(run(good()))).not.toContain('no_mappings'));
  it('the starter library (TRD §9.3, verbatim) has exactly one error: no_mappings; no warnings', () => {
    const r = run(starterLibrary());
    expect(codes(r)).toEqual(['no_mappings']); expect(r.warnings).toEqual([]); expect(r.valid).toBe(false);
  });
  it('the starter passes V1-V13 with the real global deny list incl. "diagnos"', () => {
    const r = run(starterLibrary(), env({ terms: GLOBAL_DENY }));
    expect(r.errors.filter((e) => e.code !== 'no_mappings')).toEqual([]);
  });
});
