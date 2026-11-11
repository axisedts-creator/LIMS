// J-T03 (US-BL-16.1): CI text scan "IRD approved… / commission" over C4 web / help / templates / messages.
// Spec: 01-PRD US-BL-16.1 (fails on "IRD approved", "IRD-approved", "IRD certified", "approved by IRD", "commission", case-insensitive);
//       02-TRD "CI jobs for C0-0A" c04-copy-scan (command node apps/web/src/features/billing/__tests__/copy-scan.mjs); 07-SECURITY s6.5.
// Run: node --test tools/lint/tests/copy-scan.test.mjs
// Method: the shipped copy-scan.mjs is COPIED into a throw-away mini repo at the same relative path (it derives its root from
//   import.meta.url), fixtures are planted there and the script is run as a black box (exit code + stderr). Nothing in the real tree is touched.
// Not tested: message-catalog location (spec names no path; apps/web/src/core/i18n/messages.ts is shared by all chunks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_REL = 'apps/web/src/features/billing/__tests__/copy-scan.mjs';
const tmpRoots = [];
test.after(() => tmpRoots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const put = (base, rel, body) => { const p = join(base, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
/** Mini repo with the minimum scan set (one billing page + one billing component) so the empty-scan guard does not trip. */
function repo(files = {}, { seed = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'copy-scan-')); tmpRoots.push(base);
  mkdirSync(dirname(join(base, SCRIPT_REL)), { recursive: true });
  copyFileSync(join(root, SCRIPT_REL), join(base, SCRIPT_REL));
  if (seed) {
    put(base, 'apps/web/src/app/(staff)/billing/page.tsx', 'export default function P() { return <h1>Bills</h1>; }\n');
    put(base, 'apps/web/src/features/billing/components/Bill.tsx', 'export const Bill = () => <p>Net payable</p>;\n');
  }
  for (const [rel, body] of Object.entries(files)) put(base, rel, body);
  return base;
}
const run = (base) => spawnSync(process.execPath, [join(base, SCRIPT_REL)], { cwd: base, encoding: 'utf8' });
const expectFail = (files, why) => {
  const r = run(repo(files)); assert.notEqual(r.status, 0, `must exit non-zero: ${why}\n${r.stdout}${r.stderr}`); return r;
};
const expectPass = (files, why) => {
  const r = run(repo(files)); assert.equal(r.status, 0, `must exit 0: ${why}\n${r.stdout}${r.stderr}`); return r;
};

// ---------- shipped script ----------
test('copy-scan.mjs exists at the path the CI job runs', () => { assert.ok(readFileSync(join(root, SCRIPT_REL), 'utf8').length > 0); });
test('job required: c04-copy-scan is a required status check on main', () => {
  const bp = JSON.parse(readFileSync(join(root, '.github/branch-protection.json'), 'utf8'));
  assert.ok(bp.required_status_checks.contexts.includes('c04-copy-scan'));
});
test('real repo: C4 shipped copy is clean today (exit 0, non-empty scan set)', () => {
  const r = spawnSync(process.execPath, [join(root, SCRIPT_REL)], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /\d+ files clean/);
});

// ---------- every banned phrase, every scan root ----------
const PHRASES = ['IRD approved', 'IRD-approved', 'IRD certified', 'approved by IRD', 'commission'];
const ROOT_FILES = [ // [path, wrap(phrase) => file body]
  ['apps/web/src/features/frontdesk/components/Banner.tsx', (s) => `export const B = () => <p>${s}</p>;\n`],
  ['apps/web/src/features/billing/messages.ts', (s) => `export const m = { note: '${s}' };\n`],
  ['apps/web/src/app/(staff)/frontdesk/page.tsx', (s) => `export default () => <p>${s}</p>;\n`],
  ['services/renderer/templates/billing/invoice.html', (s) => `<footer>${s}</footer>\n`],
  ['docs/manual/frontdesk/registration.md', (s) => `# Registration\n\n${s}\n`],
  ['docs/manual/billing/invoice.md', (s) => `# Invoice\n\n${s}\n`],
];
for (const [path, wrap] of ROOT_FILES) {
  for (const phrase of PHRASES) {
    test(`fails on "${phrase}" in ${path}`, () => {
      const r = expectFail({ [path]: wrap(`Our software is ${phrase} for you.`) }, `${phrase} in ${path}`);
      assert.ok(r.stderr.includes(path.split('/').pop()), `stderr must name the offending file: ${r.stderr}`);
    });
  }
}
test('hit report carries file:line', () => {
  const r = expectFail({ 'docs/manual/billing/x.md': '# T\n\nok line\nIRD approved here\n' }, 'line number');
  assert.match(r.stderr, /x\.md:4/);
});

// ---------- case-insensitive / variants ----------
for (const s of ['ird APPROVED', 'Ird-Approved', 'IRD CERTIFIED', 'APPROVED BY ird', 'Commission', 'COMMISSION', 'commissions', 'Referral commission report', 'sales-commission']) {
  test(`case-insensitive: "${s}"`, () => { expectFail({ 'docs/manual/billing/c.md': `text ${s} text\n` }, s); });
}

// ---------- bypass attempts (must NOT slip through) ----------
test('bypass: phrase wrapped across a line break (markdown hard-wrap)', () => {
  expectFail({ 'docs/manual/billing/w.md': 'This lab software is IRD\napproved for billing.\n' }, '"IRD\\napproved"');
  expectFail({ 'docs/manual/frontdesk/w.md': 'The build is approved by\nIRD today.\n' }, '"approved by\\nIRD"');
  expectFail({ 'docs/manual/billing/w2.md': 'It is IRD\r\ncertified.\r\n' }, 'CRLF wrap "IRD certified"');
});
test('bypass: wrapped phrase with indentation / list continuation', () => {
  expectFail({ 'docs/manual/billing/w3.md': '- Status: IRD\n  approved\n' }, 'indented continuation');
});
test('bypass: multiple spaces, tab or non-breaking space inside the phrase', () => {
  expectFail({ 'docs/manual/billing/s1.md': 'It is IRD  approved.\n' }, 'two spaces');
  expectFail({ 'docs/manual/billing/s2.md': 'It is IRD\tcertified.\n' }, 'tab');
  expectFail({ 'apps/web/src/features/billing/components/N.tsx': 'export const N = () => <p>IRD approved</p>;\n' }, 'nbsp');
});
test('bypass: phrase inside JSX across lines', () => {
  expectFail({ 'apps/web/src/features/frontdesk/components/J.tsx': 'export const J = () => (\n  <p>\n    approved by\n    IRD\n  </p>\n);\n' }, 'JSX wrap');
});

// ---------- allowed copy (no false positives) ----------
test('allowed: spec-sanctioned CBMS stub copy and "referral" wording', () => {
  expectPass({
    'apps/web/src/features/billing/components/Cbms.tsx': "export const C = () => <p>Not sent — CBMS connection not configured</p>;\n",
    'docs/manual/billing/referral.md': '# Referral\n\nReferrer is captured on the order. Referral incentive report is available to the owner.\n',
    'docs/manual/frontdesk/ird.md': '# IRD\n\nIRD invoice numbering follows the fiscal year. Approval of discounts needs a manager.\n',
  }, 'sanctioned wording');
});
test('allowed: banned words inside __tests__ and node_modules are ignored (tests must be able to quote them)', () => {
  expectPass({
    'apps/web/src/features/billing/__tests__/q.test.ts': "expect(t).not.toMatch(/IRD approved|commission/i);\n",
    'apps/web/src/features/frontdesk/node_modules/x/index.js': '// commission\n',
  }, '__tests__ / node_modules');
});
test('allowed: banned words outside the C4 scan roots are not C4 business', () => {
  expectPass({
    'apps/web/src/features/instruments/a.tsx': 'export const I = () => <p>commissioning checklist</p>;\n',
    'docs/manual/analytics/a.md': 'no commission payouts\n',
  }, 'other chunks');
});

// ---------- cannot pass vacuously ----------
test('empty scan set (no billing page / component) fails', () => {
  const r = run(repo({ 'docs/manual/billing/a.md': '# ok\n' }, { seed: false }));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /empty scan set/);
});
test('missing scan roots do not crash into a false pass', () => {
  const r = run(repo({}, { seed: false })); assert.notEqual(r.status, 0);
});
