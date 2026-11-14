// C7 API-T06 — E02 getAgentConfig + E08 downloadAgentRelease (02-TRD §5.10/§5.11/§7.2; 07-SECURITY E02/E08 row, S-05, S-09 server half).
// Fails now because ../service/releases.service.js does not exist. SEAMS: device.helpers.ts header. E08 reads real files from a temp releasesDir.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { responseViolations } from './agents.contract.js';
import { AGENT_X, CENTRE_A1, NOW, TENANT_B, activeAgent, configRow, idN, makeDeviceCtx, makeRepo, rejection, releaseRow, sha, signatureVerifies, TEST_KEY_ID } from './device.helpers.js';

const { createReleasesService } = await import('../service/releases.service.js');
const dir = mkdtempSync(join(tmpdir(), 'lims-c7-rel-')); afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mk = (seed: Parameters<typeof makeRepo>[0]) => { const f = makeRepo(seed); return { f, svc: createReleasesService({ repo: f.repo as any, releasesDir: dir, now: () => new Date(NOW) }) }; };
const dev = (o: Parameters<typeof makeDeviceCtx>[0] = {}) => makeDeviceCtx(o).ctx;

describe('E02 getAgentConfig', () => {
  const seed = () => ({ agents: [activeAgent({ latest_config_version: 2 })], configs: [configRow(AGENT_X, CENTRE_A1, 1), configRow(AGENT_X, CENTRE_A1, 2)] });
  it('200 {alg, key_id, signature, document} of the NEWEST version; schema-valid; signature verifies over canonical(document)', async () => {
    const { svc } = mk(seed());
    const r = await svc.getAgentConfig(dev());
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['alg', 'document', 'key_id', 'signature']);
    expect(r.body).toMatchObject({ alg: 'Ed25519', key_id: TEST_KEY_ID });
    expect(r.body.document).toMatchObject({ agent_id: AGENT_X, centre_id: CENTRE_A1, config_version: 2, schema: 'lims.bridge.config.v1' });
    expect(signatureVerifies(r.body.document, r.body.signature)).toBe(true);
    expect(responseViolations('getAgentConfig', '200', r.body)).toEqual([]);
  });
  it('no internal columns leak (id, tenant_id, canonical_sha256, created_by, reason)', async () => {
    const r = await mk(seed()).svc.getAgentConfig(dev());
    expect(JSON.stringify(r.body)).not.toMatch(/canonical_sha256|tenant_id|created_by|"reason"/);
  });
  it('the document is returned byte-for-byte as stored (a re-serialisation would break the signature)', async () => {
    const s = seed(); const r = await mk(s).svc.getAgentConfig(dev());
    expect(r.body.document).toEqual(s.configs[1]!.document); expect(r.body.signature).toBe(s.configs[1]!.signature);
  });
  it('stored document for another agent or centre -> common.internal, never served (fail closed)', async () => {
    for (const bad of [{ agent_id: idN(0x1999) }, { centre_id: idN(0xc9) }]) {
      const cfg = configRow(AGENT_X, CENTRE_A1, 1); cfg.document = { ...cfg.document, ...bad };
      const e = await rejection(mk({ agents: [activeAgent()], configs: [cfg] }).svc.getAgentConfig(dev()));
      expect(e.code).toBe('common.internal');
    }
  });
  it('no stored config version -> common.internal (A1 always creates version 1)', async () => {
    expect((await rejection(mk({ agents: [activeAgent()], configs: [] }).svc.getAgentConfig(dev()))).code).toBe('common.internal');
  });
  it('a config row of another tenant with the same agent id is never read', async () => {
    const foreign = configRow(AGENT_X, CENTRE_A1, 9, { tenant: TENANT_B });
    const { svc, f } = mk({ agents: [activeAgent()], configs: [foreign, configRow(AGENT_X, CENTRE_A1, 1)] });
    expect((await svc.getAgentConfig(dev())).body.document.config_version).toBe(1);
    for (const c of f.calls) expect(c.tenantId).toBe(dev().tenantId);
  });
  it.each([['enrolment_code'], [null], ['x']])('credential kind %s -> 401 auth.device_token_invalid, no repo access (AC-01.6/S-05)', async (kind) => {
    const { svc, f } = mk(seed());
    const e = await rejection(svc.getAgentConfig(dev({ kind: kind as any })));
    expect(e.code).toBe('auth.device_token_invalid'); expect(f.calls).toHaveLength(0);
  });
  it.each([['revoked'], ['retired'], ['pending_enrolment']])('agent status %s -> 401 (a revoked agent cannot fetch config)', async (status) => {
    const e = await rejection(mk({ agents: [activeAgent({ status })], configs: [configRow(AGENT_X, CENTRE_A1, 1)] }).svc.getAgentConfig(dev()));
    expect(e.code).toBe('auth.device_token_invalid');
  });
  it('unknown agent / other tenant -> 401 (S-01)', async () => {
    const e = await rejection(mk({ agents: [activeAgent({ tenant_id: TENANT_B })], configs: [] }).svc.getAgentConfig(dev()));
    expect(e.code).toBe('auth.device_token_invalid');
  });
});

describe('E08 downloadAgentRelease', () => {
  const REL = idN(0x7001), OTHER = idN(0x7002);
  const PKG = Buffer.from('SYNTHETIC-PACKAGE-BYTES-0123456789');
  const rel = (o: Record<string, unknown> = {}) => releaseRow({ id: REL, package_file_name: 'bridge-agent-1.2.3-windows-amd64.zip', package_sha256: sha(PKG).toString('hex'), package_size: PKG.length, ...o });
  const seed = (o: { release?: Record<string, unknown>; target?: string | null; rels?: Array<Record<string, unknown>> } = {}) =>
    ({ agents: [activeAgent({ latest_config_version: 1 })], configs: [configRow(AGENT_X, CENTRE_A1, 1, { targetReleaseId: o.target === undefined ? REL : o.target })], releases: o.rels ?? [rel(o.release)] });
  writeFileSync(join(dir, 'bridge-agent-1.2.3-windows-amd64.zip'), PKG);

  it('200 octet-stream with the exact bytes, Content-Length and X-Package-Sha256 (matching the file)', async () => {
    const r = await mk(seed()).svc.downloadAgentRelease(dev(), { releaseId: REL });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body).equals(PKG)).toBe(true);
    const h = Object.fromEntries(Object.entries<string>(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['content-type']).toBe('application/octet-stream');
    expect(Number(h['content-length'])).toBe(PKG.length);
    expect(h['x-package-sha256']).toBe(sha(PKG).toString('hex'));
    expect(h['x-package-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    ['unknown release', { rels: [] as Array<Record<string, unknown>> }],
    ['inactive release', { release: { is_active: false } }],
    ['active release that is not the agent target', { target: OTHER, rels: [rel(), rel({ id: OTHER, version: '1.3.0' })] }],
    ['agent has no target', { target: null }],
  ])('%s -> 404 common.not_found, nothing read from disk', async (_n, o) => {
    const { svc } = mk(seed(o));
    const e = await rejection(svc.downloadAgentRelease(dev(), { releaseId: REL }));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
  });
  it('malformed release id -> 404 and the repo is not asked', async () => {
    const { svc, f } = mk(seed());
    for (const id of ['../etc/passwd', 'not-a-uuid', '', undefined, 7]) expect((await rejection(svc.downloadAgentRelease(dev(), { releaseId: id as any }))).code).toBe('common.not_found');
    expect(f.callsOf('findRelease')).toHaveLength(0);
  });
  it('404 body is identical for unknown, inactive and non-target (no oracle)', async () => {
    const out = new Set<string>();
    for (const o of [{ rels: [] as Array<Record<string, unknown>> }, { release: { is_active: false } }, { target: OTHER }]) {
      const e = await rejection(mk(seed(o)).svc.downloadAgentRelease(dev(), { releaseId: REL })); out.add(JSON.stringify([e.code, e.message, e.statusCode]));
    }
    expect(out.size).toBe(1);
  });
  it('file whose bytes do not match package_sha256 / package_size is never served (common.internal)', async () => {
    writeFileSync(join(dir, 'tampered.zip'), Buffer.from('TAMPERED'));
    for (const o of [{ package_file_name: 'tampered.zip' }, { package_file_name: 'bridge-agent-1.2.3-windows-amd64.zip', package_size: PKG.length + 1 }]) {
      const e = await rejection(mk(seed({ release: o })).svc.downloadAgentRelease(dev(), { releaseId: REL }));
      expect(e.code).toBe('common.internal');
    }
  });
  it('missing package file -> common.internal, message does not reveal the server path', async () => {
    const e = await rejection(mk(seed({ release: { package_file_name: 'gone.zip' } })).svc.downloadAgentRelease(dev(), { releaseId: REL }));
    expect(e.code).toBe('common.internal'); expect(String(e.message)).not.toContain(dir);
  });
  it('package_file_name that escapes releasesDir is refused without touching the file (path traversal)', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const outside = join(dir, '..', `lims-c7-outside-${process.pid}.bin`); writeFileSync(outside, PKG);
    try {
      for (const name of [`..${'/'}${outside.split(/[\\/]/).pop()}`, `..\\${outside.split(/[\\/]/).pop()}`, outside, 'sub/../../x.zip', 'a\0b.zip']) {
        const e = await rejection(mk(seed({ release: { package_file_name: name } })).svc.downloadAgentRelease(dev(), { releaseId: REL }));
        expect(e.code, name).toBe('common.internal');
      }
    } finally { rmSync(outside, { force: true }); }
  });
  it.each([['enrolment_code'], [null]])('credential kind %s -> 401 (AC-01.6)', async (kind) => {
    const e = await rejection(mk(seed()).svc.downloadAgentRelease(dev({ kind: kind as any }), { releaseId: REL }));
    expect(e.code).toBe('auth.device_token_invalid');
  });
  it('revoked agent -> 401, nothing served', async () => {
    const s = seed(); s.agents = [activeAgent({ status: 'revoked' })];
    expect((await rejection(mk(s).svc.downloadAgentRelease(dev(), { releaseId: REL }))).code).toBe('auth.device_token_invalid');
  });
});
