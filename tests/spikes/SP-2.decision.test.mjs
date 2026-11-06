// SP-2 decision record check (Graphile Worker 0.18.0 least-privilege + add_job mapping; 04 D6; 08 A25 D-201; 07-SECURITY §6).
// Run: node --test tests/spikes/SP-2.decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../db/meta/decisions/SP-2.md', import.meta.url));
const decisions = fileURLToPath(new URL('../../services/worker/src/core/DECISIONS.md', import.meta.url));
const rec = () => {
  assert.ok(existsSync(path), 'db/meta/decisions/SP-2.md must exist');
  return readFileSync(path, 'utf8');
};
const outcome = (t) => (t.match(/outcome[^\n]*?\b(pass|partial|fail)\b/i) || [])[1]?.toLowerCase();

test('record exists and states outcome pass|partial|fail', () => {
  assert.ok(outcome(rec()), 'need "Outcome: pass|partial|fail"');
});

test('evidence: version 0.18.0, commands and outputs in code blocks', () => {
  const t = rec();
  assert.match(t, /evidence/i);
  assert.match(t, /0\.18\.0/);
  assert.match(t, /```/, 'commands/outputs in code blocks');
});

test('exact schema-install command run as lims_migrator with role lims_queue inside D-201 window', () => {
  const t = rec();
  assert.match(t, /graphile[-_ ]worker/i);
  assert.match(t, /--schema-only|schema[- ]only|migrate/i, 'install command recorded');
  assert.match(t, /lims_migrator/);
  assert.match(t, /lims_queue/);
  assert.match(t, /PGOPTIONS|SET (LOCAL )?ROLE|role=lims_queue/, 'how session role lims_queue is set');
  assert.match(t, /D-201/);
});

test('queue_depth: graphile_worker.jobs columns confirmed', () => {
  const t = rec();
  for (const c of ['task_identifier', 'run_at', 'locked_at', 'attempts', 'max_attempts']) {
    assert.match(t, new RegExp(`\\b${c}\\b`), `column ${c}`);
  }
  assert.match(t, /graphile_worker\.jobs/);
});

test('worker runs as lims_worker with no DDL at startup when schema current', () => {
  const t = rec();
  assert.match(t, /lims_worker/);
  assert.match(t, /\bDDL\b/);
  assert.match(t, /no (DDL|CREATE)|without (DDL|CREATE)|DDL[^\n]*(none|not)/i);
});

test('lims_api enqueues only through app.enqueue_job (direct add_job denied)', () => {
  const t = rec();
  assert.match(t, /lims_api/);
  assert.match(t, /app\.enqueue_job/);
  assert.match(t, /permission denied|denied|not (allowed|permitted)|cannot/i, 'direct add_job denial evidence');
});

test('add_job parameter names/types confirmed incl. job_key_mode unsafe_dedupe', () => {
  const t = rec();
  assert.match(t, /graphile_worker\.add_job/);
  for (const p of ['identifier', 'payload', 'queue_name', 'run_at', 'max_attempts', 'job_key', 'priority', 'flags', 'job_key_mode']) {
    assert.match(t, new RegExp(`\\b${p}\\b`), `add_job param ${p}`);
  }
  assert.match(t, /unsafe_dedupe/);
  assert.match(t, /dedupe[^\n]*(work|behav|confirm|verified|single|one job)/i, 'dedupe behaviour recorded');
});

test('completed jobs deleted or kept (stated)', () => {
  assert.match(rec(), /complet(ed|ion)[^\n]*(delet|remov|kept|retain)|(delet|remov)[^\n]*complet/i);
});

test('permanent-failure detection in-process (events API vs attempts check)', () => {
  const t = rec();
  assert.match(t, /permanent[^\n]*fail|dead[- ]letter/i);
  assert.match(t, /events?\b[^\n]*(API|job:error|job:failed)|attempts[^\n]*max_attempts/i);
});

test('built-in backoff formula recorded', () => {
  const t = rec();
  assert.match(t, /backoff/i);
  assert.match(t, /exp|\*\*|\^|pow|\d+\s*\*/i, 'a formula, not just the word backoff');
});

test('crontab supplied from code (REQ-ARCH-042)', () => {
  const t = rec();
  assert.match(t, /crontab|cron/i);
  assert.match(t, /parsedCronItems|crontab\b[^\n]*(code|string|option)|REQ-ARCH-042/i);
});

test('LISTEN/NOTIFY works on worker direct connection', () => {
  const t = rec();
  assert.match(t, /LISTEN|NOTIFY/);
  assert.match(t, /direct/i);
});

test('partial: residual privilege recorded in worker DECISIONS.md, 07-SECURITY §6 and CR to CV §5.9', () => {
  const t = rec();
  if (outcome(t) !== 'partial') return;
  assert.match(t, /services\/worker\/src\/core\/DECISIONS\.md/);
  assert.match(t, /07-SECURITY/);
  assert.match(t, /CV §?5\.9/);
  assert.ok(existsSync(decisions), 'services/worker/src/core/DECISIONS.md must exist when outcome is partial');
});

test('fail: founder decision named, pg-boss alternate noted', () => {
  const t = rec();
  if (outcome(t) !== 'fail') return;
  assert.match(t, /founder/i);
  assert.match(t, /pg-boss/);
});

test('no secrets/real data: no JWT, private key or password-bearing DSN in record', () => {
  const t = rec();
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'raw JWT');
  assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(t, /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/, 'DSN with embedded password');
});
