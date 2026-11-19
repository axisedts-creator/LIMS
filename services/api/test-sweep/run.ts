// T0B-SWEEP-1 (LD-269; LD-267: fake contexts hide wiring gaps). `pnpm --filter @lims/api sweep [--write-known]`
// 1. starts + migrates + seeds the pinned Docker Postgres through db/tests/run-suites.sh (LIMS_PG_PREPARE_ONLY=1, same logic, no fork),
// 2. applies role pack elabcorp_default with the real CLI and creates one session per kind (sessions.ts),
// 3. boots the REAL API (core/bootstrap + core/config, exactly what src/main.ts runs; app.inject instead of listen [CONV]),
// 4. calls every operation of contracts/openapi once with a session of a kind allowed to call it, classifies, writes the notes,
// 5. gate: exit 1 on a new defect or a known failure that now works. `--write-known` rewrites known-failures.json instead.
// T0B-SWEEP-2 (LD-270): paced under the per-user bucket + 429 retry (pace.ts), schema-built bodies (request.ts), DEPTH + defect class
// (classify.ts), handler stacks for the 500s, writes .orchestra/notes/T0B-SWEEP-2-results.{json,md} (summary.ts).
// SAFETY: assertLocalDatabase() before any connection; only env set here is read; no cloud URL, no secret folder, no key in the repo.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import diagnostics from 'node:diagnostics_channel';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify, defectClass } from './classify.js';
import { evaluateGate, notExercisedOps, type KnownFailure } from './gate.js';
import { failureDetail } from './detail.js';
import { loadOperations, type Operation } from './ops.js';
import { createPacer, withRateLimitRetry } from './pace.js';
import { buildRequest } from './request.js';
import { assertLocalDatabase } from './safety.js';
import { BRANCH_A, CENTRE_A, createRunKey, createSessions, permissionSets, SESSION_KINDS, SWEEP_PARTNER_ID, TENANT_A, type SessionKind } from './sessions.js';
import { renderResults, type SweepRow } from './summary.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const API = join(ROOT, 'services', 'api');
const KNOWN = join(API, 'test-sweep', 'known-failures.json');
const NOTES = join(ROOT, '.orchestra', 'notes');
const ISSUER = 'https://gotrue.lims.test/auth/v1', AUDIENCE = 'authenticated';
const TIMEOUT_MS = 20_000;
const FOUR: Record<string, string> = {
  listTenants: 'PLATFORM-WIRE-1 (LD-267)', listPlatformIrdAnnexes: 'PLATFORM-WIRE-1 (LD-267)',
  listPlatformSupportSessions: 'PLATFORM-WIRE-1 (LD-267)', listDeadLetters: 'PLATFORM-WIRE-1 (LD-267)',
};
const log = (s: string) => process.stderr.write(`[sweep] ${s}\n`);


// ---------- 1. database ----------
function startDb(): Promise<{ name: string; port: string; superPw: string; apiPw: string }> {
  return new Promise((ok, fail) => {
    const p = spawn('bash', ['db/tests/run-suites.sh'], { cwd: ROOT, env: { ...process.env, LIMS_SKIP_GEN: '1', LIMS_PG_PREPARE_ONLY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', fail);
    p.on('close', (code) => {
      const m = /^LIMS_PG_READY (\S+) (\d+) (\S+) (\S+)$/m.exec(out);
      if (code === 0 && m) ok({ name: m[1]!, port: m[2]!, superPw: m[3]!, apiPw: m[4]! });
      else fail(new Error(`run-suites.sh prepare failed (exit ${code}):\n${(out + err).split('\n').slice(-25).join('\n')}`));
    });
  });
}

/** The kind the sweep calls with, and whether that kind holds x-permission (classifier input). */
function pickKind(op: Operation, perms: Record<SessionKind, Set<string>>): { kind: SessionKind; holds: boolean } {
  const has = (k: SessionKind) => !op.permission || perms[k].has(op.permission);
  if (op.path.startsWith('/v1/identity/mobile/')) return { kind: 'mobile_staff', holds: has('mobile_staff') };
  if (op.path.startsWith('/v1/identity/auth/patient/')) return { kind: 'patient', holds: has('patient') };
  if (op.context === 'platform') {
    for (const k of ['platform_superadmin_aal2', 'platform_support_aal1'] as const) if (has(k)) return { kind: k, holds: true };
    return { kind: 'platform_superadmin_aal2', holds: false };
  }
  for (const k of ['tenant_corp_admin', 'tenant_narrow', 'mobile_staff', 'partner', 'patient'] as const) if (has(k)) return { kind: k, holds: true };
  return { kind: 'tenant_corp_admin', holds: false };
}

// ---------- root-cause guess (for the lead's fix queue) ----------
function rootCause(status: number, code: string, detail: string, reason: string): string {
  if (reason === 'unmatched route') return 'route not mounted';
  if (reason === 'timeout') return 'timeout / hang';
  if (code === 'partners.partner_inactive') return 'harness fixture gap: no partners.partners/partner_users row for the seeded partner membership';
  if (status === 401 || status === 403) return `auth: ${code || status}`;
  // T0B-SWEEP-2: a captured stack names the throw site; group by it (first frame under src/)
  const site = /\(file:\/\/\/(services\/api\/src\/[^):]+\.ts):(\d+)/.exec(detail);
  if (site) return `${status} thrown at ${site[1]}:${site[2]}${site[1].endsWith('authz-guard.ts') ? ' (2xx without assertRole)' : ''}`;
  const d = detail.toLowerCase();
  if (/not wired|unwired|no .*port/.test(d)) return '500: port or service not wired';
  if (/permission denied|42501|row-level security/.test(d)) return '500: DB grant / RLS (42501)';
  if (/does not exist|42p01|42703|42883/.test(d)) return '500: schema mismatch (missing relation/column/function)';
  if (/violates|23\d{3}/.test(d)) return '500: constraint violation';
  if (/response|serializ|must have required property|must not have additional/.test(d)) return '500: response validation';
  if (/cannot read|undefined|is not a function|typeerror/.test(d)) return '500: handler bug (TypeError)';
  return `500: other (${code || 'no code'})`;
}

/** Message + the first frames under the repo, paths repo-relative (synthetic DB only; in-memory until written to the notes). */
function trimStack(e: unknown): string {
  const s = String((e as Error)?.stack ?? e).replace(/\\/g, '/').split(ROOT.replace(/\\/g, '/') + '/').join('');
  const [head, ...frames] = s.split('\n');
  return [head!.slice(0, 300), ...frames.filter((f) => /services\/|packages\//.test(f) && !/node_modules/.test(f)).slice(0, 6).map((f) => f.trim())].join(' / ');
}

// LD-270 done_when 4: stack-level explanation of the two SWEEP-1 500s (the stack comes from fastify's handler error channel).
// The "why" is the writer's reading of the throw site in this run's stack (T0B-SWEEP-2 impl note); the stack itself is live.
const WHY: Record<string, string> = {
  verifyProviderCallback: 'callbacks.service.ts:37 fails closed on `!ctx.tx`: the public callback operation reaches the service with no transaction on its ctx (the handler expects an anonymous ctx.tx, callbacks.handlers.ts:1), so the pipeline/handler wiring of public operations does not supply one. BUG.',
  listDeadLetters: 'authz-guard.ts:48 throws common.internal (non-production) because the operation returned 2xx without calling assertRole: the dead-letter path (dead-letter.http.ts / dead-letter.service.ts) never asserts the platform role, so the guard rejects the response. BUG (same family as PLATFORM-WIRE-1).',
};
const EXPLAIN = Object.keys(WHY);
function stackSection(rows: SweepRow[], stacks: Map<string, string>): string {
  const out = ['## Stack-level explanation', '',
    'Captured from `tracing:fastify.request.handler:error` (node:diagnostics_channel) for this run; sendProblem logs name + code only (errors.ts:129).', ''];
  for (const op of EXPLAIN) {
    const r = rows.find((x) => x.operationId === op);
    const st = r ? stacks.get(r.operationId) : undefined;
    out.push(`- **${op}** (${r ? `${r.status} ${r.errorCode || '-'}` : 'not in this run'}): ${WHY[op]}`,
      `  stack: ${st ? `\`${st.replace(/`/g, "'")}\`` : `no handler-stage error published; detail: ${r?.detail || '-'}`}`);
  }
  return out.join('\n');
}

// ---------- main ----------
async function main(): Promise<number> {
  const writeKnown = process.argv.includes('--write-known');
  const ops = loadOperations(ROOT);
  const perms = permissionSets(ROOT);
  log(`${ops.length} operations; starting the pinned Postgres (migrations + seeds)...`);
  const db = await startDb();
  const scratch = mkdtempSync(join(tmpdir(), 'lims-sweep-'));
  let app: any;
  try {
    const suUrl = `postgres://supabase_admin:${db.superPw}@127.0.0.1:${db.port}/postgres`;
    const apiUrl = `postgres://lims_api:${db.apiPw}@127.0.0.1:${db.port}/postgres`;
    assertLocalDatabase(suUrl); assertLocalDatabase(apiUrl);

    log('applying role pack elabcorp_default to tenant_a (real CLI)...');
    execFileSync(process.execPath, ['--import', '../../tools/node-ts/register.mjs', 'src/modules/identity/cli/apply-role-pack.ts', '--tenant', TENANT_A, '--pack', 'elabcorp_default'],
      { cwd: API, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: db.port, PGUSER: 'lims_api', PGPASSWORD: db.apiPw, PGDATABASE: 'postgres' } });

    const pg = (await import('pg')).default;
    const su = new pg.Client({ connectionString: suUrl });
    await su.connect();
    const key = createRunKey();
    let tokens: Record<SessionKind, string>;
    try { tokens = await createSessions((s, p) => su.query(s, p as any[]), key, ISSUER, AUDIENCE); } finally { await su.end(); }
    const keyFile = join(scratch, 'jwt-es256-pub.pem');
    writeFileSync(keyFile, key.publicKeyPem, { mode: 0o600 });
    const rlKeyFile = join(scratch, 'ratelimit-hmac.key');   // throwaway HMAC key, os.tmpdir() only
    writeFileSync(rlKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });

    Object.assign(process.env, {
      LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISSUER, LIMS_CORE_JWT_AUDIENCE: AUDIENCE, LIMS_CORE_JWT_KEY_FILE: keyFile,
      LIMS_CORE_DATABASE_URL: apiUrl, LIMS_CORE_METRICS_PORT: '0', LIMS_CORE_TENANT_RPS: '1000000', LIMS_CORE_TENANT_BURST: '1000000',
      LIMS_CORE_LOG_LEVEL: 'warn', LIMS_CORE_RATELIMIT_KEY_FILE: rlKeyFile,
    });
    // module env defaults (synthetic, os.tmpdir key files) only where still unset, the same file the API's vitest setup uses
    await import(pathToFileURL(join(API, 'src', '__tests__', 'setup-env.ts')).href);
    const { bootstrap } = await import('../src/core/bootstrap.js');
    const { loadConfig } = await import('../src/core/config.js');
    const logs = new Map<string, string[]>();
    const logStream = { write(line: string) {
      try { const o = JSON.parse(line); const id = o.request_id; if (id) { const a = logs.get(id) ?? []; a.push(line); logs.set(id, a); } } catch { /* not JSON */ }
    } };
    // handler-stage throws (with stack) by request id; the shared error handler logs no stack (errors.ts:129)
    const stacksByRid = new Map<string, string>();
    const onHandlerError = (m: any) => { const id = m?.request?.id; if (id && m.error) stacksByRid.set(String(id), trimStack(m.error)); };
    diagnostics.subscribe('tracing:fastify.request.handler:error', onHandlerError);
    // fastify publishes handler:start only after schema validation passed (handle-request.js preHandlerCallback): DEEP evidence for a 400
    const reachedByRid = new Set<string>();
    const onHandlerStart = (m: any) => { const id = m?.request?.id; if (id) reachedByRid.add(String(id)); };
    diagnostics.subscribe('tracing:fastify.request.handler:start', onHandlerStart);
    log('booting the real API (all modules)...');
    app = await bootstrap({ config: loadConfig(process.env), logStream });

    // LD-270 done_when 1: `u:` is 10/s burst 20 per subject, hard-coded (ratelimit/index.ts:41), so pace each session under it.
    const pacer = createPacer({ ratePerSecond: 9, burst: 18, now: Date.now, sleep });
    // seeded row ids (seed 010 + sessions.ts) by parameter / property name; anything else gets a placeholder (a 404 is DEEP)
    const ids: Record<string, string> = { tenant_id: TENANT_A, partner_id: SWEEP_PARTNER_ID, branch_id: BRANCH_A, centre_id: CENTRE_A };
    const rows: SweepRow[] = [];
    const stacks = new Map<string, string>();
    for (const op of ops) {
      if (rows.length % 100 === 0) log(`${rows.length}/${ops.length}...`);
      const { kind, holds: holdsPerm } = pickKind(op, perms);
      const bearer = op.security.includes('bearerJwt');
      const auth = bearer ? 'bearer' : op.security.length ? `none:${op.security.join('+')}` : 'public';
      const holds = bearer && holdsPerm;
      const matched = app.hasRoute({ method: op.method.toUpperCase(), url: op.path.replace(/\{([^}]+)\}/g, ':$1') });
      let status = 0, body: any = {}, timedOut = false, harnessError = false, rid = '';
      try {
        const send = async () => {
          await pacer.acquire(bearer ? kind : 'anonymous');
          const req = buildRequest(op, bearer ? tokens[kind] : undefined, ids);
          return await Promise.race([app.inject(req), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), TIMEOUT_MS))]) as any;
        };
        // an hour-window tier (login, OTP) would need > 15 s: left 429, reported NOT EXERCISED
        const { res } = await withRateLimitRetry(send, { sleep, maxWaitMs: 15_000 });
        status = res.statusCode;
        try { body = res.json(); } catch { body = {}; }
        rid = String(res.headers['x-request-id'] ?? body?.request_id ?? '');
      } catch (e) {
        timedOut = (e as Error).message === 'timeout';
        if (!timedOut) { harnessError = true; body = { code: 'inject_error', detail: String(e) }; }
      }
      const code = String(body?.code ?? '');
      const c = classify({ status, timedOut, matched, holdsPermission: holds, errorCode: code, harnessError, reachedHandler: rid !== '' && reachedByRid.has(rid) });
      const stack = stacksByRid.get(rid);
      if (stack) stacks.set(op.operationId, stack);
      const fields = Array.isArray(body?.errors) ? body.errors.slice(0, 4).map((f: any) => `${f.path ?? '?'} ${f.code ?? ''}`.trim()).join('; ') : '';
      const fallback = [body?.detail, body?.title, code, fields].filter(Boolean).join(' ');
      const detail = c.depth === 'SHALLOW' ? (fields || fallback || 'common.validation_failed (no errors[])') : stack ?? failureDetail(logs.get(rid) ?? [], fallback);
      const defect = c.verdict === 'DEFECT';
      rows.push({ module: op.module, operationId: op.operationId, method: op.method, path: op.path, sessionKind: kind, auth, holdsPermission: holds,
        status, errorCode: code, verdict: c.verdict, depth: c.depth, reason: c.reason,
        rootCause: defect ? rootCause(status, code, detail, c.reason) : '',
        defectClass: defect ? defectClass({ status, errorCode: code, detail, reason: c.reason }) : '', detail: defect || c.depth === 'SHALLOW' ? detail || c.reason : detail });
    }
    diagnostics.unsubscribe('tracing:fastify.request.handler:error', onHandlerError);
    diagnostics.unsubscribe('tracing:fastify.request.handler:start', onHandlerStart);
    const meta = { at: new Date().toISOString(), operations: ops.length, sessionKinds: SESSION_KINDS };
    writeFileSync(join(NOTES, 'T0B-SWEEP-2-results.json'), JSON.stringify({ meta, rows }, null, 1) + '\n');
    writeFileSync(join(NOTES, 'T0B-SWEEP-2-results.md'), renderResults(rows, { at: meta.at, sections: [stackSection(rows, stacks)] }));

    const defects = rows.filter((r) => r.verdict === 'DEFECT');
    const ne = notExercisedOps(rows);
    log(`done: ${rows.length} operations, ${defects.length} defects, ${ne.length} NOT EXERCISED${ne.length ? `: ${ne.slice(0, 20).join(', ')}` : ''}`);
    if (writeKnown) {
      const known: KnownFailure[] = defects.map((r) => ({ operation: r.operationId, status: r.status, class: r.defectClass as KnownFailure['class'],
        ref: FOUR[r.operationId] ?? `T0B-SWEEP-2 ${r.defectClass} (unqueued: ${r.rootCause})` }));
      writeFileSync(KNOWN, JSON.stringify(known, null, 1) + '\n');
      log(`wrote ${known.length} known failures`);
      return 0;
    }
    const g = evaluateGate(rows, JSON.parse(readFileSync(KNOWN, 'utf8')) as KnownFailure[]);
    if (!g.ok) {
      if (g.newDefects.length) log(`NEW defects: ${g.newDefects.join(', ')}`);
      if (g.nowWorking.length) log(`now working (remove from known-failures.json): ${g.nowWorking.join(', ')}`);
      return 1;
    }
    log('gate ok');
    return 0;
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
    try { execFileSync('docker', ['rm', '-f', db.name], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}

main().then((c) => process.exit(c), (e) => { log(`FAILED: ${(e as Error).stack ?? e}`); process.exit(2); });
