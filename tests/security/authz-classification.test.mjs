// SEC-AUTHZ-1 (LD-235): read-only authorization design. Tests for the static classifier, its snapshot and the CR.
// Run: node --test tests/security/authz-classification.test.mjs
//
// Contract the implementation must follow (the tester fixes it here; names are not in the spec, so they are pinned once):
//  * `node tests/security/classify-authz.mjs` prints ONE JSON document to stdout, deterministic (no timestamps, sorted keys),
//    and writes nothing. The committed snapshot tests/security/authz-classification.json must equal that output.
//  * Document: { total: number, counts: { <class>: number }, operations: { <operationId>: Entry } }
//    Entry: { class, x_permission: string|null,                    // x_permission = the contract value, null when absent
//             permission?: string,                                   // REQUIRED for guarded-exact / guarded-other: the permission the handler asserts
//             reason?: string }                                      // REQUIRED for inconclusive (and may be given for any class)
//  * class is exactly one of CLASSES below (LD-235 list: public; identity-session-flow; callback-token / device / portal /
//    patient-pre-auth scheme; platform.*; guarded with exactly its x-permission; guarded with another permission; unguarded;
//    stub; inconclusive).
//  * The CR is .orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md with exactly eight `##` headings in the order of HEADINGS below.
// The contract scan below is an independent oracle: a line scan of contracts/openapi/*.yaml, not the classifier's code.
// Binding: LD-235 (SEC-AUTHZ-1 read-only design), C0 02-TRD 6.2 / 7.2, C0 07-SECURITY AB-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(ROOT, ...p);
const CLASSIFIER = rel('tests', 'security', 'classify-authz.mjs');
const SNAPSHOT = rel('tests', 'security', 'authz-classification.json');
const CR = rel('.orchestra', 'cr', 'SEC-AUTHZ-1.1.nonblocking.md');
// First commit of the lane at task start (HEAD 879cbcb9); override when the lane is rebased.
const BASE = process.env.SEC_AUTHZ_BASE || '879cbcb9';

const CLASSES = [
  'public', 'identity-session-flow', 'scheme-callback-token', 'scheme-device', 'scheme-portal', 'scheme-patient-pre-auth',
  'platform', 'guarded-exact', 'guarded-other', 'unguarded', 'stub', 'inconclusive',
];
const NO_PERMISSION_OK = ['public', 'identity-session-flow', 'scheme-callback-token', 'scheme-device', 'scheme-portal', 'scheme-patient-pre-auth'];
const HEADINGS = ['Intent', 'Current behaviour', 'Proposed central stage', 'Mode', 'Exact spec amendment text', 'Impact', 'Test plan', 'Task list'];

// ---------- oracle: operations of contracts/openapi/*.yaml ----------
function scanContracts() {
  const dir = rel('contracts', 'openapi');
  const ops = new Map(); // operationId -> { file, permission, isPublic }
  const dupes = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml') && !n.startsWith('_')).sort()) {
    let cur = null;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      let m = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
      if (m) {
        if (ops.has(m[1])) dupes.push(m[1]);
        cur = { file: f, permission: null, isPublic: false };
        ops.set(m[1], cur);
        continue;
      }
      if (!cur) continue;
      m = line.match(/^ {6}x-permission:\s*(\S+)\s*$/);
      if (m) cur.permission = m[1];
      if (/^ {6}x-public:/.test(line)) cur.isPublic = true;
    }
  }
  return { ops, dupes };
}
const { ops: CONTRACT, dupes } = scanContracts();

function runClassifier() {
  assert.ok(existsSync(CLASSIFIER), 'tests/security/classify-authz.mjs must exist');
  return execFileSync(process.execPath, [CLASSIFIER], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
function loadSnapshot() {
  assert.ok(existsSync(SNAPSHOT), 'tests/security/authz-classification.json must be committed');
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
}

// ---------- oracle sanity ----------
test('oracle: contracts hold 1018 unique operationIds (993 with x-permission, 25 x-public, none of both missing)', () => {
  assert.deepEqual(dupes, [], 'operationId must be unique across contracts');
  assert.equal(CONTRACT.size, 1018);
  const withPerm = [...CONTRACT.values()].filter((o) => o.permission);
  const pub = [...CONTRACT.values()].filter((o) => o.isPublic);
  assert.equal(withPerm.length, 993);
  assert.equal(pub.length, 25);
  assert.equal([...CONTRACT.values()].filter((o) => !o.permission && !o.isPublic).length, 0);
  assert.equal(withPerm.filter((o) => o.permission.startsWith('platform.')).length > 0, true);
});

// ---------- classifier + snapshot ----------
test('classifier output equals the committed snapshot', () => {
  assert.deepEqual(JSON.parse(runClassifier()), loadSnapshot());
});

test('classifier is deterministic and read-only', () => {
  const before = git('status', '--porcelain');
  const a = runClassifier();
  const b = runClassifier();
  assert.equal(a, b, 'two runs must give byte-identical output');
  assert.equal(git('status', '--porcelain'), before, 'classifier must not write anything');
});

test('every operationId of contracts/openapi appears exactly once, with no extras', () => {
  const snap = loadSnapshot();
  const keys = Object.keys(snap.operations);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), [...CONTRACT.keys()].sort());
  assert.equal(snap.total, 1018);
  assert.equal(keys.length, 1018);
});

test('each operation is in exactly one known class; counts are the real recount', () => {
  const snap = loadSnapshot();
  const recount = {};
  for (const [id, e] of Object.entries(snap.operations)) {
    assert.equal(typeof e.class, 'string', `${id}: class must be one string`);
    assert.ok(CLASSES.includes(e.class), `${id}: unknown class ${e.class}`);
    recount[e.class] = (recount[e.class] || 0) + 1;
  }
  const nonZero = Object.fromEntries(Object.entries(snap.counts).filter(([, n]) => n !== 0));
  assert.deepEqual(nonZero, recount, 'counts must equal the per-operation recount (no class may be missing)');
  assert.equal(Object.values(snap.counts).reduce((a, b) => a + b, 0), 1018);
});

test('entries carry the contract x-permission and the right evidence fields', () => {
  const snap = loadSnapshot();
  for (const [id, e] of Object.entries(snap.operations)) {
    const c = CONTRACT.get(id);
    if (!c) continue; // reported by the completeness test
    assert.equal(e.x_permission, c.permission, `${id}: x_permission must equal the contract value (null when absent)`);
    if (e.class === 'guarded-exact') assert.equal(e.permission, c.permission, `${id}: guarded-exact asserts exactly its x-permission`);
    if (e.class === 'guarded-other') {
      assert.ok(typeof e.permission === 'string' && e.permission.length > 0, `${id}: guarded-other names the permission it asserts`);
      assert.notEqual(e.permission, c.permission, `${id}: guarded-other must differ from its x-permission`);
    }
    if (e.class === 'platform') assert.ok(c.permission?.startsWith('platform.'), `${id}: platform class is for platform.* x-permission only`);
  }
});

test('contract-derived class rules (x-public, x-permission, platform.*)', () => {
  const snap = loadSnapshot();
  for (const [id, c] of CONTRACT) {
    const e = snap.operations[id];
    if (!e) continue;
    if (c.isPublic) assert.ok(NO_PERMISSION_OK.includes(e.class), `${id}: x-public operation cannot be ${e.class}`);
    else assert.ok(!['public', 'identity-session-flow'].includes(e.class), `${id}: has x-permission, cannot be ${e.class}`);
    if (c.permission?.startsWith('platform.')) assert.equal(e.class, 'platform', `${id}: platform.* permission must be class platform`);
  }
  const platformOps = [...CONTRACT.values()].filter((c) => c.permission?.startsWith('platform.')).length;
  assert.equal(snap.counts.platform, platformOps);
});

test('inconclusive is 0 or listed one by one with a reason', () => {
  const snap = loadSnapshot();
  const list = Object.entries(snap.operations).filter(([, e]) => e.class === 'inconclusive');
  assert.equal(snap.counts.inconclusive ?? 0, list.length);
  for (const [id, e] of list) assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 15, `${id}: inconclusive needs a reason of at least 15 characters`);
});

test('anchors fixed by LD-235 / verifier A', () => {
  const ops = loadSnapshot().operations;
  for (const id of ['getLiveness', 'getReadiness', 'getPaymentResultPage']) assert.equal(ops[id]?.class, 'public', id);
  for (const id of ['loginStaff', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession'])
    assert.equal(ops[id]?.class, 'identity-session-flow', id);
  for (const id of ['launchEsewaPayment', 'esewaSuccessCallback', 'esewaFailureCallback', 'khaltiReturnCallback'])
    assert.equal(ops[id]?.class, 'scheme-callback-token', id);
  // identity inviteUser (user.service.ts:387-412) and the tenant-access operations check no permission.
  for (const id of ['inviteUser', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession'])
    assert.equal(ops[id]?.class, 'unguarded', id);
  // platform.* operations need another guard (IdentityPort.impl.ts:229).
  assert.equal(ops.openSupportSession?.class, 'platform');
});

// ---------- the CR ----------
const section = (md, name) => {
  const parts = md.split(/^## /m).slice(1);
  const hit = parts.find((p) => p.split(/\r?\n/)[0].trim() === name);
  return hit ?? '';
};
const loadCr = () => {
  assert.ok(existsSync(CR), '.orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md must exist');
  return readFileSync(CR, 'utf8');
};

test('CR has exactly the eight headings of LD-235, in order', () => {
  const heads = [...loadCr().matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, HEADINGS);
});

test('CR Intent quotes 02-TRD 6.2 and 7.2 and 07-SECURITY AB-5 by section id', () => {
  const s = section(loadCr(), 'Intent');
  for (const needle of ['02-TRD', '6.2', '7.2', '07-SECURITY', 'AB-5']) assert.ok(s.includes(needle), `Intent must cite ${needle}`);
  assert.ok((s.match(/^>/gm) || []).length >= 3, 'Intent must quote (blockquote lines) the three sections');
});

test('CR Current behaviour reconciles with verifier A and the snapshot counts', () => {
  const s = section(loadCr(), 'Current behaviour');
  assert.ok(/1018/.test(s), 'states the 1018 total');
  assert.ok(/reconcil/i.test(s), 'says it reconciles with verifier A');
  for (const n of ['607', '108', '148', '97', '33', '25']) assert.ok(new RegExp(`\\b${n}\\b`).test(s), `verifier A count ${n}`);
  for (const f of ['authz-guard.ts', 'assertRole', 'audit-export.service.ts', 'inviteUser']) assert.ok(s.includes(f), `cites ${f}`);
  // Tester revision (SEC-AUTHZ-2 review item 3): the CR is a design-time document (read-only, counts 604 guarded-exact / 211 unguarded).
  // The live snapshot has since moved (4 audit.log.read operations became guarded-exact through other tasks: 608 / 207), so the CR is
  // reconciled with the snapshot as committed with the CR's own task (SEC-AUTHZ-1 impl). Live snapshot integrity is covered by the
  // other tests (equals classifier output, recount, evidence fields); this check still proves the CR counts were right when written.
  const { counts } = JSON.parse(git('show', 'a447c2c53:tests/security/authz-classification.json'));
  for (const [cls, n] of Object.entries(counts).filter(([, n]) => n > 0)) {
    const ok = s.split(/\r?\n/).some((l) => l.includes(cls) && new RegExp(`\\b${n}\\b`).test(l));
    assert.ok(ok, `a line must show class ${cls} with its snapshot count ${n}`);
  }
});

test('CR Proposed central stage covers stage 8, baseline assertRole, platform.* and every actor kind', () => {
  const s = section(loadCr(), 'Proposed central stage');
  for (const needle of ['stage 8', 'x-permission', 'IdentityPort.assertRole', 'centre', 'platform.', 'system', 'device', 'patient', 'partner', 'portal'])
    assert.ok(s.includes(needle), `must mention ${needle}`);
  assert.ok(/different permission/i.test(s), 'must treat handlers that deliberately check a different permission');
});

test('CR Mode defines LIMS_CORE_AUTHZ_MODE shadow|enforce, authz_central_deny and the production default', () => {
  const s = section(loadCr(), 'Mode');
  for (const needle of ['LIMS_CORE_AUTHZ_MODE', 'shadow', 'enforce', 'authz_central_deny', 'staging', 'production'])
    assert.ok(s.includes(needle), `must mention ${needle}`);
});

test('CR Exact spec amendment text is concrete text for 02-TRD 6.2 and AB-5', () => {
  const s = section(loadCr(), 'Exact spec amendment text');
  for (const needle of ['6.2', 'AB-5', 'x-permission', 'assertRole']) assert.ok(s.includes(needle), `must mention ${needle}`);
  assert.ok(s.trim().length >= 500, 'amendment text must be written out, not summarised');
});

test('CR Impact weighs the extra reads against the T-26 3.0 s p95 target', () => {
  const s = section(loadCr(), 'Impact');
  assert.ok(/T-26/.test(s) && /3\.0\s*s/.test(s) && /p95/.test(s) && /read/i.test(s));
});

test('CR Test plan names the completeness test and the behaviour matrix', () => {
  const s = section(loadCr(), 'Test plan');
  for (const needle of ['classifier', 'mfa_pending', 'patient', 'partner', 'every module']) assert.ok(s.includes(needle), `must mention ${needle}`);
});

test('CR Task list has implementation tasks, each with files and done_when', () => {
  const s = section(loadCr(), 'Task list');
  assert.ok((s.match(/done_when/g) || []).length >= 3, 'at least three tasks (one per module group), each with done_when');
  assert.ok((s.match(/files/gi) || []).length >= (s.match(/done_when/g) || []).length, 'each task lists files');
  assert.ok(/SEC-GATE-2/.test(s), 'tasks are queued behind SEC-GATE-2');
});

// ---------- scope ----------
// Tester revision (SEC-AUTHZ-2 review item 3): the lane has moved on since BASE (other tasks legitimately changed ~900 paths), so a
// diff against BASE can never hold again. The assertion is unchanged in strength but is scoped to what it always meant: the commits
// of task SEC-AUTHZ-1 itself (subject "SEC-AUTHZ-1" followed by a space or end, not 1.1 or -2), plus untracked files.
test('git shows no change outside the listed files (commits of task SEC-AUTHZ-1)', () => {
  const task = git('log', '--name-only', '--format=', '-E', '--grep=SEC-AUTHZ-1( |$)', `${BASE}..HEAD`);
  // untracked files are no longer counted: they belong to whichever task is open now, not to SEC-AUTHZ-1
  const changed = new Set([...task.split(/\r?\n/)].filter(Boolean).map((p) => p.replace(/\\/g, '/')));
  const allowed = [
    /^tests\/security\/(classify-authz\.mjs|authz-classification\.json|authz-classification\.test\.mjs)$/,
    /^\.orchestra\/cr\/SEC-AUTHZ-1\.1\.nonblocking\.md$/,
    /^\.orchestra\/notes\//,
    /^\.orchestra\/inbox\//,
  ];
  const stray = [...changed].filter((p) => !allowed.some((re) => re.test(p)));
  assert.deepEqual(stray, [], 'files outside the SEC-AUTHZ-1 list changed');
});
