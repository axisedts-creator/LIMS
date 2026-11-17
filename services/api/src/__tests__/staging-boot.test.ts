// WIRE-BOOT / LD-188 (2026-11-14, C1; founder go on option A): boot the REAL modules directory with LIMS_CORE_ENV=staging,
// no LIMS_CORE_FAKE_PORTS, and a process env made ONLY from the names render.yaml declares (parsed as text, no YAML dependency).
// Values are synthetic: *_FILE names -> temp files, URL names -> https on the reserved .invalid domain, keys -> random bytes.
// AC-0D-6.1/6.2/6.4 (02-TRD s6.3, as cited in core/ports/registry.ts): in staging every port is 'real' or a listed phase stub.
// real-modules-boot.test.ts boots with LIMS_CORE_ENV=ci, where fakes hide an unwired port; this file closes that gap.
// Standing rule: no secret value in the repository, synthetic data only. No network: socket connects are blocked and recorded.
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Capture the resolution map of the real resolvePorts (bootstrap does not expose it).
const captured = vi.hoisted(() => ({ resolutions: [] as Array<Record<string, string>> }));
vi.mock('../core/ports/registry.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../core/ports/registry.js')>();
  return {
    ...orig,
    resolvePorts: (o: Parameters<typeof orig.resolvePorts>[0]) => {
      const r = orig.resolvePorts(o);
      captured.resolutions.push({ ...r.resolution });
      return r;
    },
  };
});

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const RENDER_YAML = join(REPO_ROOT, 'render.yaml');
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');

export interface DeclaredVar { readonly key: string; readonly value?: string; readonly sync?: string }

/** Text parse of the render.yaml envVars list: `- key: NAME` followed by `value: X` or `sync: false`. */
export function parseRenderEnvVars(text: string): DeclaredVar[] {
  const out: Array<{ key: string; value?: string; sync?: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const k = /^\s*-\s*key:\s*(\S+)\s*$/.exec(line);
    if (k) { out.push({ key: k[1]! }); continue; }
    const cur = out[out.length - 1];
    const v = /^\s+value:\s*(.*?)\s*$/.exec(line);
    if (cur && v) cur.value = v[1]!.replace(/^(["'])(.*)\1$/, '$2');
    const s = /^\s+sync:\s*(\S+)\s*$/.exec(line);
    if (cur && s) cur.sync = s[1]!;
  }
  return out;
}

let scratch: string;
const tmpFile = (name: string, data: string | Buffer): string => {
  const p = join(scratch, name);
  writeFileSync(p, data, { mode: 0o600 });
  return p;
};

/** One synthetic value per declared name. A name nobody here knows how to fill is a loud failure, never a silent skip. */
export function syntheticValue(name: string): string {
  const hex = () => randomBytes(32).toString('hex'); // 64 bytes of text >= every 32-byte minimum
  const b64 = () => randomBytes(32).toString('base64');
  switch (name) {
    case 'NODE_BASE_IMAGE': return 'node:0-synthetic'; // docker build arg, not read by the app
    case 'LIMS_CORE_DATABASE_URL': return 'postgres://lims_app:synthetic-not-a-secret@db.lims-staging.invalid:5432/lims';
    case 'LIMS_CORE_JWT_ALG': return 'ES256';
    case 'LIMS_CORE_JWT_ISSUER': return 'https://gotrue.lims-staging.invalid/auth/v1';
    case 'LIMS_CORE_JWT_AUDIENCE': return 'authenticated';
    case 'LIMS_CORE_JWT_KEY_FILE': {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      return tmpFile('jwt-es256-pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    }
    case 'LIMS_CORE_TRUSTED_PROXY_CIDRS': return '10.0.0.0/8';
    case 'LIMS_IDENTITY_TOKEN_ENC_KEYS': return JSON.stringify({ 'k-synthetic-1': b64() }); // inline JSON, newest id last
    case 'LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE': return tmpFile('engagement-otp-enc-keys.json', JSON.stringify({ 'k-synthetic-1': b64() }));
    case 'LIMS_PAYMENTS_KEK_FILE': return tmpFile('payments-kek.json', JSON.stringify({ keys: { 'kek-synthetic-1': b64() }, active: 'kek-synthetic-1' }));
    case 'LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID': return 'sig-synthetic-1';
    case 'LIMS_INSTRUMENTS_RELEASES_DIR': { const d = join(scratch, 'instrument-releases'); mkdirSync(d, { recursive: true }); return d; }
    default:
  }
  if (/^LIMS_ORIGIN_[A-Z_]+$/.test(name)) return `https://${name.slice(11).toLowerCase().replace(/_/g, '-')}.lims-staging.invalid`;
  if (/_URL$/.test(name)) return `https://${name.toLowerCase().replace(/^lims_/, '').replace(/_/g, '-')}.lims-staging.invalid`;
  if (/_KEY_FILE$/.test(name) || /_FILE$/.test(name)) return tmpFile(`${name.toLowerCase()}.key`, hex());
  if (/(_KEY|_SECRET|_HMAC_KEY|_SERVICE_KEY)$/.test(name)) return hex();
  throw new Error(`staging-boot fixture cannot fill ${name}, which render.yaml declares: add a synthetic-value rule for it to syntheticValue() in staging-boot.test.ts`);
}

/** The staging env: ONLY names declared in render.yaml. A literal `value:` wins; `sync: false` names get a synthetic value. */
export function buildStagingEnv(declared: readonly DeclaredVar[], fill: (n: string) => string = syntheticValue): Record<string, string> {
  const env: Record<string, string> = {};
  for (const d of declared) {
    if (d.value !== undefined && d.sync !== undefined) throw new Error(`render.yaml: ${d.key} has both value and sync`);
    env[d.key] = d.value !== undefined ? d.value : fill(d.key);
  }
  return env;
}

const readDeclared = (): DeclaredVar[] => parseRenderEnvVars(readFileSync(RENDER_YAML, 'utf8'));

// ---- boot harness: process.env is replaced (modules read process.env at import), restored afterwards, modules re-imported per boot
const savedEnv = { ...process.env };
const netAttempts: string[] = [];
let app: FastifyInstance | undefined;

function replaceProcessEnv(env: Record<string, string>): void {
  for (const k of Object.keys(process.env)) delete process.env[k]; // drop the ci defaults of setup-env.ts: only declared names remain
  // NODE_ENV is set by vitest itself, not by render.yaml; payments reads it (gateway env), so the test runner's value stays.
  if (savedEnv.NODE_ENV !== undefined) process.env.NODE_ENV = savedEnv.NODE_ENV;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

async function bootStaging(env: Record<string, string>, declaredNames: ReadonlySet<string>): Promise<FastifyInstance> {
  replaceProcessEnv(env);
  vi.resetModules(); // module config is read at import: a second boot must re-import every module with the new env
  captured.resolutions.length = 0;
  const { loadConfig } = await import('../core/config.js');
  const { bootstrap } = await import('../core/bootstrap.js');
  try {
    return await bootstrap({ config: loadConfig({ ...env }) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const named = [...msg.matchAll(/LIMS_[A-Z0-9_]+/g)].map((m) => m[0]);
    const undeclared = named.filter((n) => !declaredNames.has(n));
    const hint = undeclared.length
      ? `render.yaml does not declare ${[...new Set(undeclared)].join(', ')}: add it (sync: false) to render.yaml and .env.example`
      : 'if a module needs a name, render.yaml and .env.example must declare it (sync: false)';
    throw new Error(`staging boot with the env declared by render.yaml failed: ${msg}. ${hint}`, { cause: e });
  }
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-staging-boot-'));
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...a: unknown[]) {
    netAttempts.push(JSON.stringify(a[0] && typeof a[0] === 'object' ? { ...(a[0] as object) } : a[0]));
    throw new Error('staging-boot test: network access is not allowed');
  } as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { netAttempts.push('fetch'); throw new Error('staging-boot test: network access is not allowed'); });
});
afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  replaceProcessEnv(savedEnv as Record<string, string>);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe('render.yaml envVars parse (fixture self-checks)', () => {
  it('reads literals and sync:false names, and nothing else', () => {
    const v = parseRenderEnvVars('envVars:\n  - key: A\n    value: staging\n  - key: B\n    value: "5"\n  - key: C\n    sync: false # note\n');
    expect(v).toEqual([{ key: 'A', value: 'staging' }, { key: 'B', value: '5' }, { key: 'C', sync: 'false' }]);
  });
  it('fails clearly on a declared name the fixture cannot fill', () => {
    expect(() => buildStagingEnv([{ key: 'LIMS_FUTURE_WIDGET_TOKEN', sync: 'false' }])).toThrow(/cannot fill LIMS_FUTURE_WIDGET_TOKEN.*render\.yaml declares/);
  });
  it('refuses a name that has both a value and sync', () => {
    expect(() => buildStagingEnv([{ key: 'X', value: 'v', sync: 'false' }])).toThrow(/both value and sync/);
  });
});

describe('render.yaml and .env.example (names only, no values; standing rule)', () => {
  it('render.yaml declares LIMS_CORE_ENV=staging and every other name is sync: false with no value, except the 3 literals of LD-173', () => {
    const declared = readDeclared();
    expect(declared.find((d) => d.key === 'LIMS_CORE_ENV')?.value).toBe('staging');
    const literals = declared.filter((d) => d.value !== undefined).map((d) => d.key).sort();
    expect(literals).toEqual(['LIMS_CORE_DB_POOL_MAX', 'LIMS_CORE_ENV', 'PORT']);
    for (const d of declared.filter((x) => x.value === undefined)) expect(d.sync, `${d.key} must be sync: false`).toBe('false');
    expect(declared.map((d) => d.key)).not.toContain('LIMS_CORE_FAKE_PORTS'); // fakes never reach staging
  });

  it('declares every name the real modules read at import in staging (the names behind the three missing-name deploys)', () => {
    const names = new Set(readDeclared().map((d) => d.key));
    const need = [
      'LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE', 'LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE', 'LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE', 'LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE',
      'LIMS_PAYMENTS_KEK_FILE', 'LIMS_PAYMENTS_PUBLIC_BASE_URL', 'LIMS_PAYMENTS_ESEWA_FORM_URL',
    ];
    expect(need.filter((n) => !names.has(n)), 'names missing from render.yaml').toEqual([]);
  });

  it('.env.example lists every render.yaml name (except NODE_BASE_IMAGE, PORT) as exactly `NAME=`', () => {
    const lines = new Set(readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/).map((l) => l.trim()));
    const missing = readDeclared().map((d) => d.key).filter((k) => k !== 'NODE_BASE_IMAGE' && k !== 'PORT').filter((k) => !lines.has(`${k}=`));
    expect(missing, 'names declared in render.yaml but absent (or carrying a value) in .env.example').toEqual([]);
  });
});

describe('staging boot of the real modules (LIMS_CORE_ENV=staging, no fake ports, env from render.yaml names only)', () => {
  it('resolves every PORT_OWNERS port real, opens no connection, and serves core health', async () => {
    const declared = readDeclared();
    const env = buildStagingEnv(declared);
    expect(env.LIMS_CORE_ENV).toBe('staging');
    expect(Object.keys(env).sort()).toEqual(declared.map((d) => d.key).sort()); // nothing but declared names
    app = await bootStaging(env, new Set(Object.keys(env)));

    const { PORT_OWNERS } = await import('../core/module.js');
    expect(captured.resolutions.length, 'resolvePorts must have run').toBeGreaterThan(0);
    const resolution = captured.resolutions[captured.resolutions.length - 1]!;
    expect(Object.keys(resolution).sort()).toEqual(Object.keys(PORT_OWNERS).sort());
    const notReal = Object.entries(resolution).filter(([, r]) => r !== 'real').map(([p, r]) => `${p}=${r}`);
    expect(notReal, 'ports not resolved real in staging').toEqual([]);

    expect(netAttempts, 'the boot must not open a network or database connection (report a blocking CR otherwise)').toEqual([]);
    const res = await app.inject({ method: 'GET', url: '/v1/core/health/live' });
    expect(res.statusCode).toBe(200);
  }, 300_000);

  // Mutation check: remove ONE declared name from the fixture; the module's own boot message must surface, wrapped with the hint.
  it.each([
    ['LIMS_REPORTING_OTP_HMAC_KEY_FILE', /config: LIMS_REPORTING_OTP_HMAC_KEY_FILE is required/],
    ['LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE', /config: LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE is required/],
    ['LIMS_PAYMENTS_KEK_FILE', /config: LIMS_PAYMENTS_KEK_FILE is required/],
  ])('with %s removed from the fixture the boot fails with the module message', async (name, own) => {
    const declared = readDeclared();
    expect(declared.map((d) => d.key), `${name} must be declared in render.yaml for this mutation to mean anything`).toContain(name);
    const env = buildStagingEnv(declared);
    delete env[name];
    await expect(bootStaging(env, new Set(declared.map((d) => d.key)))).rejects.toThrow(own);
    expect(captured.resolutions.length, 'boot must fail at the module, before port resolution').toBe(0);
  }, 300_000);

  it('a module needing a name render.yaml does not declare fails with a message that says so', async () => {
    const declared = readDeclared().filter((d) => d.key !== 'LIMS_PAYMENTS_PUBLIC_BASE_URL');
    const env = buildStagingEnv(declared);
    await expect(bootStaging(env, new Set(declared.map((d) => d.key)))).rejects.toThrow(
      /staging boot with the env declared by render\.yaml failed: .*LIMS_PAYMENTS_PUBLIC_BASE_URL is required.*render\.yaml does not declare LIMS_PAYMENTS_PUBLIC_BASE_URL/,
    );
  }, 300_000);
});
