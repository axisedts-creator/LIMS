// T0B-GOLIVE-1 doc structure test (LD-322, LD-310; offline design C:/LIMS-state/offline-design-20261117.md).
// Proves: the three runbook documents exist, every required section heading is present (done_when 1-7),
// key content items are named, and no secret-like value or real address appears (done_when 8).
// ASSUMED format (dispute if wrong): a required section is a markdown heading (## or ###) whose text matches the regex below.
// Run: node --test tests/docs/T0B-GOLIVE-1.runbook.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// done_when item -> document -> heading regex. Content regexes must match somewhere in the document body.
const DOCS = {
  'docs/ops/GO-LIVE-OWN-SERVER.md': {
    headings: [
      ['(1) topology', /topology/i],
      ['(2) power is not availability', /power is not availability/i],
      ['(4) monitoring', /monitoring/i],
      ['(6) offline link and outage drill', /offline link/i],
      ['(6) outage drill', /outage drill/i],
      ['(7) founder decisions', /founder decisions/i],
      ['unknowns stated plainly', /unknown|not yet known|open questions/i],
    ],
    content: [
      ['reverse proxy', /reverse proxy/i], ['TLS', /\bTLS\b/], ['VPN or private tunnel', /\bVPN\b|private tunnel/i],
      ['no open management ports', /management port/i], ['lab PC needs', /lab PC/i],
      ['RAID or mirrored disks', /\bRAID\b|mirror/i], ['UPS', /\bUPS\b/], ['automatic restart after power return', /restart[^.\n]*power|power[^.\n]*restart/i],
      ['ISP or router redundancy', /\bISP\b[^.\n]*|redundan/i], ['off site copy', /off[- ]?site/i], ['remote hands', /remote hands/i],
      ['maintenance window', /maintenance window/i], ['patching', /patch/i],
      ['alert: disk', /\bdisk\b/i], ['alert: memory', /\bmemory\b/i], ['alert: database health', /database health/i],
      ['alert: API health', /API health/i], ['alert: certificate expiry', /certificate expiry/i], ['alert: backup age', /backup age/i],
      ['alert: sync backlog age', /sync backlog/i], ['alert: conflict inbox size', /conflict inbox/i],
      ['who is called and how', /who is called|on[- ]call/i], ['status page or outside check', /status page|outside the office|external check/i],
      ['offline layer tasks', /T0B-SYNC-1/], ['offline layer tasks', /T0B-SYNC-5/], ['what staff do during outage', /what staff do/i],
      ['continuous power is not continuous availability', /continuous power/i],
    ],
    // each founder decision named in done_when (7), each with options and a recommended default
    founder: [
      ['hardware spend', /hardware/i], ['ISP spend', /\bISP\b/], ['provider choices', /provider/i],
      ['backup location and provider', /backup location/i], ['who holds the credentials', /credentials/i],
      ['legal review of patient data hosting in Nepal', /Nepal/], ['retention rules', /retention/i],
      ['which devices may work offline', /devices?[^.\n]*offline/i],
      ['accountant confirms provisional numbers', /accountant/i],
    ],
  },
  'docs/ops/BACKUP-RESTORE.md': {
    headings: [
      ['(3) backups', /backups?/i],
      ['(3) restore drill', /restore drill/i],
      ['(3) retention schedule', /retention/i],
      ['recovery time and data loss limits', /recovery time|\bRTO\b/i],
    ],
    content: [
      ['nightly full backup', /nightly/i], ['continuous log archive (WAL)', /\bWAL\b|log archive/i],
      ['object storage replication', /object storage[^.\n]*replicat|replicat[^.\n]*object storage/i],
      ['encrypted off site copy', /encrypt/i], ['second location and provider', /second (location|provider)/i],
      ['RTO', /\bRTO\b/], ['RPO / data loss limit', /\bRPO\b|data loss/i],
      ['drill before go live and every quarter', /every quarter|quarterly/i], ['before go live', /before go[- ]live/i],
      ['untested restore counts as no backup', /never (been )?tested[^.\n]*no backup|no backup[^.\n]*never (been )?tested|counts as no backup/i],
      ['written numbered steps', /^\s*1\.\s+\S/m],
    ],
  },
  'docs/ops/CUTOVER-ROLLBACK.md': {
    headings: [
      ['(5) cutover', /cutover/i],
      ['(5) freeze window', /freeze window/i],
      ['(5) smoke test', /smoke test/i],
      ['(5) rollback', /rollback/i],
    ],
    content: [
      ['Supabase test project', /Supabase/], ['database dump and restore', /dump/i], ['storage objects through the S3 adapter', /S3 adapter|S3/],
      ['secrets handover without values', /secrets/i], ['DNS', /\bDNS\b/], ['cloud copy stays the fallback', /fallback/i],
      ['rollback to the cloud copy', /cloud (copy|API)/i], ['offline devices push after cutover', /sync|offline/i],
      ['provisional numbers mapped to final', /provisional/i], ['written numbered steps', /^\s*1\.\s+\S/m],
    ],
  },
};

// done_when (8): no secrets, tokens or real addresses. Documentation placeholders are allowed:
// example.com/.org/.net, *.invalid, *.test, *.example, localhost, RFC 5737 (192.0.2/24, 198.51.100/24, 203.0.113/24), RFC 1918 private ranges.
const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['provider secret key (sk_/pk_/rk_ live or test)', /\b[spr]k_(live|test)_[A-Za-z0-9]{8,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['bearer token value', /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i],
  ['URL with embedded password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@<>]{3,}@/i],
  ['assigned secret value', /\b(password|passwd|secret|api[_-]?key|access[_-]?key|token|service[_-]?role[_-]?key)\b\s*[:=]\s*["']?(?!<|\$|\{|your|changeme|xxx|\.\.\.|example|placeholder|none|unset|never|stored|held|kept|not\b)[A-Za-z0-9+\/_-]{12,}/i],
  ['long hex string (32+)', /\b[0-9a-f]{32,}\b/i],
  ['long base64-like string (40+)', /(?<![A-Za-z0-9\/+])[A-Za-z0-9+\/]{40,}={0,2}(?![A-Za-z0-9\/+])/],
];
const isDocIp = (ip) => {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a === 0;
};
const isDocHost = (h) => /(^|\.)(example\.(com|org|net)|invalid|test|example|localhost|local|internal|lan)$/i.test(h);

const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
const norm = (s) => s.replace(/[`*_]/g, (m) => (m === '_' ? '_' : '')).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const headingsOf = (text) => text.split(/\r?\n/).filter((l) => /^#{1,4}\s+\S/.test(l)).map((l) => l.replace(/^#+\s+/, ''));

describe('T0B-GOLIVE-1 runbook documents', () => {
  for (const [rel, spec] of Object.entries(DOCS)) {
    describe(rel, () => {
      const raw = read(rel);
      const text = raw === null ? '' : norm(raw);
      const heads = headingsOf(text);

      test('document exists and is not a stub', () => {
        assert.notEqual(raw, null, `${rel} is missing`);
        assert.ok(text.split(/\s+/).length >= 250, `${rel} has fewer than 250 words; a runbook is expected`);
      });
      for (const [label, re] of spec.headings) {
        test(`heading present: ${label}`, () => {
          assert.ok(heads.some((h) => re.test(h)), `${rel}: no heading matches ${re} (headings: ${heads.join(' | ') || 'none'})`);
        });
      }
      for (const [label, re] of spec.content) {
        test(`names: ${label}`, () => assert.match(text, re, `${rel}: nothing matches ${re}`));
      }
      if (spec.founder) {
        // each decision lives inside the FOUNDER DECISIONS section, with options and a recommended default
        const i = heads.findIndex((h) => /founder decisions/i.test(h));
        const start = text.search(/^#{1,4}\s+.*founder decisions.*$/im);
        const rest = start >= 0 ? text.slice(start).split(/\r?\n/).slice(1) : [];
        const endRel = rest.findIndex((l) => /^#{1,2}\s+\S/.test(l));
        const section = (endRel >= 0 ? rest.slice(0, endRel) : rest).join('\n');
        test('founder decisions section found', () => assert.ok(i >= 0 && section.length > 200, `${rel}: FOUNDER DECISIONS section missing or empty`));
        for (const [label, re] of spec.founder) {
          test(`founder decision: ${label}`, () => assert.match(section, re, `${rel}: founder section lacks ${label}`));
        }
        test('founder section gives options and a recommended default', () => {
          assert.match(section, /options?/i, 'no "options"');
          assert.match(section, /recommended default|recommended:|default:/i, 'no recommended default');
          assert.match(section, /lead does not (decide|spend)|stays? with the founder|founder decides/i, 'does not say the decisions stay with the founder');
        });
      }
    });
  }
});

describe('T0B-GOLIVE-1 no secrets and no real addresses (done_when 8)', () => {
  for (const rel of Object.keys(DOCS)) {
    const raw = read(rel);
    test(`${rel}: no secret-like pattern`, () => {
      assert.notEqual(raw, null, `${rel} is missing`);
      for (const [label, re] of SECRET_PATTERNS) {
        const m = re.exec(raw);
        assert.equal(m, null, `${rel}: ${label} pattern found: "${m && m[0].slice(0, 12)}..."`);
      }
    });
    test(`${rel}: only placeholder addresses`, () => {
      assert.notEqual(raw, null, `${rel} is missing`);
      for (const ip of raw.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
        if (ip.split('.').every((n) => Number(n) <= 255)) assert.ok(isDocIp(ip), `${rel}: real-looking IP ${ip}; use 192.0.2.x, 198.51.100.x, 203.0.113.x or a private range`);
      }
      for (const [, host] of raw.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) assert.ok(isDocHost(host), `${rel}: real-looking host ${host}; use example.com / .invalid`);
      for (const [mail] of raw.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
        assert.ok(isDocHost(mail.split('@')[1]), `${rel}: real-looking email ${mail}; use name@example.com`);
      }
      assert.doesNotMatch(raw, /(?<!\d)(\+?977[- ]?)?9[78]\d{8}(?!\d)/, `${rel}: phone-number-like value; use no real numbers`);
    });
  }
  test('scanner self-check: catches planted secrets and accepts placeholders', () => {
    const planted = ['password: Zx9fK2mQ7vLp4RtW', 'postgres://admin:hunter2pw@db.example.com/x', 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN PRIVATE KEY-----', 'Bearer abcdefghijklmnopqrstuvwx'];
    for (const s of planted) assert.ok(SECRET_PATTERNS.some(([, re]) => re.test(s)), `scanner missed: ${s}`);
    for (const s of ['password: <set at install, never written here>', 'DATABASE_URL=postgres://user@example.com/db', 'token: stored in the password manager']) {
      assert.ok(!SECRET_PATTERNS.some(([, re]) => re.test(s)), `scanner false positive: ${s}`);
    }
    assert.ok(isDocIp('203.0.113.10') && isDocIp('10.1.2.3') && !isDocIp('8.8.8.8'));
  });
});
