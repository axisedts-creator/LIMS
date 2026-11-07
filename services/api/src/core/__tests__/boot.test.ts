// T0D-01 boot tests — AC-0D-1.1, AC-0D-1.2, AC-0D-1.3 (01-PRD US-0D-1), 02-TRD §6.3 autoloader rules,
// 07-SECURITY REQ-SEC-099 (route inventory), sample module (02-TRD §14).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { boot, bootError, calls, cfg, closeAll } from './helpers.js';

beforeEach(() => {
  calls().length = 0;
});
afterEach(closeAll);

describe('AC-0D-1.1 autoload mounts operations of <m>/index.ts manifests', () => {
  it('mounts every operation of every module found, with no central list', async () => {
    const app = await boot('ok'); // ok/ holds catalog + identity (+ a dir without index.ts that is ignored)
    const list = await app.inject({ method: 'GET', url: '/v1/catalog/things' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [{ id: 't1', name: 'alpha' }] });
    const probe = await app.inject({ method: 'GET', url: '/v1/identity/probe' });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ ok: true });
  });

  it('routes by operationId to the right handler and passes parsed path params', async () => {
    const app = await boot('ok');
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things/abc-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: 'abc-1', name: 'alpha' });
    expect(calls()).toEqual(['getThing']);
  });

  it('applies HandlerResult status, body and headers to the reply', async () => {
    const app = await boot('ok');
    const created = await app.inject({ method: 'POST', url: '/v1/catalog/things', payload: { name: 'beta' } });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-fixture']).toBe('created');
    expect(created.json()).toEqual({ id: 't2', name: 'beta' });
    const del = await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t2' });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
  });

  it('mounts nothing that is not in a spec (REQ-SEC-099): unknown path and method are 404/405, handlers not called', async () => {
    const app = await boot('ok');
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/nothing' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things/../../etc/passwd' })).statusCode).toBe(404);
    expect([404, 405]).toContain((await app.inject({ method: 'PUT', url: '/v1/catalog/things/x' })).statusCode);
    expect(calls()).toEqual([]);
  });

  it('boots with an empty / missing modules directory (no modules is not an error)', async () => {
    const app = await bootstrap({ config: cfg(), repoRoot: fixturesShared(), modulesDir: fixturesShared() + '/does-not-exist' });
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('AC-0D-1.2 manifest handler set must equal the spec operationId set; boot fails naming the operationId', () => {
  it('missing handler: boot rejects and names the operationId and the module', async () => {
    const msg = await bootError('missing-handler');
    expect(msg).toContain('deleteThing');
    expect(msg).toContain('catalog');
  });

  it('extra handler with no operation in the spec: boot rejects and names it', async () => {
    const msg = await bootError('extra-handler');
    expect(msg).toContain('ghostOp');
    expect(msg).toContain('catalog');
  });
});

describe('AC-0D-1.3 produces must equal EVENT_PRODUCERS[name] (IC §3.25)', () => {
  it('produces that differs from the producer list: boot rejects naming produces and the module', async () => {
    const msg = await bootError('wrong-produces');
    expect(msg).toContain('produces');
    expect(msg).toContain('catalog');
  });

  it('manifest without produces: boot rejects', async () => {
    expect(await bootError('no-produces')).toContain('produces');
  });

  it('identity (no producer rows in IC §3.25) boots with produces: [] (positive control, see ok/)', async () => {
    const app = await boot('ok');
    expect((await app.inject({ method: 'GET', url: '/v1/identity/probe' })).statusCode).toBe(200);
  });
});

describe('autoloader validation (02-TRD §6.3) — each failure is a boot failure that names the offender', () => {
  it('manifest.name must equal its directory', async () => {
    const msg = await bootError('name-mismatch');
    expect(msg).toContain('catalog');
    expect(msg).toContain('lab');
  });

  it('spec file must exist', async () => {
    expect(await bootError('missing-spec')).toContain('nope.yaml');
  });

  it('openapi must be exactly contracts/openapi/<name>.yaml — no path traversal even when the target exists', async () => {
    const msg = await bootError('traversal');
    expect(msg).toContain('openapi');
    expect(msg).toContain('catalog');
  });

  it('claimsResolver is accepted only from module identity', async () => {
    const msg = await bootError('claims-resolver');
    expect(msg).toContain('claimsResolver');
    expect(msg).toContain('catalog');
  });

  it('ports must be a subset of the ports the module owns (PORT_OWNERS)', async () => {
    const msg = await bootError('foreign-port');
    expect(msg).toContain('BillingPort');
    expect(msg).toContain('catalog');
  });

  it('a failed boot leaves no half-mounted state: a second, valid boot in the same process works', async () => {
    await bootError('missing-handler');
    const app = await boot('ok');
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things' })).statusCode).toBe(200);
  });
});

describe('core sample module (02-TRD §14): mounted only for LIMS_CORE_ENV=ci + LIMS_CORE_LOAD_SAMPLE_MODULE=1', () => {
  const sampleSpec = () =>
    readFileSync(fileURLToPath(new URL('../__fixtures__/sample.yaml', import.meta.url)), 'utf8');
  /** First "<METHOD> <path>" declared by the sample spec, path params replaced by a literal. */
  const firstRoute = (): { method: string; url: string } => {
    const lines = sampleSpec().replace(/\r\n/g, '\n').split('\n');
    const i = lines.findIndex((l) => /^ {2}\/\S*:\s*$/.test(l));
    expect(i, 'sample.yaml declares a path').toBeGreaterThan(-1);
    const path = lines[i]!.trim().slice(0, -1).replace(/\{[^}]+\}/g, 'x');
    const m = lines.slice(i + 1).find((l) => /^ {4}(get|post|put|patch|delete):/.test(l));
    expect(m, 'sample.yaml first path has a method').toBeTruthy();
    return { method: m!.trim().slice(0, -1).toUpperCase(), url: path };
  };

  it('sample module and its spec exist with the 3.0.3 header', () => {
    expect(sampleSpec()).toMatch(/^openapi:\s*['"]?3\.0\.3/m);
    expect(sampleSpec()).toMatch(/operationId:/);
  });

  it('ci + flag: sample module mounts (done_when: sample module mounts)', async () => {
    const app = await bootstrap({ config: cfg({ LIMS_CORE_LOAD_SAMPLE_MODULE: '1' }) });
    try {
      const r = await app.inject(firstRoute());
      expect(r.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['ci without the flag', 'ci', {}],
    ['ci with flag=0', 'ci', { LIMS_CORE_LOAD_SAMPLE_MODULE: '0' }],
    ['staging with flag=1', 'staging', { LIMS_CORE_LOAD_SAMPLE_MODULE: '1' }],
    ['production with flag=1', 'production', { LIMS_CORE_LOAD_SAMPLE_MODULE: '1' }],
  ])('%s: sample module is NOT mounted', async (_n, env, extra) => {
    const app = await bootstrap({ config: cfg({ LIMS_CORE_ENV: env, ...extra }) });
    try {
      const r = await app.inject(firstRoute());
      expect(r.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

function fixturesShared(): string {
  return fileURLToPath(new URL('./fixtures/shared', import.meta.url)).replace(/[\\/]$/, '');
}
