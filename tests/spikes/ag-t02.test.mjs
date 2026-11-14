// AG-T02 tests: spike findings doc docs/manual/instruments/spikes.md.
// Run: node --test tests/spikes/ag-t02.test.mjs
// Spec: 02-TRD §2.1/§5.6/§5.12 (UNVERIFIED items), 06-PLAN row AG-T02 + risk R4, 07-SECURITY REQ-SEC-116/117/118/119.
// Doc contract: one `##` section per spike (S1 account+COM+DPAPI, S2 control codes, S3 WinVerifyTrustEx)
// plus a `## Decisions` section. Each spike has one line (table row or bullet) per OS naming the OS and a
// verdict PASS|FAIL|PARTIAL. Decisions lines start with `DECISION:`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'manual', 'instruments', 'spikes.md');
const text = () => readFileSync(DOC, 'utf8');

const OSES = [
  ['Windows 10', /(Windows 10|Win10|Win 10)\b/i],
  ['Windows 11', /(Windows 11|Win11|Win 11)\b/i],
];
const VERDICT = /\b(PASS|FAIL|PARTIAL)\b/;
// LD-93/LD-94 (A36-4): Windows 10 is NOT RUN, a pre-pilot release gate; Server 2016 removed from v1.
const NOT_RUN_GATE = (l) => /\bNOT RUN\b/.test(l) && /release gate/i.test(l);
const osOk = (name, l) => (name === 'Windows 10' ? VERDICT.test(l) || NOT_RUN_GATE(l) : VERDICT.test(l));

function sections() {
  const out = {};
  let cur = null;
  for (const line of text().split(/\r?\n/)) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) { cur = m[1].trim(); out[cur] = []; } else if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
}
const find = (re) => {
  const hit = Object.entries(sections()).find(([k]) => re.test(k));
  assert.ok(hit, `no "## ..." section heading matching ${re}`);
  return hit[1];
};
const S1 = () => find(/virtual account|LimsBridgeAgent/i);
const S2 = () => find(/control code/i);
const S3 = () => find(/WinVerifyTrust/i);
const DEC = () => find(/^decisions?$/i);

function perOs(body, label) {
  for (const [name, re] of OSES) {
    const line = body.split('\n').find((l) => re.test(l) && osOk(name, l));
    assert.ok(line, `${label}: no line naming ${name} with a PASS|FAIL|PARTIAL verdict${name === 'Windows 10' ? ' (or NOT RUN + release gate)' : ''}`);
  }
}

describe('doc exists and is well-formed', () => {
  test('docs/manual/instruments/spikes.md exists and is non-trivial', () => {
    assert.ok(existsSync(DOC), 'docs/manual/instruments/spikes.md missing');
    assert.ok(text().length > 1500, 'spikes.md too short to hold three spikes x two OSes');
  });
  test('names AG-T02 and the two target OS versions', () => {
    const t = text();
    assert.match(t, /AG-T02/);
    for (const [name, re] of OSES) assert.match(t, re, `doc never mentions ${name}`);
  });
  test('no unfinished markers (TODO/TBD/UNVERIFIED/FIXME/XXX)', () => {
    assert.doesNotMatch(text(), /\b(TODO|TBD|UNVERIFIED|FIXME|XXX)\b/);
  });
  test('no NUL bytes', () => {
    assert.ok(!text().includes('\0'));
  });
});

describe('S1: virtual account NT SERVICE\\LimsBridgeAgent (TRD §5.12, R4)', () => {
  test('has a verdict per OS', () => perOs(S1(), 'S1'));
  test('covers serial (COM) port access', () => {
    assert.match(S1(), /\bCOM\d*\b|serial/i);
  });
  test('covers DPAPI user-scope CryptProtectData/CryptUnprotectData', () => {
    const s = S1();
    assert.match(s, /CryptProtectData/);
    assert.match(s, /CryptUnprotectData/);
    assert.match(s, /user[- ]scope/i);
  });
  test('covers machine-scope fallback flag CRYPTPROTECT_LOCAL_MACHINE', () => {
    assert.match(S1(), /CRYPTPROTECT_LOCAL_MACHINE/);
  });
  test('covers data-root write via service SID (REQ-SEC-116)', () => {
    assert.match(S1(), /ProgramData\\LIMS\\BridgeAgent|data root/i);
  });
});

describe('S2: custom service control codes 128-255 (TRD §5.12)', () => {
  test('has a verdict per OS', () => perOs(S2(), 'S2'));
  test('tests code 128 (heartbeat now) and 129 (flush uploads now)', () => {
    const s = S2();
    assert.match(s, /\b128\b/);
    assert.match(s, /\b129\b/);
  });
  test('names the x/sys/windows/svc delivery path', () => {
    assert.match(S2(), /x\/sys\/windows\/svc|windows\/svc|ControlService/);
  });
  test('names the request.json fallback (status\\request.json, 5 s poll)', () => {
    const s = S2();
    assert.match(s, /request\.json/);
    assert.match(s, /\b5\s?s\b|5 seconds/i);
  });
});

describe('S3: WinVerifyTrustEx on a test-signed exe (REQ-SEC-119)', () => {
  test('has a verdict per OS', () => perOs(S3(), 'S3'));
  test('uses a test-signed executable and names WinVerifyTrustEx', () => {
    const s = S3();
    assert.match(s, /WinVerifyTrustEx/);
    assert.match(s, /test[- ]sign|self[- ]signed|test certificate/i);
  });
  test('negative cases recorded: unsigned, tampered after signing, untrusted root', () => {
    const s = S3();
    assert.match(s, /unsigned/i);
    assert.match(s, /tamper|modified after sign|bad digest/i);
    assert.match(s, /untrusted|not trusted|root/i);
  });
  test('publisher check recorded (subject/thumbprint comparison)', () => {
    assert.match(S3(), /publisher|subject|thumbprint/i);
  });
});

describe('Decisions: fallbacks chosen (done_when)', () => {
  const lines = () => DEC().split('\n').filter((l) => /DECISION:/.test(l));
  test('has at least 3 DECISION: lines', () => assert.ok(lines().length >= 3));
  test('account decision: virtual account OR LocalService', () => {
    assert.ok(lines().some((l) => /account/i.test(l) && /(NT SERVICE\\LimsBridgeAgent|virtual account|LocalService)/i.test(l)));
  });
  test('DPAPI decision: user scope OR machine scope (+ file ACL)', () => {
    assert.ok(lines().some((l) => /DPAPI/i.test(l) && /(user[- ]scope|machine[- ]scope|CRYPTPROTECT_LOCAL_MACHINE)/i.test(l)));
  });
  test('control decision: control codes OR request.json', () => {
    assert.ok(lines().some((l) => /control/i.test(l) && /(control codes?|request\.json)/i.test(l)));
  });
  test('each decision cites the spike (S1/S2/S3) it rests on', () => {
    for (const l of lines()) assert.match(l, /\bS[123]\b/, `decision lacks spike reference: ${l}`);
  });
  test('names the TRD §5.12 / install --account localservice impact', () => {
    assert.match(DEC(), /5\.12|--account localservice|install/i);
  });
});

describe('hygiene (synthetic data, no secrets)', () => {
  test('no private key material or PFX passwords', () => {
    const t = text();
    assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(t, /(password|pfx|passphrase)\s*[:=]\s*\S+/i);
  });
  test('no long base64 blobs (tokens/keys)', () => {
    assert.doesNotMatch(text(), /[A-Za-z0-9+/]{80,}={0,2}/);
  });
});
