// FD-T06 LD-25 (2026-11-07, A33-2 downtime mode): back-entry of paper registrations. Binding lead decision; cited here because the chunk spec + contracts/openapi/frontdesk.yaml
// do NOT yet carry the fields (no entry_mode / occurred_at / downtime_ref in the request schema, no column, no setting) -> see .orchestra/notes/FD-T06-tests.md "LD-25 gaps".
// Tested at handler level (the core schema validator is not in this path): validation limits + acceptance + same-permission + "no back-dating of anything else".
// Limits: occurred_at <= now, >= now - downtime_backentry_max_hours (default 72, tenant setting not tested: no column), downtime_ref <= 32 chars, required for back-entry.
import { describe, expect, it } from 'vitest';
import { INVOICE_PERM, NOW, PERM, T, ordersOf, prepare, register, registerFails, orderRow } from './helpers.js';

const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const H = 3_600_000;
const back = (o: Record<string, unknown> = {}) => ({ entry_mode: 'downtime_backentry', occurred_at: iso(-2 * H), downtime_ref: 'PB-000123', ...o });

async function failsAt(extra: Record<string, unknown>, path: string) {
  const p = await prepare({ extra });
  const e = await registerFails(p.body, { w: p.w });
  expect(e.code).toBe('common.validation_failed');
  expect(e.statusCode).toBe(400);
  expect((e.errors ?? []).map((x: any) => x.path)).toContain(path);
  expect(await ordersOf(p.patient.id)).toHaveLength(0);
  expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
}

describe('LD-25 accepted back-entry', () => {
  it('2 h old paper form: 201, order registered, server audits entry_mode + downtime_ref; billing sees no back-dated instant (nothing back-dated is sent on)', async () => {
    const extra = back();
    const p = await prepare({ extra });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect((await orderRow(r.body.order.id)).status).toBe('registered');
    const audit = JSON.stringify(r.probe.accessCalls);                              // ASSUMED channel: ctx.audit.access detail (LD-25 "audits it")
    expect(audit).toContain('downtime_backentry');
    expect(audit).toContain('PB-000123');
    const wire = JSON.stringify(p.w.billingFake.calls('issueOrderInvoice')[0].input);
    expect(wire).not.toContain(extra.occurred_at);                                  // invoices are issued at back-entry time (LD-25); no back-dated timestamp to billing/CBMS
  }, T);
  it('entry_mode live (default) is unchanged', async () => {
    const p = await prepare({ extra: { entry_mode: 'live' } });
    expect((await register(p.body, { w: p.w })).status).toBe(201);
  }, T);
  it('boundaries are inclusive: occurred_at = now and occurred_at = now - 72 h; downtime_ref of exactly 32 chars', async () => {
    for (const extra of [back({ occurred_at: iso(0) }), back({ occurred_at: iso(-72 * H) }), back({ downtime_ref: 'x'.repeat(32) })]) {
      const p = await prepare({ extra });
      expect((await register(p.body, { w: p.w })).status).toBe(201);
    }
  }, T);
  it('same permission as the live action: cash back-entry without billing.invoice.issue -> 403; without registration.create -> 403', async () => {
    const p = await prepare({ extra: back() });
    expect((await registerFails(p.body, { w: p.w, grants: [PERM] })).code).toBe('auth.forbidden');
    expect((await registerFails(p.body, { w: p.w, grants: [INVOICE_PERM] })).code).toBe('auth.forbidden');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
});

describe('LD-25 limits (each one: 400 common.validation_failed with the field path, nothing stored)', () => {
  it('occurred_at missing for back-entry', () => failsAt({ entry_mode: 'downtime_backentry', downtime_ref: 'PB-1' }, '/occurred_at'), T);
  it('downtime_ref missing for back-entry', () => failsAt({ entry_mode: 'downtime_backentry', occurred_at: iso(-H) }, '/downtime_ref'), T);
  it('occurred_at in the future (now + 1 s)', () => failsAt(back({ occurred_at: iso(1000) }), '/occurred_at'), T);
  it('occurred_at older than the 72 h default window (now - 72 h - 1 s)', () => failsAt(back({ occurred_at: iso(-72 * H - 1000) }), '/occurred_at'), T);
  it('occurred_at not an ISO instant', () => failsAt(back({ occurred_at: 'yesterday' }), '/occurred_at'), T);
  it('downtime_ref longer than 32 chars (33)', () => failsAt(back({ downtime_ref: 'x'.repeat(33) }), '/downtime_ref'), T);
  it('downtime_ref empty', () => failsAt(back({ downtime_ref: '' }), '/downtime_ref'), T);
  it('unknown entry_mode', () => failsAt(back({ entry_mode: 'paper' }), '/entry_mode'), T);
  it('no back-dating of anything else: live (or default) entry carrying occurred_at / downtime_ref is refused', async () => {
    await failsAt({ occurred_at: iso(-H) }, '/occurred_at');
    await failsAt({ entry_mode: 'live', occurred_at: iso(-H), downtime_ref: 'PB-1' }, '/occurred_at');
    await failsAt({ downtime_ref: 'PB-1' }, '/downtime_ref');
  }, T);
});
