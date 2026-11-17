// H80-T07 doc-review tests: docs/manual/instruments/truth-h80e-commissioning.md (08-ADDENDUM-TRUTH-H80E §9; LD-139, 2026-11-13).
// Brief: nine steps in the addendum's order; plain words; every U item is a blank for the observed value; vendor engineer vs lab staff split; synthetic data only.
// ASSUMED format (dispute if wrong): each step is a heading `## Step N ...` (N = 1..9, in order). A blank to fill in = a run of 3+ underscores ("Observed: ________")
// on the line that names the U item or within the next 2 lines. Run: node --test tests/docs/H80-T07.commissioning.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docPath = join(root, 'docs/manual/instruments/truth-h80e-commissioning.md');
const norm = (s) => s.replace(/[`*]/g, '').replace(/ /g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const text = existsSync(docPath) ? norm(readFileSync(docPath, 'utf8')) : '';
const lines = text.split(/\r?\n/);

// split into steps by heading "## Step N"
const heads = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#{2,3}\s+Step\s+\d+\b/i.test(l));
const stepNo = (l) => Number(/Step\s+(\d+)/i.exec(l)[1]);
const steps = {};
heads.forEach((h, k) => {
  const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
  steps[stepNo(h.l)] = { start: h.i, lines: lines.slice(h.i, end), text: lines.slice(h.i, end).join('\n') };
});
const stepText = (n) => steps[n]?.text ?? '';

// step -> things the addendum §9 says it contains (names copied verbatim from the addendum)
const MUST = {
  1: [['vendor engineer', /vendor engineer/i], ['static IP', /static IP/i], ['same subnet as lab PC', /same subnet/i], ['LIS address', /LIS address/i], ['port', /\bport\b/i],
      ['analyser menu path', /\[Apply\].*\[Set\].*\[Lis\]/s], ['ping test', /\bping\b/i], ['LIS icon green', /green/i], ['lab staff role', /lab staff/i]],
  2: [['bridge agent', /bridge agent/i], ['static LAN IP', /static LAN IP/i], ['tcp_server', /tcp_server/], ['enrolment code', /enrol?ment code/i], ['never 0.0.0.0', /0\.0\.0\.0/], ['--allow-lan-listener', /--allow-lan-listener/]],
  3: [['commissioning (shadow) state', /commissioning/i], ['shadow', /shadow/i], ['5 patient samples', /\b(5|five)\b[^.\n]*patient/i], ['2 QC runs', /\b(2|two)\b[^.\n]*QC/i], ['raw messages / agent archive', /archive/i],
      ['analyser printout', /printout/i], ['sample_comparison_done', /sample_comparison_done/], ['qc_comparison_done', /qc_comparison_done/]],
  4: [['HbA1c_NGSP', /HbA1c_NGSP/], ['mappings_reviewed', /mappings_reviewed/]],
  5: [['host query', /host query/i], ['QCK OK', /QCK OK/], ['DSR', /\bDSR\b/], ['ACK^Q03', /ACK\^Q03/], ['MSA-2', /MSA-2/]],
  6: [['unregistered tube', /unregistered/i], ['registered without HbA1c', /without HbA1c/i], ['NF', /\bNF\b/]],
  7: [['Devanagari', /Devanagari/]],
  8: [['internet link', /internet/i], ['restore', /restore/i], ['queued results upload', /queued/i], ['no duplicates', /duplicate/i]],
  9: [['sign off', /sign[- ]?off|sign\b/i], ['verified', /\bverified\b/], ['reviewed migration', /migration/i], ['CI job c7-driver-registry-check', /c7-driver-registry-check/],
      ['host_query capability switched on', /host_query/], ['instruments.instrument.manage', /instruments\.instrument\.manage/], ['aal2', /aal2/]],
};

// every U (unverified) item in the addendum, with the step that records it and a regex naming it. `n` = how many separate blanks it needs.
const U_ITEMS = [
  { id: 'LIS settings labels (Enable/Duplex/Result Flag/Abnormal Results/Alarm Prompt)', steps: [1], re: /Duplex|Result Flag|Alarm Prompt/i },
  { id: 'MSH-16 type flag', steps: [3], re: /MSH-16/ },
  { id: 'OBR-15 position (detection mode)', steps: [3], re: /OBR-15/ },
  { id: 'result-time position OBX-13 vs OBX-14', steps: [3], re: /OBX-13/ },
  { id: 'OBX-8 meaning', steps: [3], re: /OBX-8/ },
  { id: 'QC level letters', steps: [3], re: /level letters?/i },
  { id: 'chromatogram size', steps: [3], re: /chromatogram/i },
  { id: 'sender names LIS / LIMS accepted by analyser', steps: [3, 5], re: /LIS\s*\/\s*LIMS|ack_sending_app|sender name/i },
  { id: 'reply timeout', steps: [5], re: /timeout/i },
  { id: 'ACK policy: does analyser ACK the QCK', steps: [5], re: /acknowledg|ACK policy|ack(s|ed)? the QCK/i },
  { id: 'ACK^Q03 MSA-2 form', steps: [5], re: /MSA-2/ },
  { id: 'NF behaviour: unregistered tube', steps: [6], re: /unregistered/i },
  { id: 'NF behaviour: tube registered without HbA1c', steps: [6], re: /without HbA1c/i },
  { id: 'Devanagari name rendering', steps: [7], re: /Devanagari/ },
  { id: 'offline behaviour (internet pulled)', steps: [8], re: /internet|offline|no reply/i },
  { id: 'queued results upload once, no duplicates', steps: [8], re: /duplicate|once/i },
];
const BLANK = /_{3,}/;
const hasBlankFor = (stepLines, re) =>
  stepLines.some((l, i) => re.test(l) && stepLines.slice(i, i + 3).some((x) => BLANK.test(x)));

describe('H80-T07 commissioning runbook', () => {
  test('runbook file exists at docs/manual/instruments/truth-h80e-commissioning.md', () => {
    assert.ok(existsSync(docPath), `missing ${docPath}`);
    assert.ok(text.trim().length > 500, 'runbook is empty or a stub');
  });

  test('exactly nine steps, numbered 1..9 in order (same order as addendum §9)', () => {
    assert.deepEqual(heads.map((h) => stepNo(h.l)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('step titles follow the addendum order (IP+LIS, agent, shadow run, mapping, host query, NF, Devanagari, offline, sign-off)', () => {
    const t = (n) => (heads[n - 1]?.l ?? '');
    const order = [/static IP|LIS/i, /agent/i, /shadow|commissioning|samples?/i, /map/i, /host query/i, /unregistered|NF|without/i, /Devanagari/i, /internet|offline|link/i, /sign/i];
    order.forEach((re, k) => assert.match(t(k + 1), re, `step ${k + 1} heading "${t(k + 1)}"`));
  });

  for (const [n, items] of Object.entries(MUST)) {
    test(`step ${n} covers what addendum §9 item ${n} says`, () => {
      assert.ok(stepText(n), `step ${n} missing`);
      for (const [name, re] of items) assert.match(stepText(n), re, `step ${n}: missing "${name}"`);
    });
  }

  test('says who does what: vendor engineer does static IP + LIS address in step 1; lab staff named in step 1', () => {
    const s1 = stepText(1);
    assert.match(s1, /vendor engineer[^.\n]*(static IP|sets)/i);
    assert.match(s1, /lab staff/i);
  });

  test('step 3 captures raw messages and compares with the analyser printout; names the four commissioning flags across the runbook', () => {
    for (const f of ['manual_reference_confirmed', 'sample_comparison_done', 'qc_comparison_done', 'mappings_reviewed']) assert.ok(text.includes(f), `flag ${f} not named`);
  });

  describe('every U item is a blank to fill in with the observed value', () => {
    for (const u of U_ITEMS) {
      test(u.id, () => {
        const ok = u.steps.some((n) => hasBlankFor(steps[n]?.lines ?? [], u.re));
        assert.ok(ok, `no blank (____) next to "${u.re}" in step(s) ${u.steps.join('/')}`);
      });
    }
    test('each blank is labelled as an observed value (word "Observed" or "Record" on the blank line)', () => {
      const blankLines = lines.filter((l) => BLANK.test(l));
      assert.ok(blankLines.length >= U_ITEMS.length, `only ${blankLines.length} blanks for ${U_ITEMS.length} U items`);
      for (const l of blankLines) assert.match(l, /observed|record|value|result|behaviou?r|seen|shows?|time|answer/i, `unlabelled blank: ${l}`);
    });
  });

  test('sign-off step has blanks for names and date (who signed, when)', () => {
    const s9 = steps[9]?.lines ?? [];
    assert.ok(s9.filter((l) => BLANK.test(l)).length >= 3, 'step 9 needs blanks for lab manager, vendor engineer, date');
    assert.match(stepText(9), /lab manager/i);
    assert.match(stepText(9), /vendor engineer/i);
    assert.match(stepText(9), /date/i);
  });

  test('plain words: no sentence longer than 40 words', () => {
    const prose = lines.filter((l) => !/^\s*(\||```|#)/.test(l)).join(' ').replace(/_{3,}/g, ' ');
    const long = prose.split(/(?<=[.!?])\s+/).filter((s) => s.trim().split(/\s+/).length > 40);
    assert.deepEqual(long, [], `long sentences: ${long.map((s) => s.slice(0, 60)).join(' | ')}`);
  });

  test('synthetic data only: says examples are synthetic; no real emails, phone numbers, long digit ids or secrets', () => {
    assert.match(text, /synthetic|fictitious|made[- ]up|dummy/i, 'must state examples are synthetic');
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    for (const e of emails) assert.match(e, /@(example\.(com|org|net)|[\w-]+\.test)$/i, `non-synthetic email ${e}`);
    assert.doesNotMatch(text, /(?<![\d.])(\+?977[- ]?)?9[78]\d{8}(?![\d.])/, 'looks like a real Nepal mobile number');
    assert.doesNotMatch(text, /\b\d{10,}\b/, 'long digit string (phone/national id?)');
    assert.doesNotMatch(text, /Bearer\s+\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+|[A-Za-z0-9+/]{40,}={0,2}/i, 'secret/token-like content');
  });

  test('no invented test list for the DSR (LD-139: the manual DSR has no test list)', () => {
    assert.doesNotMatch(text, /test list (is|are) sent|DSR (carries|contains|includes) (a )?test (list|codes)/i);
  });
});
