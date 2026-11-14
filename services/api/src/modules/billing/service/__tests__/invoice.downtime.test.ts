// BL-T06 LD-25 (2026-11-07, A33-2 downtime mode): back-entry limits on invoice issue. Binding lead decision; it overrides the spec text for this task.
//   back-entry needs `occurred_at` (<= now and >= now - downtime_backentry_max_hours, tenant setting, default 72) and `downtime_ref` (paper form serial, <= 32 chars);
//   the server keeps its own created_at, audits both, no back-dating of anything else; the invoice is issued at back-entry time (issued_at = allocation time) with the paper
//   receipt number in downtime_ref; the tax treatment of hand-written bills is UNVERIFIED and NOTHING goes to CBMS with a back-dated date. "Tests for each limit."
// Fails now: ../invoice.service.js does not exist.
// ASSUMED API (spec silent; writer: object via a dispute if wrong):
//   issue(ctx, { ...issueInput, entry?: { mode: 'live' | 'downtime_backentry', occurredAt?: IsoUtc, downtimeRef?: string } })   (absent entry = live)
//   limit setting: IdentityPort.getTenantSettings(ctx, { keys: [..., 'downtime_backentry_max_hours'] }) -> { downtime_backentry_max_hours?: number }  (absent -> 72)
//   violations -> 400 common.validation_failed with errors[].path '/entry/occurred_at' | '/entry/downtime_ref' | '/entry/mode'; nothing stored, counter untouched.
//   audit: the single activity row (action invoice_issued) carries details { entry_mode: 'downtime_backentry', occurred_at, downtime_ref }; live issues carry none of the three.
//   There is NO invoices column for the two values in 05-SCHEMA (writer: file a CR if the invoice row must hold downtime_ref).
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
import { BASE, errCode, issueInput, makeWorld, type World } from './t06.helpers.js';

const NOW = Date.parse(BASE);
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3600_000;
const svcOf = (w: World) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const backentry = (occurredAt?: string, downtimeRef?: string, mode: string = 'downtime_backentry') =>
  ({ entry: { mode, ...(occurredAt === undefined ? {} : { occurredAt }), ...(downtimeRef === undefined ? {} : { downtimeRef }) } });
async function run(w: World, over: Record<string, unknown>) {
  const ctx = w.ctx(); const svc = svcOf(w); const input = await issueInput(ctx, over);
  return w.tx(() => svc.issue(ctx, input as never));
}
const refused = async (w: World, over: Record<string, unknown>, path: string) => {
  const e = await errCode(run(w, over));
  expect(e.code).toBe('common.validation_failed'); expect(e.statusCode ?? 400).toBe(400);
  expect((e.errors ?? []).map((x: { path: string }) => x.path)).toContain(path);
  expect(w.counterCalls).toEqual([]); expect(w.s.invoices).toEqual([]); expect(w.s.activity).toEqual([]); expect(w.s.cbms).toEqual([]); expect(w.db.events).toEqual([]); expect(w.db.jobs).toEqual([]);
};

describe('accepted back-entry', () => {
  it('occurred_at 2 h ago + downtime_ref "PB-0042": issued at SERVER time, balance/invoice events normal, audit row carries entry_mode/occurred_at/downtime_ref', async () => {
    const w = makeWorld();
    const occurred = iso(NOW - 2 * H);
    const ref = await run(w, backentry(occurred, 'PB-0042'));
    expect(ref.issuedAt).not.toBe(occurred);
    expect(Date.parse(ref.issuedAt)).toBeGreaterThanOrEqual(NOW);           // server clock, never the paper time
    expect(w.s.invoices[0].issued_at).toBe(ref.issuedAt);
    expect(w.s.invoices[0].created_at ?? ref.issuedAt).not.toBe(occurred);  // the server keeps its own created_at
    expect(w.s.activity).toHaveLength(1);
    expect(w.s.activity[0].details).toMatchObject({ entry_mode: 'downtime_backentry', occurred_at: occurred, downtime_ref: 'PB-0042' });
    expect(w.db.events.map((e) => e.eventType)).toEqual(['billing.invoice.issued.v1', 'billing.balance.changed.v1']);
  });
  it('nothing back-dated leaves the system: events and the CBMS job carry neither occurred_at nor downtime_ref; issued_at in the event is the server issue time', async () => {
    const w = makeWorld();
    const occurred = iso(NOW - 5 * H);
    const ref = await run(w, backentry(occurred, 'PB-0043'));
    const blob = JSON.stringify([w.db.events.map((e) => e.envelope.payload), w.s.cbms]);
    expect(blob).not.toContain(occurred); expect(blob).not.toContain('PB-0043'); expect(blob).not.toContain('downtime');
    expect(w.events_of('billing.invoice.issued.v1')[0]!.envelope.payload.issued_at).toBe(ref.issuedAt);
    expect(w.s.invoices[0].invoice_date_bs.startsWith('2083-')).toBe(true);
  });
  it('live issue (no entry, or mode live): audit row has no downtime keys', async () => {
    for (const over of [{}, { entry: { mode: 'live' } }]) {
      const w = makeWorld(); await run(w, over);
      expect(Object.keys(w.s.activity[0].details ?? {}).filter((k) => /downtime|entry_mode|occurred_at/.test(k))).toEqual([]);
    }
  });
});

describe('limit: occurred_at <= now', () => {
  it('exactly now is accepted; now + 1 ms is refused (path /entry/occurred_at)', async () => {
    await run(makeWorld(), backentry(iso(NOW), 'PB-1'));
    await refused(makeWorld(), backentry(iso(NOW + 1), 'PB-1'), '/entry/occurred_at');
  });
  it('a far-future time and an unparseable time are refused', async () => {
    for (const bad of [iso(NOW + 24 * H), 'yesterday', '2026-11-08', '2026-11-08T06:00:00+05:45', '']) await refused(makeWorld(), backentry(bad, 'PB-1'), '/entry/occurred_at');
  });
});

describe('limit: occurred_at >= now - downtime_backentry_max_hours (default 72)', () => {
  it('exactly 72 h ago is accepted; 72 h + 1 ms ago is refused', async () => {
    await run(makeWorld(), backentry(iso(NOW - 72 * H), 'PB-2'));
    await refused(makeWorld(), backentry(iso(NOW - 72 * H - 1), 'PB-2'), '/entry/occurred_at');
  });
  it('tenant setting 24 h: 23 h ago accepted, 25 h ago refused; the setting is read from IdentityPort for this request', async () => {
    const w = makeWorld({ tenantSettings: { downtime_backentry_max_hours: 24 } });
    await run(w, backentry(iso(NOW - 23 * H), 'PB-3'));
    expect(JSON.stringify(w.idCalls)).toContain('downtime_backentry_max_hours');
    await refused(makeWorld({ tenantSettings: { downtime_backentry_max_hours: 24 } }), backentry(iso(NOW - 25 * H), 'PB-3'), '/entry/occurred_at');
  });
  it('tenant setting larger than the default (96 h) is honoured: 90 h accepted, 100 h refused', async () => {
    await run(makeWorld({ tenantSettings: { downtime_backentry_max_hours: 96 } }), backentry(iso(NOW - 90 * H), 'PB-4'));
    await refused(makeWorld({ tenantSettings: { downtime_backentry_max_hours: 96 } }), backentry(iso(NOW - 100 * H), 'PB-4'), '/entry/occurred_at');
  });
  it('a nonsense setting (0, negative, NaN, text) never widens the window: falls back to the default 72 h (fail closed on the limit, not open)', async () => {
    for (const bad of [-5, Number.NaN, 'unlimited', null]) {
      await refused(makeWorld({ tenantSettings: { downtime_backentry_max_hours: bad } }), backentry(iso(NOW - 73 * H), 'PB-5'), '/entry/occurred_at');
    }
  });
});

describe('limit: occurred_at and downtime_ref are both required for back-entry', () => {
  it('missing occurred_at -> /entry/occurred_at; missing / empty / blank downtime_ref -> /entry/downtime_ref', async () => {
    await refused(makeWorld(), backentry(undefined, 'PB-6'), '/entry/occurred_at');
    for (const ref of [undefined, '', '   ']) await refused(makeWorld(), backentry(iso(NOW - H), ref), '/entry/downtime_ref');
  });
});

describe('limit: downtime_ref <= 32 characters', () => {
  it('32 chars accepted, 33 refused; counted in characters, not bytes (Devanagari ref of 32 accepted)', async () => {
    await run(makeWorld(), backentry(iso(NOW - H), 'R'.repeat(32)));
    await run(makeWorld(), backentry(iso(NOW - H), 'क'.repeat(32)));
    await refused(makeWorld(), backentry(iso(NOW - H), 'R'.repeat(33)), '/entry/downtime_ref');
  });
  it('a non-string ref is refused', async () => {
    for (const bad of [42, {}, ['PB-1']]) await refused(makeWorld(), { entry: { mode: 'downtime_backentry', occurredAt: iso(NOW - H), downtimeRef: bad } }, '/entry/downtime_ref');
  });
});

describe('no back-dating of anything else', () => {
  it('a live entry carrying occurred_at or downtime_ref is refused (cannot back-date a normal invoice)', async () => {
    await refused(makeWorld(), { entry: { mode: 'live', occurredAt: iso(NOW - H) } }, '/entry/occurred_at');
    await refused(makeWorld(), { entry: { mode: 'live', downtimeRef: 'PB-7' } }, '/entry/downtime_ref');
  });
  it('an unknown mode is refused (/entry/mode)', async () => {
    await refused(makeWorld(), backentry(iso(NOW - H), 'PB-8', 'paper'), '/entry/mode');
  });
  it('input-level issued_at / created_at / invoice_date_bs overrides are ignored: the invoice carries server values', async () => {
    const w = makeWorld();
    const forged = '2020-01-01T00:00:00.000Z';
    const ref = await run(w, { ...backentry(iso(NOW - H), 'PB-9'), issuedAt: forged, issued_at: forged, createdAt: forged, invoiceDateBs: '2077-01-01' });
    expect(ref.issuedAt).not.toBe(forged); expect(w.s.invoices[0].issued_at).toBe(ref.issuedAt); expect(w.s.invoices[0].invoice_date_bs).not.toBe('2077-01-01');
  });
});
