// C6-T44 (tester) — API half of the "Final sweep second touch" (02-TRD §14 row "Final sweep"): (c) D-48 delivery_created_at on EVERY reporting.delivery.status_changed.v1,
// (d) D-129 / CR-C17-014 seed row, (c) the v_pub_delivery_daily cohort anchor (static over the migration; the live-DB cases are in db/tests/reporting), (e) P-42 commitOnError in
// redeemPortalLinkForApp (behaviour is in reportingport.t37.test.ts; here the static contract that the call sits on every no-row path and nothing else writes).
// Event payloads are checked against contracts/events/reporting.delivery.status_changed.v1.schema.json (03-IC §3.18): required present, no unknown key, delivery_created_at IsoUtc.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';
import { insertDelivery, publishTransition, recordPrintDelivery } from '../service/delivery.service.js';

const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const SCHEMA = JSON.parse(read('contracts/events/reporting.delivery.status_changed.v1.schema.json'));
const payloadSchema = SCHEMA.$defs.Payload as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TENANT = '0190a000-0000-7000-8000-00000000aaaa'; const D = '0190a000-0000-7000-8000-0000000d0001'; const REP = '0190a000-0000-7000-8000-0000000e0001';

function rig(startedAt = new Date('2026-11-07T10:30:00.000Z')) {
  const events: { type: string; input: any }[] = [];
  const tx = { startedAt, query: async (sql: string) => (/INSERT INTO reporting\.deliveries/i.test(sql) ? { rows: [{ id: D, status: 'queued', failure_code: null }] } : { rows: [] }) };
  const ctx: any = { tenantId: TENANT, requestId: 'r1', tx, actor: { type: 'system', id: 'a1' }, events: { publish: async (_c: unknown, type: string, input: unknown) => { events.push({ type, input }); } } };
  return { ctx, events };
}
const validates = (p: Record<string, unknown>) => {
  for (const k of payloadSchema.required ?? []) expect(p, `required ${k}`).toHaveProperty(k);
  for (const k of Object.keys(p)) expect(Object.keys(payloadSchema.properties), `unknown payload key ${k}`).toContain(k);
};
const base = { id: D, centreId: null, channel: 'sms', purpose: 'report_ready', templateCode: 'reporting.report_ready', recipientKind: 'patient', recipientId: null, destinationMasked: null, destinationSha256: null, destinationE164: null,
  params: {}, idempotencyKey: 'k1', relatedType: 'report', relatedId: REP, reportId: REP, reportVersionNo: 1, failureCode: null } as const;

describe('D-48: delivery_created_at on every reporting.delivery.status_changed.v1 (additive optional in 03-IC §3.18, always set by C6)', () => {
  it('the schema declares delivery_created_at as optional IsoUtc (not required)', () => {
    expect(Object.keys(payloadSchema.properties)).toContain('delivery_created_at'); expect(payloadSchema.required ?? []).not.toContain('delivery_created_at');
  });
  it.each(['queued', 'suppressed'] as const)('creation (status %s): delivery_created_at = the row creation instant', async (status) => {
    const { ctx, events } = rig(); await insertDelivery(ctx, { ...base, status });
    expect(events).toHaveLength(1); const p = events[0]!.input.payload; validates(p);
    expect(p.delivery_created_at).toBe('2026-11-07T10:30:00.000Z'); expect(p.delivery_created_at).toMatch(ISO);
  });
  it('fallback delivery creation carries its OWN creation instant plus fallback_of_delivery_id', async () => {
    const { ctx, events } = rig(new Date('2026-11-07T11:00:00.000Z')); await insertDelivery(ctx, { ...base, channel: 'sms', status: 'queued', fallbackOfDeliveryId: '0190a000-0000-7000-8000-0000000d0002' });
    const p = events[0]!.input.payload; validates(p); expect(p.fallback_of_delivery_id).toBeDefined(); expect(p.delivery_created_at).toBe('2026-11-07T11:00:00.000Z');
  });
  it('print delivery (created directly in sent): delivery_created_at set', async () => {
    const { ctx, events } = rig(); await recordPrintDelivery(ctx, { id: D, printJobId: 'pj1', centreId: null, patientId: '0190a000-0000-7000-8000-0000000b0001', reportId: REP, reportVersionNo: 1 });
    const p = events[0]!.input.payload; validates(p); expect(p).toMatchObject({ channel: 'print', to_status: 'sent', delivery_created_at: '2026-11-07T10:30:00.000Z' });
  });
  const createdAt = new Date('2026-11-06T18:00:00.000Z');   // created the day BEFORE the transition (cohort case: delivered on day 2)
  it.each([['queued', 'sent'], ['sent', 'delivered'], ['delivered', 'read'], ['sent', 'failed'], ['failed', 'queued'], ['queued', 'failed']] as const)(
    'transition %s -> %s (sent, delivered, read, failed, retry): delivery_created_at = deliveries.created_at, not the change time', async (from, to) => {
      const { ctx, events } = rig(); const row = { id: D, channel: 'sms', purpose: 'report_ready', recipient_kind: 'patient', status: from, report_id: REP, report_version_no: 1, created_at: createdAt };
      await publishTransition(ctx, row, to, { seq: 3, at: '2026-11-07T10:30:00.000Z', attemptNo: 2, ...(to === 'failed' ? { failureCode: 'reporting.provider_error' } : {}) });
      const p = events[0]!.input.payload; validates(p);
      expect(p.delivery_created_at).toBe('2026-11-06T18:00:00.000Z'); expect(p.changed_at).toBe('2026-11-07T10:30:00.000Z'); expect(p.delivery_created_at).not.toBe(p.changed_at);
    });
  it('a pg timestamptz string / Date created_at both normalise to the same IsoUtc', async () => {
    const { ctx, events } = rig(); const row = { id: D, channel: 'email', purpose: 'report_ready', recipient_kind: 'patient', status: 'queued', created_at: '2026-11-06T18:00:00.000Z' };
    await publishTransition(ctx, row, 'sent', { seq: 2, at: '2026-11-07T10:30:00.000Z', attemptNo: 1 }); expect(events[0]!.input.payload.delivery_created_at).toMatch(ISO);
  });
  it('static: the only publishers of reporting.delivery.status_changed.v1 in api+worker reporting code both set delivery_created_at', () => {
    const src = read('services/api/src/modules/reporting/service/delivery.service.ts');
    expect(src.match(/publish\([^)]*'reporting\.delivery\.status_changed\.v1'/g) ?? []).toHaveLength(2); expect((src.match(/delivery_created_at:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('D-48: reporting.v_pub_delivery_daily anchors every count on deliveries.created_at (cohort) and groups by centre_id (static; live-DB cases in db/tests/reporting)', () => {
  const mig = read('db/migrations/20261105001900_reporting__create_reporting_schema.sql');
  const view = mig.slice(mig.indexOf('CREATE VIEW reporting.v_pub_delivery_daily'), mig.indexOf('GRANT SELECT ON reporting.v_pub_report_release'));
  it('business_date derives from created_at only; no count uses queued_at/sent_at/... as its date anchor', () => {
    expect(view).toMatch(/d\.created_at AT TIME ZONE 'Asia\/Kathmandu'/);
    expect(view.replace(/FILTER \(WHERE d\.\w+_at\s+IS NOT NULL\)/g, '')).not.toMatch(/(queued|sent|delivered|read|failed|suppressed)_at AT TIME ZONE/);
  });
  it('centre_id is selected and is a GROUP BY key (NULL centre -> its own row)', () => { expect(view).toMatch(/d\.centre_id\s+FROM/s); expect(view).toMatch(/GROUP BY[^;]*d\.centre_id/s); });
  it('security_invoker view (FORCE RLS of reporting.deliveries applies to the caller)', () => { expect(view).toMatch(/security_invoker\s*=\s*true/); });
});

describe('D-129 / CR-C17-014: seed template homecollection.visit_scheduled', () => {
  const seed = read('db/seeds/004_reporting__g_message_templates.sql');
  const line = seed.split(/\r?\n/).find((l) => l.includes("'homecollection.visit_scheduled'")) ?? '';
  it('exists once: purpose booking_confirmation, channel sms only, params window_start_local + window_end_local short_text, nothing else', () => {
    expect(seed.match(/'homecollection\.visit_scheduled'/g)).toHaveLength(1);
    expect(line).toContain("'booking_confirmation'"); expect(line).toContain("ARRAY['sms']");
    const params = JSON.parse(/'(\[\{.*?\}\])'/.exec(line)?.[1] ?? '[]') as { name: string; kind: string }[];
    expect(params).toEqual([{ name: 'window_start_local', kind: 'short_text' }, { name: 'window_end_local', kind: 'short_text' }]);   // no lab_name (D-129)
  });
});

describe('P-42: redeemPortalLinkForApp keeps the failure counter through the failing request (static contract; behaviour in reportingport.t37.test.ts)', () => {
  const impl = read('services/api/src/modules/reporting/ports/ReportingPort.impl.ts');
  const body = impl.slice(impl.indexOf('async redeemPortalLinkForApp'));
  it('commitOnError is called on the no-row / other-tenant path BEFORE throwing reporting.link_invalid, and only on that path', () => {
    expect(body).toMatch(/commitOnError\?\.\(\)\s*;\s*throw new LimsError\('reporting\.link_invalid'\)/);
    expect((body.slice(0, body.indexOf('\n    },') > 0 ? body.indexOf('\n    },') : undefined).match(/commitOnError/g) ?? []).length).toBe(1);
  });
  it('the path makes no write of its own: only the DEFINER call (app.reporting_redeem_link_for_app) touches the DB', () => {
    const fn = body.slice(0, body.indexOf('\n    },') > 0 ? body.indexOf('\n    },') : undefined);
    expect(fn).toMatch(/app\.reporting_redeem_link_for_app/); expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
