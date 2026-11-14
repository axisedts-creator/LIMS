// MET-T06 doc-review tests: docs/manual/instruments/getein-metis-commissioning.md (09-ADDENDUM-GETEIN-METIS §9; LD-163, 2026-11-14).
// Brief: nine steps in the addendum's order; plain words; each U item (U1..U15) is a blank to fill in with the observed value;
// vendor engineer vs lab staff split; item list is read from the analyser itself; synthetic data only.
// ASSUMED format (dispute if wrong): each step is a heading `## Step N ...` (N = 1..9, in order). Each U item is named by its id ("U1".."U15")
// on a line, and a blank to fill in = a run of 3+ underscores ("Observed: ________") on that line or within the next 2 lines.
// Which step records which U item is taken from addendum §0 table ("Closed by") and §9 ("Confirms ...").
// Run: node --test tests/docs/MET-T06.commissioning.test.mjs   (MET_DOC env var overrides the doc path; used only to self-check the tests)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docPath = process.env.MET_DOC ?? join(root, 'docs/manual/instruments/getein-metis-commissioning.md');
const norm = (s) => s.replace(/[`*]/g, '').replace(/ /g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const text = existsSync(docPath) ? norm(readFileSync(docPath, 'utf8')) : '';
const lines = text.split(/\r?\n/);

const heads = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#{2,3}\s+Step\s+\d+\b/i.test(l));
const stepNo = (l) => Number(/Step\s+(\d+)/i.exec(l)[1]);
const steps = {};
heads.forEach((h, k) => {
  const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
  steps[stepNo(h.l)] = { lines: lines.slice(h.i, end), text: lines.slice(h.i, end).join('\n') };
});
const stepText = (n) => steps[n]?.text ?? '';

// what addendum §9 item N says that step N must contain (names verbatim from the addendum)
const MUST = {
  1: [['vendor engineer', /vendor engineer/i], ['static IP', /static IP/i], ['same subnet as the lab PC', /same subnet/i], ['LIS settings', /LIS settings/i],
      ['LIS address (the lab PC + port)', /LIS address/i], ['port', /\bport\b/i], ['analyser connects out or listens', /connects? out/i],
      ['if it listens, stop', /listens/i], ['CR-C7-021', /CR-C7-021/], ['lab staff role', /lab (staff|manager)/i]],
  2: [['bridge agent', /bridge agent/i], ['lab PC', /lab PC/i], ['static LAN IP', /static LAN IP/i], ['tcp_server', /tcp_server/], ['enrolment code', /enrol?ment code/i]],
  3: [['commissioning state', /commissioning/i], ['shadow', /shadow/i], ['5 patient samples', /\b(5|five)\b[^.\n]*patient/i], ['2 QC runs per level', /\b(2|two)\b[^.\n]*QC[^.\n]*level/i],
      ['raw messages captured', /raw message/i], ['compare with the analyser printout', /printout/i]],
  4: [['analyser item list', /item list/i], ['which ids the lab runs', /\bids?\b/i], ['map to the lab tests', /\bmap/i], ['review', /review/i]],
  5: [['host query', /host query/i], ['shadow', /shadow/i], ['scan a registered tube', /registered/i], ['QCK OK', /QCK OK/], ['DSR', /\bDSR\b/], ['analyser shows the sample and runs the listed tests', /listed tests|runs the tests/i],
      ['ACK^Q03', /ACK\^Q03/], ['QCK acknowledged or not', /acknowledg/i]],
  6: [['unregistered tube', /unregistered/i], ['registered without any test mapped to this analyser', /without any test mapped/i], ['NF', /\bNF\b/], ['record what the analyser does', /record/i]],
  7: [['sample-number-range', /sample[- ]number[- ]range/i], ['time-range', /time[- ]range/i], ['NF', /\bNF\b/], ['LIS-pushed sample request', /LIS-pushed/i], ['ask the vendor engineer', /vendor engineer/i],
      ['CR-C7-022', /CR-C7-022/]],
  8: [['Devanagari name', /Devanagari/], ['analyser renders it', /render/i], ['calibration run', /calibration/i], ['archived harmlessly', /archived/i]],
  9: [['internet link', /internet/i], ['scan a tube', /scan/i], ['restore', /restore/i], ['queued results upload once', /queued/i], ['no duplicates', /duplicate/i],
      ['sign off', /sign[- ]?off|\bsign\b/i], ['verified', /\bverified\b/i], ['reviewed migration', /migration/i], ['host_query', /host_query/],
      ['instruments.instrument.manage', /instruments\.instrument\.manage/], ['aal2', /aal2/]],
};

// U id -> step that records it (addendum §0 "Closed by" column == §9 "Confirms ...")
const U_STEP = { 1: 1, 2: 4, 3: 3, 4: 3, 5: 3, 6: 6, 7: 5, 8: 3, 9: 5, 10: 8, 11: 7, 12: 3, 13: 3, 14: 5, 15: 7 };
const BLANK = /_{3,}/;
const uRe = (n) => new RegExp(`(?<![A-Za-z0-9])U${n}(?![0-9])`);
const hasBlankFor = (stepLines, re) => stepLines.some((l, i) => re.test(l) && stepLines.slice(i, i + 3).some((x) => BLANK.test(x)));

describe('MET-T06 Getein Metis commissioning runbook', () => {
  test('runbook file exists at docs/manual/instruments/getein-metis-commissioning.md', () => {
    assert.ok(existsSync(docPath), `missing ${docPath}`);
    assert.ok(text.trim().length > 500, 'runbook is empty or a stub');
  });

  test('exactly nine steps, numbered 1..9 in order (same order as addendum section 9)', () => {
    assert.deepEqual(heads.map((h) => stepNo(h.l)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('step titles follow the addendum order (IP+LIS, agent, shadow run, item list, host query, NF, range queries, Devanagari, offline+sign-off)', () => {
    const t = (n) => heads[n - 1]?.l ?? '';
    const order = [/static IP|LIS/i, /agent|bridge/i, /shadow|commissioning|samples?/i, /item list|map/i, /host query/i, /unregistered|NF|without/i, /range|download|pushed/i, /Devanagari|calibration/i, /internet|offline|link|sign/i];
    order.forEach((re, k) => assert.match(t(k + 1), re, `step ${k + 1} heading "${t(k + 1)}"`));
  });

  for (const [n, items] of Object.entries(MUST)) {
    test(`step ${n} covers what addendum section 9 item ${n} says`, () => {
      assert.ok(stepText(n), `step ${n} missing`);
      for (const [name, re] of items) assert.match(stepText(n), re, `step ${n}: missing "${name}"`);
    });
  }

  test('says who does what: vendor engineer sets the static IP and LIS settings (step 1); lab staff / lab manager steps are named', () => {
    const s1 = stepText(1);
    assert.match(s1, /vendor engineer[^.\n]*(static IP|sets|LIS)/i);
    assert.match(s1, /lab (staff|manager)/i);
    assert.match(text, /vendor engineer/i);
    assert.match(text, /lab staff/i);
  });

  test('step 4 says the item list is read from the analyser itself (not taken from the manual or guessed)', () => {
    assert.match(stepText(4), /(read|reads|look|copy|copies|get|gets)[^.\n]*(from|on)[^.\n]*analyser|analyser'?s? own item list|from the analyser itself|analyser itself/i);
    assert.match(stepText(4), /analyser itself|analyser'?s own/i, 'must say "the analyser itself" or "the analyser\'s own"');
  });

  test('address typed into the analyser is the lab PC, never the cloud server (addendum section 1)', () => {
    assert.match(stepText(1), /lab PC/i);
    assert.match(stepText(1), /not the cloud|never the cloud|not the (cloud )?server|no TLS/i);
  });

  test('bind address is the static LAN IP, never 0.0.0.0 (addendum section 1)', () => {
    assert.doesNotMatch(text, /bind[^.\n]{0,40}0\.0\.0\.0(?![^.\n]*(never|not|don't|do not))/i, 'must not tell the reader to bind to 0.0.0.0');
  });

  describe('every U item (U1 to U15) is a blank to fill in with the observed value', () => {
    for (let n = 1; n <= 15; n++) {
      test(`U${n} has a blank (____) in step ${U_STEP[n]}`, () => {
        assert.ok(hasBlankFor(steps[U_STEP[n]]?.lines ?? [], uRe(n)), `no blank (____) on or within 2 lines after the line naming U${n} in step ${U_STEP[n]}`);
      });
    }
    test('each U id is named in exactly the step the addendum assigns it to (never only in a later step)', () => {
      for (let n = 1; n <= 15; n++) assert.match(stepText(U_STEP[n]), uRe(n), `U${n} not named in step ${U_STEP[n]}`);
    });
    test('each blank line is labelled as an observed value (observed/record/value/result/behaviour/shows/time/answer)', () => {
      const blankLines = lines.filter((l) => BLANK.test(l));
      assert.ok(blankLines.length >= 15, `only ${blankLines.length} blanks for 15 U items`);
      for (const l of blankLines) assert.match(l, /observed|record|value|result|behaviou?r|seen|shows?|time|answer|name|date/i, `unlabelled blank: ${l}`);
    });
    test('no blank is pre-filled: a U item line does not already carry an answer in place of the blank', () => {
      for (let n = 1; n <= 15; n++) {
        const own = (steps[U_STEP[n]]?.lines ?? []).filter((l) => uRe(n).test(l));
        assert.ok(own.length > 0, `U${n} not named`);
        for (const l of own) assert.doesNotMatch(l, /\b(confirmed|answer|observed)\s*[:=]\s*(yes|no|true|false|connects?|listens?)\b/i, `U${n} looks pre-answered: ${l}`);
      }
    });
  });

  test('sign-off step has blanks for names and date (who signed, when)', () => {
    const s9 = steps[9]?.lines ?? [];
    assert.ok(s9.filter((l) => BLANK.test(l)).length >= 3, 'step 9 needs blanks for lab manager, vendor engineer, date');
    assert.match(stepText(9), /lab manager/i);
    assert.match(stepText(9), /vendor engineer/i);
    assert.match(stepText(9), /date/i);
  });

  test('promotion is not claimed as done: runbook says verified needs a reviewed migration plus code change (addendum section 9 / 02-TRD 6.1)', () => {
    assert.match(stepText(9), /migration[^.\n]*code change|code change[^.\n]*migration/i);
    assert.doesNotMatch(text, /driver (is now|has been) (promoted|verified)/i);
  });

  test('plain words: no sentence longer than 40 words', () => {
    const prose = lines.filter((l) => !/^\s*(\||```|#)/.test(l)).join(' ').replace(/_{3,}/g, ' ');
    const long = prose.split(/(?<=[.!?])\s+/).filter((s) => s.trim().split(/\s+/).length > 40);
    assert.deepEqual(long, [], `long sentences: ${long.map((s) => s.slice(0, 60)).join(' | ')}`);
  });

  test('synthetic data only: says examples are synthetic; no real emails, phone numbers, long digit ids, secrets or non-synthetic barcodes', () => {
    assert.match(text, /synthetic|fictitious|made[- ]up|dummy/i, 'must state examples are synthetic');
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    for (const e of emails) assert.match(e, /@(example\.(com|org|net)|[\w-]+\.test)$/i, `non-synthetic email ${e}`);
    assert.doesNotMatch(text, /(?<![\d.])(\+?977[- ]?)?9[78]\d{8}(?![\d.])/, 'looks like a real Nepal mobile number');
    assert.doesNotMatch(text, /\b\d{10,}\b/, 'long digit string (phone/national id?)');
    assert.doesNotMatch(text, /Bearer\s+\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+|[A-Za-z0-9+/]{40,}={0,2}/i, 'secret/token-like content');
    for (const b of text.match(/\b[A-Z]{2}\d{8,}\b/g) ?? []) assert.match(b, /^MT26\d{8}$/, `barcode example "${b}" is not in the synthetic MT26xxxxxxxx form`);
    for (const m of text.matchAll(/(patient name|name)\s*[:=]\s*"?([A-Z][a-z]+ [A-Z][a-z]+)"?/g)) assert.equal(m[2], 'Test Patient', `non-synthetic name "${m[2]}"`);
  });

  test('no real IP addresses that look like a lab site: examples use private ranges only', () => {
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
      assert.match(ip, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|127\.)/, `public-looking IP "${ip}"`);
    }
  });

  test('does not copy manual text or LD ids into the runbook as quotes (no "the manual says" block quotes)', () => {
    assert.doesNotMatch(text, /^>\s.{80,}/m, 'long block quote: looks like copied manual text');
  });
});
