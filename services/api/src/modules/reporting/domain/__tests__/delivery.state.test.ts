// C6-T02 delivery.state.ts (03-IC §3.18; 02-TRD §4.8). Exhaustive 6x6.
// Assumed API: DELIVERY_STATUSES, canTransition(from,to,{channel?}) (channel defaults to 'whatsapp'; 'read' only from WhatsApp).
// Assumption: chain is strict (no queued->delivered, no sent->read); delivered counts as non-terminal so delivered->failed is allowed.
import { describe, expect, it } from 'vitest';
import { DELIVERY_STATUSES, canTransition } from '../delivery.state.js';

const ALLOWED: Record<string, string[]> = {
  queued: ['sent', 'failed'],
  sent: ['delivered', 'failed'],
  delivered: ['read', 'failed'],
  read: [],
  failed: ['queued'],
  suppressed: [],
};

describe('deliveries.status table', () => {
  it('has the six DB states', () => {
    expect([...DELIVERY_STATUSES].sort()).toEqual(['delivered', 'failed', 'queued', 'read', 'sent', 'suppressed']);
  });
  const pairs = DELIVERY_STATUSES.flatMap((f) => DELIVERY_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to, { channel: 'whatsapp' })).toBe(ALLOWED[from]!.includes(to));
  });
  it('suppressed is terminal at creation; read is terminal', () => {
    for (const to of DELIVERY_STATUSES) {
      expect(canTransition('suppressed', to)).toBe(false);
      expect(canTransition('read', to)).toBe(false);
    }
  });
  it('failed -> queued is the only way out of failed (retry)', () => {
    expect(DELIVERY_STATUSES.filter((t) => canTransition('failed', t))).toEqual(['queued']);
  });
  it('nothing re-enters suppressed', () => {
    for (const from of DELIVERY_STATUSES) expect(canTransition(from, 'suppressed')).toBe(false);
  });
  it('read only where the channel reports it (WhatsApp)', () => {
    expect(canTransition('delivered', 'read', { channel: 'whatsapp' })).toBe(true);
    for (const channel of ['sms', 'email', 'print'] as const) expect(canTransition('delivered', 'read', { channel })).toBe(false);
  });
  it('rejects unknown states', () => {
    expect(canTransition('bogus' as never, 'sent')).toBe(false);
    expect(canTransition('queued', 'bogus' as never)).toBe(false);
  });
});
