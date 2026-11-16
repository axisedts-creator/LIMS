// T0B-SWEEP-1 (LD-269; LD-267: fake contexts hide wiring gaps). `pnpm --filter @lims/api sweep [--write-known]`
// 1. starts + migrates + seeds the pinned Docker Postgres through db/tests/run-suites.sh (LIMS_PG_PREPARE_ONLY=1, same logic, no fork),
// 2. applies role pack elabcorp_default with the real CLI and creates one session per kind (sessions.ts),
// 3. boots the REAL API (core/bootstrap + core/config, exactly what src/main.ts runs; app.inject instead of listen [CONV]),
// 4. calls every operation of contracts/openapi once with a session of a kind allowed to call it, classifies, writes the notes,
// 5. gate: exit 1 on a new defect or a known failure that now works. `--write-known` rewrites known-failures.json instead.
// SAFETY: assertLocalDatabase() before any connection; only env set here is read; no cloud URL, no secret folder, no key in the repo.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify } from './classify.js';
import { evaluateGate, type KnownFailure } from './gate.js';
import { failureDetail } from './detail.js';
import { loadOperations, type Operation, type Param } from './ops.js';
import { assertLocalDatabase } from './safety.js';
import { createRunKey, createSessions, permissionSets, SESSION_KINDS, TENANT_A, type SessionKind } from './sessions.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const API = join(ROOT, 'services', 'api');
const KNOWN = join(API, 'test-sweep', 'known-failures.json');
const NOTES = join(ROOT, '.orchestra', 'notes');
const ISSUER = 'https://gotrue.lims.test/auth/v1', AUDIENCE = 'authenticated';
const TIMEOUT_MS = 20_000;
const SAMPLE_UUID = '0193a5c0-0000-7000-8000-0000000000ff';
const FOUR: Record<string, string> = {
  listTenants: 'PLATFORM-WIRE-1 (LD-267)', listPlatformIrdAnnexes: 'PLATFORM-WIRE-1 (LD-267)',
  listPlatformSupportSessions: 'PLATFORM-WIRE-1 (LD-267)', listDeadLetters: 'PLATFORM-WIRE-1 (LD-267)',
};
const log = (s: string) => process.stderr.write(`[sweep] ${s}\n`);

export interface Row {
  module: string; operationId: string; method: string; path: string; sessionKind: SessionKind; auth: string; holdsPermission: boolean;
  status: number; errorCode: string; verdict: 'WIRED' | 'DEFECT'; reason: string; rootCause: string; detail: string;
}

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

// ---------- 3. request building ----------
function sample(schema: any, name: string): string {
  if (schema?.example !== undefined) return String(schema.example);
  if (Array.isArray(schema?.enum) && schema.enum.length) return String(schema.enum[0]);
  if (schema?.format === 'uuid' || /(_id|Id)$/.test(name)) return SAMPLE_UUID;
  if (schema?.type === 'integer' || schema?.type === 'number') return String(schema.minimum ?? 1);
  if (schema?.type === 'boolean') return 'true';
  if (schema?.format === 'date') return '2026-11-16';
  if (schema?.format === 'date-time') return '2026-11-16T00:00:00.000Z';
  return 'sweep';
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

function buildRequest(op: Operation, token: string | undefined) {
  let url = op.path.replace(/\{([^}]+)\}/g, (_, n: string) => {
    const p = op.params.find((x: Param) => x.in === 'path' && x.name === n);
    return encodeURIComponent(sample(p?.schema, n));
  });
  const qs = op.params.filter((p) => p.in === 'query' && p.required).map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(sample(p.schema, p.name))}`);
  if (qs.length) url += `?${qs.join('&')}`;
  const headers: Record<string, string> = { 'user-agent': 'lims-sweep/1' };
  for (const p of op.params.filter((x) => x.in === 'header' && x.required)) headers[p.name.toLowerCase()] = sample(p.schema, p.name);
  if (op.idempotency && op.idempotency !== 'none') headers['idempotency-key'] = `sweep-${Math.random().toString(36).slice(2, 14)}`;
  if (headers['if-match'] !== undefined) headers['if-match'] = '"1"';
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (op.hasBody) {
    const t = op.bodyType ?? 'application/json';
    if (t.includes('json')) { headers['content-type'] = 'application/json'; payload = '{}'; }
    else if (t.startsWith('multipart/')) { headers['content-type'] = 'multipart/form-data; boundary=sweep'; payload = '--sweep--\r\n'; }
    else { headers['content-type'] = t; payload = ''; }
  }
  return { method: op.method.toUpperCase(), url, headers, payload };
}

// ---------- root-cause guess (for the lead's fix queue) ----------
function rootCause(status: number, code: string, detail: string, reason: string): string {
  if (reason === 'unmatched route') return 'route not mounted';
  if (reason === 'timeout') return 'timeout / hang';
  if (code === 'partners.partner_inactive') return 'harness fixture gap: no partners.partners/partner_users row for the seeded partner membership';
  if (status === 401 || status === 403) return `auth: ${code || status}`;
  const d = detail.toLowerCase();
  if (/not wired|unwired|no .*port/.test(d)) return '500: port or service not wired';
  if (/permission denied|42501|row-level security/.test(d)) return '500: DB grant / RLS (42501)';
  if (/does not exist|42p01|42703|42883/.test(d)) return '500: schema mismatch (missing relation/column/function)';
  if (/violates|23\d{3}/.test(d)) return '500: constraint violation';
  if (/response|serializ|must have required property|must not have additional/.test(d)) return '500: response validation';
  if (/cannot read|undefined|is not a function|typeerror/.test(d)) return '500: handler bug (TypeError)';
  return `500: other (${code || 'no code'})`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 220);

function writeNotes(rows: Row[], meta: Record<string, unknown>): void {
  writeFileSync(join(NOTES, 'T0B-SWEEP-1-results.json'), JSON.stringify({ meta, rows }, null, 1) + '\n');
  const out: string[] = ['# T0B-SWEEP-1 results (generated by `pnpm --filter @lims/api sweep`; do not edit)', '',
    `Run: ${meta.at}. Operations: ${rows.length}. WIRED: ${rows.filter((r) => r.verdict === 'WIRED').length}. DEFECT: ${rows.filter((r) => r.verdict === 'DEFECT').length}.`,
    'Classification (LD-269): 2xx/400/404/409/422 WIRED; 401/403 with a session holding the permission, any 5xx, timeout, unmatched = DEFECT.',
    'auth `none:<scheme>` = no credential of that scheme is minted by the harness (only bearerJwt is), so 401 there is an expected denial.', ''];
  for (const m of [...new Set(rows.map((r) => r.module))]) {
    const rs = rows.filter((r) => r.module === m);
    out.push(`## ${m} (${rs.filter((r) => r.verdict === 'DEFECT').length} defects / ${rs.length})`, '',
      '| operation | session kind | status | error_code | verdict | detail |', '|---|---|---|---|---|---|');
    for (const r of rs) out.push(`| ${r.operationId} | ${r.sessionKind}${r.auth === 'bearer' ? '' : ` (${r.auth})`} | ${r.status} | ${r.errorCode || '-'} | ${r.verdict} | ${cell(r.verdict === 'DEFECT' ? r.detail || r.reason : r.reason)} |`);
    out.push('');
  }
  const by = new Map<string, number>();
  for (const r of rows.filter((x) => x.verdict === 'DEFECT')) by.set(r.rootCause, (by.get(r.rootCause) ?? 0) + 1);
  out.push('## Defect count by root-cause guess', '', '| root cause (guess) | defects |', '|---|---|',
    ...[...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${cell(k)} | ${v} |`), '');
  writeFileSync(join(NOTES, 'T0B-SWEEP-1-results.md'), out.join('\n'));
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
    log('booting the real API (all modules)...');
    app = await bootstrap({ config: loadConfig(process.env), logStream });

    const rows: Row[] = [];
    for (const op of ops) {
      if (rows.length % 100 === 0) log(`${rows.length}/${ops.length}...`);
      const { kind, holds: holdsPerm } = pickKind(op, perms);
      const bearer = op.security.includes('bearerJwt');
      const auth = bearer ? 'bearer' : op.security.length ? `none:${op.security.join('+')}` : 'public';
      const holds = bearer && holdsPerm;
      const req = buildRequest(op, bearer ? tokens[kind] : undefined);
      const matched = app.hasRoute({ method: req.method, url: op.path.replace(/\{([^}]+)\}/g, ':$1') });
      let status = 0, body: any = {}, timedOut = false, rid = '';
      try {
        const res: any = await Promise.race([app.inject(req), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), TIMEOUT_MS))]);
        status = res.statusCode;
        try { body = res.json(); } catch { body = {}; }
        rid = String(res.headers['x-request-id'] ?? body?.request_id ?? '');
      } catch (e) { timedOut = (e as Error).message === 'timeout'; if (!timedOut) body = { code: 'inject_error', detail: String(e) }; }
      const c = classify({ status, timedOut, matched, holdsPermission: holds });
      const code = String(body?.code ?? '');
      const detail = failureDetail(logs.get(rid) ?? [], [body?.detail, body?.title, code].filter(Boolean).join(' '));
      rows.push({ module: op.module, operationId: op.operationId, method: op.method, path: op.path, sessionKind: kind, auth, holdsPermission: holds,
        status, errorCode: code, verdict: c.verdict, reason: c.reason, rootCause: c.verdict === 'DEFECT' ? rootCause(status, code, detail, c.reason) : '', detail });
    }
    writeNotes(rows, { at: new Date().toISOString(), operations: ops.length, sessionKinds: SESSION_KINDS });

    const defects = rows.filter((r) => r.verdict === 'DEFECT');
    log(`done: ${rows.length} operations, ${defects.length} defects`);
    if (writeKnown) {
      const known: KnownFailure[] = defects.map((r) => ({ operation: r.operationId, status: r.status, ref: FOUR[r.operationId] ?? (r.rootCause.startsWith('harness fixture gap')
        ? 'T0B-SWEEP-1 fixture gap: seed has no partners.partners/partner_users row for the partner membership (not a code defect)'
        : `T0B-SWEEP-1 (unqueued: ${r.rootCause})`) }));
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
