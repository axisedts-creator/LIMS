// T0A-12 / 08 A13 P-9, TRD §3.1 spreadsheet row. See .orchestra/notes/T0A-12-tests.md.
// Spec-fixed: neutraliseFormula(cell) prefixes "'" when cell starts with = + - @ \t \r or "'";
//   restoreNeutralised(cell) strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s.
// ASSUMED fixture shape (TRD l.119 names the path, not the shape): packages/test-fixtures/spreadsheet/golden.json
//   { "cases": [ { "input": "<cell>", "neutralised": "<cell after neutraliseFormula>" } ] }; writer creates it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const load = () => import(new URL('../src/spreadsheet/index.ts', import.meta.url).href);
const GOLDEN = new URL('../../test-fixtures/spreadsheet/golden.json', import.meta.url);
const LEAD = ['=', '+', '-', '@', '\t', '\r', "'"];

// inline oracle of the rule text (independent of impl)
const oracle = (s) => (s.length > 0 && LEAD.includes(s[0]) ? "'" + s : s);

describe('neutraliseFormula', () => {
  it('prefixes a single quote for each leading char of the rule', async () => {
    const { neutraliseFormula } = await load();
    for (const c of LEAD) assert.equal(neutraliseFormula(`${c}1+1`), `'${c}1+1`, JSON.stringify(c));
  });
  it('classic payloads', async () => {
    const { neutraliseFormula } = await load();
    for (const p of ['=HYPERLINK("http://x","y")', '=cmd|\' /C calc\'!A0', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', "'=1"]) assert.equal(neutraliseFormula(p), "'" + p);
  });
  it('plain text and non-leading specials are unchanged', async () => {
    const { neutraliseFormula } = await load();
    for (const s of ['', 'abc', 'a=b', 'a+b', 'x-y', 'me@x.np', 'a\tb', 'a\rb', "a'b", ' =1', '0', '12.5', 'नमस्ते', '\n=1', '＝1']) assert.equal(neutraliseFormula(s), s, JSON.stringify(s));
  });
  it('a lone leading char is neutralised too', async () => {
    const { neutraliseFormula } = await load();
    for (const c of LEAD) assert.equal(neutraliseFormula(c), "'" + c);
  });
  it('matches the rule oracle on a seeded fuzz (20k strings, specials over-represented)', async () => {
    const { neutraliseFormula } = await load();
    const alpha = [...LEAD, 'a', 'Z', '0', ' ', '\n', '"', '|', '!', '(', ')', ',', 'é', '\u0000', '‮'];
    let s = 42; const rnd = (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
    for (let i = 0; i < 20000; i++) {
      const t = Array.from({ length: rnd(8) }, () => alpha[rnd(alpha.length)]).join('');
      assert.equal(neutraliseFormula(t), oracle(t), JSON.stringify(t));
    }
  });
  it('SECURITY: output never starts with = + - @ \\t \\r (only the quote may lead)', async () => {
    const { neutraliseFormula } = await load();
    for (const c of LEAD) for (const tail of ['', 'x', '=', "'", '\t']) {
      const out = neutraliseFormula(c + tail);
      assert.ok(!['=', '+', '-', '@', '\t', '\r'].includes(out[0]), JSON.stringify(out));
    }
  });
  it('is not idempotent by design: a second pass quotes the quote (round trip needs one restore per pass)', async () => {
    const { neutraliseFormula, restoreNeutralised } = await load();
    const once = neutraliseFormula('=1'), twice = neutraliseFormula(once);
    assert.equal(once, "'=1"); assert.equal(twice, "''=1");
    assert.equal(restoreNeutralised(restoreNeutralised(twice)), '=1');
  });
  it('1 MB cell is handled linearly and does not throw', async () => {
    const { neutraliseFormula } = await load(); const big = '=' + 'a'.repeat(1 << 20);
    assert.equal(neutraliseFormula(big).length, big.length + 1);
  });
});

describe('restoreNeutralised', () => {
  it('strips exactly one leading single quote', async () => {
    const { restoreNeutralised } = await load();
    assert.equal(restoreNeutralised("'=1"), '=1'); assert.equal(restoreNeutralised("''=1"), "'=1"); assert.equal(restoreNeutralised("'"), ''); assert.equal(restoreNeutralised("'''"), "''");
  });
  it('leaves cells without a leading quote untouched', async () => {
    const { restoreNeutralised } = await load();
    for (const s of ['', 'abc', 'a\'b', '=1', ' \'x']) assert.equal(restoreNeutralised(s), s);
  });
});

describe('round trip: restoreNeutralised(neutraliseFormula(s)) === s', () => {
  it('every leading char of the rule, plain text, and repeated quotes', async () => {
    const { neutraliseFormula: n, restoreNeutralised: r } = await load();
    const heads = [...LEAD, '', "''", "'='", '=-', '@@', '\t\r'];
    for (const h of heads) for (const t of ['', 'x', '1+1', '"q"', "'", '=', '\n']) { const s = h + t; assert.equal(r(n(s)), s, JSON.stringify(s)); }
  });
  it('seeded fuzz, 20k strings including every leading-char combination', async () => {
    const { neutraliseFormula: n, restoreNeutralised: r } = await load();
    const alpha = [...LEAD, 'a', '0', ' ', '\n', '"', 'é', '\u0000', '\u{1F9EA}'];
    let s = 7; const rnd = (k) => { s = (Math.imul(s, 22695477) + 1) >>> 0; return s % k; };
    for (let i = 0; i < 20000; i++) { const t = Array.from({ length: rnd(9) }, () => alpha[rnd(alpha.length)]).join(''); assert.equal(r(n(t)), t, JSON.stringify(t)); }
  });
  it('importer-side: a neutralised cell never validates as a formula before restore, and restores to the original', async () => {
    const { neutraliseFormula: n, restoreNeutralised: r } = await load();
    const cell = n('=1+1'); assert.ok(!/^[=+\-@\t\r]/.test(cell)); assert.equal(r(cell), '=1+1');
  });
});

describe('golden fixture packages/test-fixtures/spreadsheet/golden.json (TRD §3.1)', () => {
  it('exists, covers every leading char of the rule plus plain text, and matches the lib both ways', async () => {
    assert.ok(existsSync(GOLDEN), 'packages/test-fixtures/spreadsheet/golden.json must exist');
    const { cases } = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    assert.ok(Array.isArray(cases) && cases.length >= LEAD.length + 1);
    for (const c of LEAD) assert.ok(cases.some((k) => k.input[0] === c), `no case with leading ${JSON.stringify(c)}`);
    assert.ok(cases.some((k) => k.input.length > 0 && !LEAD.includes(k.input[0]) && k.input === k.neutralised), 'no plain-text case');
    const { neutraliseFormula: n, restoreNeutralised: r } = await load();
    for (const k of cases) {
      assert.equal(n(k.input), k.neutralised, JSON.stringify(k.input));
      assert.equal(r(k.neutralised), k.input, JSON.stringify(k.input));
      assert.equal(k.neutralised, oracle(k.input), 'fixture self-consistent with the rule text');
    }
  });
});
