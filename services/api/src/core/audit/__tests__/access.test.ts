// T0D-08 ctx.audit.access (02-TRD §6.9, 08 R20). Contract assumed (see .orchestra/notes/T0D-08-tests.md):
//   services/api/src/core/audit/access.ts exports access(ctx, entry): Promise<void>; the HandlerContext binds ctx per request.
//   It INSERTs one audit.access_log row on ctx.tx (so it commits/rolls back with the action) and validates the entry first.
import { describe, expect, it } from 'vitest';
import { access } from '../access.js';

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const USER = '0190a000-0000-7000-8000-00000000a001';
const MEMBERSHIP = '0190a000-0000-7000-8000-00000000a002';
const REQ = '0190a000-0000-7000-8000-0000000000f1';
const ENTITY = '0190a000-0000-7000-8000-0000000000d1';
const CENTRE = '0190a000-0000-7000-8000-0000000000c1';

function fake() {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const tx = { startedAt: new Date(Date.UTC(2026, 10, 7, 12)), async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: [] }; } };
  return { stmts, ctx: { tenantId: TENANT, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, requestId: REQ, tx, now: () => '2026-11-07T12:00:00.000Z', ports: {} } };
}
const entry = (over: Record<string, unknown> = {}) => ({ action: 'report.view', entityType: 'report_version', entityId: ENTITY, centreId: CENTRE, outcome: 'allowed', ...over });
const call = (ctx: unknown, e: unknown) => (access as any)(ctx, e) as Promise<void>;
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

describe('ctx.audit.access', () => {
  it('inserts one audit.access_log row in the current transaction with tenant, actor, request and entry values', async () => {
    const f = fake();
    await call(f.ctx, entry({ purpose: 'demographics_lookup', detail: { page: 2, exported: false, format: 'pdf' } }));
    expect(f.stmts).toHaveLength(1);
    const { text, values } = f.stmts[0]!;
    expect(text).toMatch(/INSERT\s+INTO\s+audit\.access_log/i);
    for (const want of [TENANT, USER, 'user', MEMBERSHIP, REQ, 'report.view', 'report_version', ENTITY, CENTRE, 'allowed', 'demographics_lookup']) {
      expect(values, String(want)).toContain(want);
    }
    expect(JSON.stringify(values)).toContain('"page":2');
  });

  it('records a denied outcome (the handler adds ctx.commitOnError so the row survives)', async () => {
    const f = fake();
    await call(f.ctx, entry({ outcome: 'denied' }));
    expect(f.stmts[0]!.values).toContain('denied');
  });

  it('optional fields may be omitted', async () => {
    const f = fake();
    await call(f.ctx, { action: 'data.export', entityType: 'order', outcome: 'allowed' });
    expect(f.stmts).toHaveLength(1);
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ['action not matching ^[a-z_]+\\.[a-z_]+$', { action: 'Report View' }],
    ['action with an upper-case letter', { action: 'report.View' }],
    ['empty entityType', { entityType: '' }],
    ['entityType over 40 chars', { entityType: 'e'.repeat(41) }],
    ['outcome other than allowed|denied', { outcome: 'maybe' }],
    ['entityId that is not a UUID', { entityId: 'x' }],
    ['detail with a nested object (values must be string|number|boolean)', { detail: { patient: { name: 'Synthetic' } } }],
    ['detail over 4096 bytes', { detail: { blob: 'x'.repeat(5000) } }],
  ];
  for (const [name, over] of bad) {
    it(`rejects ${name} before any SQL`, async () => {
      const f = fake();
      await rejects(call(f.ctx, entry(over)));
      expect(f.stmts).toHaveLength(0);
    });
  }

  it('binds every value (no entry text is concatenated into the SQL)', async () => {
    const f = fake();
    await call(f.ctx, entry({ detail: { note: "x'); DROP TABLE audit.access_log;--" } }));
    expect(f.stmts[0]!.text).not.toMatch(/DROP TABLE/i);
    expect(f.stmts[0]!.text).not.toContain(ENTITY);
  });
});
