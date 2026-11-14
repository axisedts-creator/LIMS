// FD-T10 wiring of frontdesk.trf_scan + frontdesk.trf_draft_purge (02-TRD §3.3, §10; 08 A13 P-6, P-12 a). No DB.
// 02-TRD §10: trf_scan = enqueued by uploadTrf, tenant scope, 5 attempts (NOT a cron). trf_draft_purge = cron `15 * * * *`, per_tenant, 3 attempts.
// ASSUMED (spec silent; the writer disputes if wrong): tasks/trf_scan.ts exports `TRF_SCAN` + `trfScan`; tasks/trf_draft_purge.ts exports `TRF_DRAFT_PURGE` + `trfDraftPurge`;
// payload = { tenant_id } for the purge, { tenant_id, attachment_id } for the scan; a payload whose tenant_id is missing or differs from ctx.tenantId runs NO statement and no storage / scanner call.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';

const SCAN = 'frontdesk.trf_scan', PURGE = 'frontdesk.trf_draft_purge', EXPIRE = 'frontdesk.discount_approval_expire';
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001', TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;

function ctxOf(tenantId: string | undefined) {
  const stmts: string[] = [], calls: string[] = [];
  const tx = { async query(text: string) { stmts.push(text); return { rows: [] }; } };
  const ctx: any = {
    tenantId, tx, actor: { type: 'system', id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' }, requestId: 'r', attempt: 1, maxAttempts: 5, jobId: '1',
    now: () => '2026-11-11T12:00:00.000Z', isNewer: () => true, events: {}, core: {}, audit: {},
    storage: new Proxy({}, { get: (_t, p) => async () => { calls.push(`storage.${String(p)}`); return new Uint8Array(); } }),
    files: { scan: async () => { calls.push('files.scan'); return 'clean'; } },
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts, calls };
}

describe('manifest + crontab (02-TRD §3.3, §10)', () => {
  it('registers both tasks next to discount_approval_expire and the manifest still validates', async () => {
    const m = await manifest();
    expect(typeof m.tasks[SCAN]).toBe('function');
    expect(typeof m.tasks[PURGE]).toBe('function');
    expect(typeof m.tasks[EXPIRE]).toBe('function');
    expect(() => validateManifests([m])).not.toThrow();
  });
  it('trf_scan: 5 attempts, enqueued by uploadTrf (no cron entry)', async () => {
    const m = await manifest();
    expect(m.maxAttempts[SCAN]).toBe(5);
    expect((m.crontab as any[]).filter((c) => c.identifier === SCAN)).toEqual([]);
  });
  it('trf_draft_purge: cron 15 * * * *, per_tenant (P-6), 3 attempts, exactly one entry', async () => {
    const m = await manifest(); const c = (m.crontab as any[]).filter((x) => x.identifier === PURGE);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ schedule: '15 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 });
    expect(m.maxAttempts[PURGE]).toBe(3);
  });
  it('cron.ts still exports the crontab the manifest uses (the approval-expire entry is kept)', async () => {
    const m = await manifest(); const cron: any = await import('../cron.js');
    expect(cron.crontab).toBe(m.crontab);
    expect((m.crontab as any[]).some((c) => c.identifier === EXPIRE)).toBe(true);
  });
  it('the task files export the identifiers and handlers the manifest registers', async () => {
    const m = await manifest();
    const s: any = await import('../tasks/trf_scan.js'), p: any = await import('../tasks/trf_draft_purge.js');
    expect(s.TRF_SCAN).toBe(SCAN); expect(s.trfScan).toBe(m.tasks[SCAN]);
    expect(p.TRF_DRAFT_PURGE).toBe(PURGE); expect(p.trfDraftPurge).toBe(m.tasks[PURGE]);
  });
});

describe.each([[SCAN, (t: string) => ({ tenant_id: t, attachment_id: '01a1a98a-ac40-7000-8000-00000000f001' })], [PURGE, (t: string) => ({ tenant_id: t })]] as const)('%s tenant guard (REQ-SEC-024)', (id, payloadOf) => {
  it('payload tenant_id missing, malformed or different from the job tenant -> no statement, no storage call, no scan, no throw', async () => {
    const m = await manifest();
    for (const payload of [{}, payloadOf(TENANT_B), { ...payloadOf(TENANT_A), tenant_id: 'not-a-uuid' }]) {
      const { ctx, stmts, calls } = ctxOf(TENANT_A);
      await m.tasks[id](payload, ctx);
      expect(stmts).toEqual([]); expect(calls).toEqual([]);
    }
  });
  it('a job without a tenant scope runs nothing', async () => {
    const m = await manifest(); const { ctx, stmts, calls } = ctxOf(undefined);
    await m.tasks[id](payloadOf(TENANT_A), ctx);
    expect(stmts).toEqual([]); expect(calls).toEqual([]);
  });
});

describe('trf_scan input validation', () => {
  it('a malformed attachment_id is refused before any statement or storage call (throws or resolves, never touches data)', async () => {
    const m = await manifest();
    for (const attachment_id of [undefined, 'nope', 42, "x'; DROP TABLE frontdesk.trf_attachments;--"]) {
      const { ctx, stmts, calls } = ctxOf(TENANT_A);
      await Promise.resolve(m.tasks[SCAN]({ tenant_id: TENANT_A, attachment_id }, ctx)).catch(() => undefined);
      expect(stmts).toEqual([]); expect(calls).toEqual([]);
    }
  });
});
