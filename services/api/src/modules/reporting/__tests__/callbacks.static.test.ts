// C6-T29 static/structural checks (06-PLAN row C6-T29: modules/reporting/handlers; CB1/CB2 contract in contracts/openapi/reporting.yaml; LD-49 (b); 07-SECURITY REQ-SEC-095/098/136).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { REPO_ROOT } from '../../../core/module.js';

const API = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'reporting');
const H = join(API, 'handlers', 'callbacks.handlers.ts');
const S = join(API, 'service', 'callbacks.service.ts');
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mine = () => code(H) + code(S);
const dir = (d: string) => readdirSync(join(API, d)).filter((f) => f.endsWith('.ts')).map((f) => src(join(API, d, f))).join('\n');

describe('owned files exist and are wired', () => {
  it('handlers/callbacks.handlers.ts exists and index.ts wires it', () => {
    expect(existsSync(H)).toBe(true); expect(src(join(API, 'index.ts'))).toMatch(/callbacks\.handlers|callbackHandlers/);
  });
  it('the recording transport implements parseCallback (the only adapter outside production, REQ-SEC-136); transport.ts declares it', () => {
    expect(src(join(API, 'delivery', 'adapters', 'recording.ts'))).toMatch(/parseCallback/); expect(src(join(API, 'delivery', 'transport.ts'))).toMatch(/parseCallback/);
  });
});

describe('LD-49 (b) hygiene', () => {
  it('no inline SQL in handler/service; the DEFINER is called from repository/ with ($1, $2, $3::jsonb)', () => {
    expect(src(H).length).toBeGreaterThan(0);
    expect(mine()).not.toMatch(/\b(select\s[\s\S]{0,200}\sfrom|insert\s+into|update\s+\w+[\s\S]{0,80}\sset|delete\s+from)\b[\s\S]{0,200}\b(reporting|app)\./i);
    expect(dir('repository')).toMatch(/app\.reporting_ingest_provider_callback\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*(::jsonb)?\s*\)/i);
  });
  it('the handler enqueues through ctx.queue.enqueue inside withTenantScope with the reporting system actor; no app.enqueue_job SQL, no JWT-claim tricks, no direct claims GUC', () => {
    const c = mine(); expect(c).toMatch(/withTenantScope/); expect(c).toMatch(/queue\.enqueue/); expect(c).toMatch(/reporting\.apply_provider_events/);
    expect(c).toMatch(/systemActorOf\(\s*['"]reporting['"]\s*\)|g_system_actors/);
    expect(c).not.toMatch(/enqueue_job|set_config|request\.jwt|SET\s+LOCAL/i);
  });
  it('the path token is hashed with the shared helper (domain/tokens.hashToken), no own crypto, and neither token, signature nor raw body are logged', () => {
    const c = mine(); expect(c).toMatch(/hashToken|domain\/tokens/); expect(c).not.toMatch(/createHash\(|from 'node:crypto'/);
    expect(c).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(token|signature|rawBody|body|headers)/i);
  });
  it('the signature is checked on req.rawBody (CR-C6-001): the handler reads rawBody and never JSON-parses req.body for the callback', () => {
    const c = code(H) + code(S); expect(c).toMatch(/rawBody/); expect(c).not.toMatch(/JSON\.stringify\(\s*req\.body/);
  });
  it('every failure is the single code reporting.callback_rejected (no other reporting.* error is thrown by the callback handler/service)', () => {
    const c = mine(); expect(c).toMatch(/reporting\.callback_rejected/);
    expect([...c.matchAll(/LimsError\(\s*'(reporting\.[a-z_]+)'/g)].map((m) => m[1]).filter((x) => x !== 'reporting.callback_rejected')).toEqual([]);
  });
  it('no console / network / eval / Math.random in the callback sources', () => {
    expect(mine()).not.toMatch(/console\.|\bfetch\(|node:https?|\beval\(|new Function\(|Math\.random\(/);
  });
});

describe('OpenAPI contract of CB1 / CB2 (already shipped by T0C-10.C6; pins that the handler task did not need a contract change)', () => {
  const yaml = readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'reporting.yaml'), 'utf8');
  const block = (op: string) => { const i = yaml.indexOf(`operationId: ${op}`); const j = yaml.indexOf('operationId:', i + 10); return yaml.slice(i, j < 0 ? undefined : j); };
  it('CB1: x-public, x-raw-body, no idempotency key, reporting.callback_rejected declared, 400 response', () => {
    const b = block('receiveProviderCallback'); expect(b).toMatch(/x-public:/); expect(b).toMatch(/x-raw-body:\s*true/); expect(b).toMatch(/x-idempotency:\s*none/);
    expect(b).toMatch(/- reporting\.callback_rejected/); expect(b).toMatch(/"400"/); expect(b).toMatch(/maxLength:\s*262144/);
  });
  it('CB2: x-public, text/plain 200 (maxLength 1000), reporting.callback_rejected declared', () => {
    const b = block('verifyProviderCallback'); expect(b).toMatch(/x-public:/); expect(b).toMatch(/text\/plain/); expect(b).toMatch(/maxLength:\s*1000/); expect(b).toMatch(/- reporting\.callback_rejected/);
  });
});
