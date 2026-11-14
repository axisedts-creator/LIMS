// C6-T04 — the reporting consumers wired through the real worker core (02-TRD §7.2/§7.3, §8.2; AC-01.2 inbox dedupe; "unknown fields" fixtures).
// Needs: ../index.ts `manifest.subscriptions` carrying the 8 handlers of this task; no ports are injected by the core fake, so only
// consumers that need none (approved / amended / specimen / catalog) are run here.
import { describe, expect, it } from 'vitest';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { catalogChanged, resultAmended, resultApproved, specimenStatus, TENANT_A } from './consumers.helpers.js';

const TYPES = [
  'frontdesk.order.created.v1', 'frontdesk.order.items_changed.v1', 'frontdesk.order.cancelled.v1', 'lab.specimen.status_changed.v1',
  'lab.result.approved.v1', 'lab.result.amended.v1', 'lab.order.ready_for_report.v1', 'catalog.changed.v1',
] as const;
const task = (t: string) => `evt.reporting.${t}`;
const payloadOf = (e: any) => ({ tenant_id: TENANT_A, event_id: e.event_id, event_type: e.event_type });
const reportingStmts = (tx: { stmts: Array<{ text: string }> }) => tx.stmts.filter((s) => /\breporting\.(?!event_inbox)/i.test(s.text));

describe('reporting manifest wiring (C6-T04)', () => {
  it.each(TYPES)('subscribes to %s with a handler, registered as evt.reporting.<type>', async (t) => {
    expect(typeof manifest.subscriptions?.[t]).toBe('function');
    const s = await setup([manifest]);
    expect(s.entry(task(t)), `registry entry ${task(t)}`).toBeDefined();
  });
});

describe('inbox dedupe through the core wrapper (AC-01.2, done_when: duplicate event_id is a no-op)', () => {
  it('lab.result.approved.v1 delivered twice: the second delivery commits without touching reporting tables', async () => {
    const s = await setup([manifest]);
    const ev = resultApproved();
    s.world.seedEvent(ev);
    await s.run(task(ev.event_type), payloadOf(ev));
    expect(reportingStmts(s.world.txLog.at(-1)!).length).toBeGreaterThan(0);
    await expect(s.run(task(ev.event_type), payloadOf(ev), { attempts: 2 })).resolves.toBeUndefined();
    expect(s.world.txLog.at(-1)!.outcome).toBe('commit');
    expect(reportingStmts(s.world.txLog.at(-1)!)).toHaveLength(0);
    expect(s.world.inbox.filter((r) => r.module === 'reporting')).toEqual([{ module: 'reporting', tenant_id: TENANT_A, event_id: ev.event_id }]);
  });

  it('two concurrent deliveries of lab.result.amended.v1 apply once', async () => {
    const s = await setup([manifest]);
    const ev = resultAmended();
    s.world.seedEvent(ev);
    await Promise.all([s.run(task(ev.event_type), payloadOf(ev), { id: '1' }), s.run(task(ev.event_type), payloadOf(ev), { id: '2' })]);
    const applied = s.world.txLog.filter((t) => reportingStmts(t).length > 0);
    expect(applied).toHaveLength(1);
    expect(s.world.inbox.filter((r) => r.module === 'reporting')).toHaveLength(1);
  });
});

describe('unknown fields and extensible enums through the core validator (02-CV §7.2, 08 R13)', () => {
  it('unknown envelope + payload fields are dropped by the wrapper and the consumer succeeds', async () => {
    const s = await setup([manifest]);
    const ev = specimenStatus('rejected', 3, undefined, { x_envelope_future: 'v2' }); ev.payload.x_payload_future = { a: 1 };
    s.world.seedEvent(ev);
    await expect(s.run(task(ev.event_type), payloadOf(ev))).resolves.toBeUndefined();
    expect(s.world.txLog.at(-1)!.outcome).toBe('commit');
    expect(s.world.inbox.some((r) => r.module === 'reporting' && r.event_id === ev.event_id)).toBe(true);
  });

  it('catalog.changed.v1 with an entity_type this build does not know is processed, not dead-lettered', async () => {
    const s = await setup([manifest]);
    const ev = catalogChanged('future_entity_type');
    s.world.seedEvent(ev);
    await expect(s.run(task(ev.event_type), payloadOf(ev))).resolves.toBeUndefined();
    expect(s.world.deadLetters).toHaveLength(0);
    expect(s.world.inbox.some((r) => r.module === 'reporting' && r.event_id === ev.event_id)).toBe(true);
  });

  it('every consumer statement runs under the reporting system actor and the job tenant', async () => {
    const s = await setup([manifest]);
    const ev = resultApproved();
    s.world.seedEvent(ev);
    await s.run(task(ev.event_type), payloadOf(ev));
    const tx = s.world.txLog.at(-1)!;
    expect(tx.claims0).toMatchObject({ tenant_id: TENANT_A, actor_type: 'system' });
    for (const st of reportingStmts(tx)) expect(st.text).toMatch(/\btenant_id\b/);
  });
});
