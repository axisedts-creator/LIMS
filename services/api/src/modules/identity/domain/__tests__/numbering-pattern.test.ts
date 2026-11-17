// T2 numbering-pattern.ts (AC-C3.1, AC-C3.2, US-C2; 03-APP-FLOW §6.1 step 2; 03-IC §9.3; 05-SCHEMA §4.6; 08 A13 D-23(1)).
// Assumed API (pure):
//   NUMBERING_KINDS = ['patient_code','registration_no','barcode','invoice_no','credit_note_no','receipt_no','accession_no']
//   validateNumberingPattern(kind, pattern: string)
//     -> { ok: true } | { ok: false; code: 'common.validation_failed'; reason: string }
//   Tokens: {prefix} {branch} {centre} {yy} {fy} {fyl} {seq:N} (1<=N<=12); literals [A-Z0-9/-]; exactly one {seq:N};
//   max rendered length 30 (barcode: literals [A-Z0-9] only, max 20). Required: invoice/credit-note/receipt -> {fy} or {fyl};
//   registration -> {branch}. Tests use literal/seq lengths only, so no token-width assumptions are needed at the boundaries.
import { describe, expect, it } from 'vitest';
import { NUMBERING_KINDS, validateNumberingPattern } from '../numbering-pattern.js';

const FAIL = { ok: false, code: 'common.validation_failed' };
const ok = (kind: string, p: string) => expect(validateNumberingPattern(kind as never, p), `${kind} ${p}`).toEqual({ ok: true });
const no = (kind: string, p: string) => expect(validateNumberingPattern(kind as never, p), `${kind} ${p}`).toMatchObject(FAIL);

describe('kinds', () => {
  it('lists the seven pattern columns of 05-SCHEMA §4.6', () => {
    expect([...NUMBERING_KINDS].sort()).toEqual(
      ['accession_no', 'barcode', 'credit_note_no', 'invoice_no', 'patient_code', 'receipt_no', 'registration_no']);
  });
});

describe('spec defaults are valid (05-SCHEMA §4.6)', () => {
  it.each([
    ['patient_code', '{prefix}{seq:8}'],
    ['registration_no', '{branch}{prefix}{seq:6}'],
    ['barcode', '{prefix}{yy}{seq:8}'],
    ['invoice_no', '{fy}-{seq:6}'],
    ['credit_note_no', 'CN-{fy}-{seq:6}'],
    ['receipt_no', 'RC-{fy}-{seq:6}'],
    ['accession_no', '{prefix}{yy}-{seq:4}'],
  ])('%s %s', (kind, p) => ok(kind, p));
});

describe('every token is accepted (03 §9.3)', () => {
  it.each(['{prefix}', '{branch}', '{centre}', '{yy}', '{fy}', '{fyl}'])('%s alongside {seq:6} (patient_code)', (t) => {
    ok('patient_code', `${t}{seq:6}`);
  });
  it('all tokens together with separators', () => ok('patient_code', '{prefix}/{branch}-{centre}-{yy}-{fy}-{fyl}-{seq:4}'));
  it('literals A-Z 0-9 / - are accepted', () => ok('patient_code', 'AB09/-{seq:5}'));
});

describe('{seq:N}', () => {
  it.each([1, 2, 6, 11, 12])('N=%i ok', (n) => ok('patient_code', `{seq:${n}}`));
  it.each([0, 13, 99, -1])('N=%i rejected', (n) => no('patient_code', `{seq:${n}}`));
  it('{seq} without width rejected', () => no('patient_code', 'A{seq}'));
  it('{seq:} and {seq:x} and {seq:1.5} and {seq:01x} rejected', () => {
    for (const p of ['A{seq:}', 'A{seq:x}', 'A{seq:1.5}', 'A{seq:01x}']) no('patient_code', p);
  });
  it('no {seq:N} at all rejected', () => no('patient_code', '{prefix}{yy}'));
  it('two {seq:N} rejected (exactly one)', () => no('patient_code', '{seq:3}-{seq:3}'));
  it('{seq:N} written on a token that takes no width is rejected', () => {
    for (const p of ['{branch:3}{seq:4}', '{fy:2}{seq:4}', '{prefix:1}{seq:4}']) no('patient_code', p);
  });
});

describe('unknown / malformed tokens and characters', () => {
  it.each(['{foo}{seq:4}', '{SEQ:4}', '{Prefix}{seq:4}', '{}{seq:4}', '{ seq:4}', '{yyyy}{seq:4}', '{mm}{seq:4}'])(
    'unknown token %s rejected', (p) => no('patient_code', p));
  it('unbalanced braces rejected', () => {
    for (const p of ['{seq:4', 'seq:4}', '{{seq:4}}', '{seq:4}}', '{prefix{seq:4}']) no('patient_code', p);
  });
  it('lowercase / space / punctuation / non-ASCII literals rejected', () => {
    for (const p of ['a{seq:4}', 'A B{seq:4}', 'A_{seq:4}', 'A.{seq:4}', 'A#{seq:4}', "A'{seq:4}", 'अ{seq:4}', 'A\n{seq:4}', 'A\u0000{seq:4}']) {
      no('patient_code', p);
    }
  });
  it('injection-shaped patterns rejected', () => {
    for (const p of ['${process.env.X}{seq:4}', '<script>{seq:4}', "'; DROP TABLE x;--{seq:4}", '%s{seq:4}', '..\\..\\{seq:4}']) {
      no('patient_code', p);
    }
  });
  it('empty pattern and non-string input rejected', () => {
    no('patient_code', '');
    for (const v of [null, undefined, 5, {}, ['{seq:4}']]) {
      expect(validateNumberingPattern('patient_code', v as never)).toMatchObject(FAIL);
    }
  });
  it('unknown kind rejected', () => {
    expect(validateNumberingPattern('nope' as never, '{seq:4}')).toMatchObject(FAIL);
  });
});

describe('max rendered length 30 (literals + seq widths)', () => {
  it('29 literals + {seq:1} = 30 ok', () => ok('patient_code', `${'A'.repeat(29)}{seq:1}`));
  it('30 literals + {seq:1} = 31 rejected', () => no('patient_code', `${'A'.repeat(30)}{seq:1}`));
  it('18 literals + {seq:12} = 30 ok; 19 + 12 = 31 rejected', () => {
    ok('patient_code', `${'A'.repeat(18)}{seq:12}`);
    no('patient_code', `${'A'.repeat(19)}{seq:12}`);
  });
  it('applies to invoice too: {fy} + 24 literals + {seq:1} is over 30 -> rejected', () => {
    no('invoice_no', `{fy}${'A'.repeat(24)}{seq:1}`);
  });
});

describe('AC-C3.1 fiscal numbers need {fy} or {fyl}', () => {
  it.each(['invoice_no', 'credit_note_no', 'receipt_no'])('%s without {fy}/{fyl} -> validation_failed', (k) => {
    no(k, '{seq:6}');
    no(k, 'INV-{yy}-{seq:6}');
    no(k, '{prefix}-{seq:6}');
  });
  it.each(['invoice_no', 'credit_note_no', 'receipt_no'])('%s with {fy} ok, with {fyl} ok', (k) => {
    ok(k, '{fy}-{seq:6}');
    ok(k, '{fyl}-{seq:6}');
    ok(k, 'X-{fy}/{seq:6}');
  });
  it('a literal "FY" is not the token', () => no('invoice_no', 'FY-{seq:6}'));
  it('{fy} is optional for non-fiscal kinds', () => {
    ok('patient_code', '{seq:8}');
    ok('accession_no', '{prefix}{yy}-{seq:4}');
  });
});

describe('AC-C3.2 registration needs {branch}', () => {
  it('without {branch} -> validation_failed', () => {
    no('registration_no', '{prefix}{seq:6}');
    no('registration_no', '{centre}{seq:6}');
    no('registration_no', 'BRANCH{seq:6}');
  });
  it('with {branch} ok, anywhere', () => {
    ok('registration_no', '{branch}{prefix}{seq:6}');
    ok('registration_no', '{prefix}-{branch}-{seq:6}');
    ok('registration_no', '{seq:6}{branch}');
  });
  it('{branch} is not required for other kinds', () => ok('patient_code', '{prefix}{seq:8}'));
});

describe('barcode: [A-Z0-9] only, max 20', () => {
  it('slash and hyphen literals rejected for barcode but fine for patient_code', () => {
    no('barcode', 'A-{seq:6}');
    no('barcode', 'A/{seq:6}');
    ok('patient_code', 'A-{seq:6}');
  });
  it('A-Z0-9 literals and tokens ok', () => ok('barcode', 'E{yy}{seq:8}'));
  it('19 literals + {seq:1} = 20 ok; 20 + 1 = 21 rejected', () => {
    ok('barcode', `${'A'.repeat(19)}{seq:1}`);
    no('barcode', `${'A'.repeat(20)}{seq:1}`);
  });
  it('a 30-char barcode that would pass for patient_code is rejected', () => {
    const p = `${'A'.repeat(29)}{seq:1}`;
    ok('patient_code', p);
    no('barcode', p);
  });
});
