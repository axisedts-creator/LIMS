// C16 T-02 state tables (03-APP-FLOW §3.4, §4.1–4.5; 05-SCHEMA *__status__ck; US-EN-21.2/21.3/21.4/21.5).
// Assumed API (convention of billing/*.state.ts), one module per machine under ../:
//   booking.state.ts        BOOKING_STATUSES, canTransition(from,to), isTerminal(s), canPatientCancel(s)
//   paymentRequest.state.ts PAYMENT_REQUEST_STATUSES, canTransition, isTerminal
//   queueToken.state.ts     QUEUE_TOKEN_STATUSES, canTransition, isTerminal, canRecall(callCount), shouldSuggestSkip(callCount),
//                           compareWaiting(a,b), formatTokenLabel(prefix, seq), businessDate(instant: Date, timeZone)
//   reminder.state.ts       REMINDER_STATUSES, canTransition, isTerminal
//   enquiry.state.ts        ENQUIRY_STATUSES, canTransition, isTerminal
//   link.state.ts           LINK_STATUSES, canTransition, isTerminal
import { describe, expect, it } from 'vitest';
import * as booking from '../booking.state.js';
import * as pay from '../paymentRequest.state.js';
import * as token from '../queueToken.state.js';
import * as reminder from '../reminder.state.js';
import * as enquiry from '../enquiry.state.js';
import * as link from '../link.state.js';

type Machine = {
  name: string;
  statuses: readonly string[];
  allowed: Record<string, string[]>;
  terminal: string[];
  canTransition: (f: never, t: never) => boolean;
  isTerminal: (s: never) => boolean;
};

const machines: Machine[] = [
  {
    name: 'booking (APP-FLOW 4.1 B-2..B-7)',
    statuses: booking.BOOKING_STATUSES,
    allowed: { confirmed: ['checked_in', 'cancelled', 'completed'], checked_in: ['cancelled', 'completed'], completed: [], cancelled: [] },
    terminal: ['completed', 'cancelled'],
    canTransition: booking.canTransition as never,
    isTerminal: booking.isTerminal as never,
  },
  {
    name: 'payment request (4.2)',
    statuses: pay.PAYMENT_REQUEST_STATUSES,
    allowed: { queued: ['ready', 'failed'], ready: ['completed', 'expired', 'ready'], completed: [], failed: [], expired: [] },
    terminal: ['completed', 'failed', 'expired'],
    canTransition: pay.canTransition as never,
    isTerminal: pay.isTerminal as never,
  },
  {
    name: 'queue token (4.3 T-2..T-10)',
    statuses: token.QUEUE_TOKEN_STATUSES,
    allowed: {
      waiting: ['called', 'cancelled', 'transferred', 'expired'],
      called: ['called', 'serving', 'skipped', 'completed', 'cancelled', 'transferred', 'expired'],
      serving: ['completed', 'transferred', 'expired'],
      skipped: ['called', 'cancelled', 'expired'],
      completed: [],
      cancelled: [],
      transferred: [],
      expired: [],
    },
    terminal: ['completed', 'cancelled', 'transferred', 'expired'],
    canTransition: token.canTransition as never,
    isTerminal: token.isTerminal as never,
  },
  {
    name: 'reminder (4.4)',
    statuses: reminder.REMINDER_STATUSES,
    allowed: { scheduled: ['sent', 'suppressed', 'failed', 'cancelled'], sent: [], suppressed: [], failed: [], cancelled: [] },
    terminal: ['sent', 'suppressed', 'failed', 'cancelled'],
    canTransition: reminder.canTransition as never,
    isTerminal: reminder.isTerminal as never,
  },
  {
    name: 'enquiry (4.5)',
    statuses: enquiry.ENQUIRY_STATUSES,
    allowed: { open: ['answered', 'closed'], answered: ['open', 'closed'], closed: [] },
    terminal: ['closed'],
    canTransition: enquiry.canTransition as never,
    isTerminal: enquiry.isTerminal as never,
  },
  {
    name: 'link (3.4 L-2..L-5)',
    statuses: link.LINK_STATUSES,
    allowed: { active: ['active', 'suspended', 'revoked'], suspended: ['active', 'revoked'], revoked: [] },
    terminal: ['revoked'],
    canTransition: link.canTransition as never,
    isTerminal: link.isTerminal as never,
  },
];

const DB_STATUSES: Record<string, string[]> = {
  'booking (APP-FLOW 4.1 B-2..B-7)': ['confirmed', 'checked_in', 'completed', 'cancelled'],
  'payment request (4.2)': ['queued', 'ready', 'completed', 'failed', 'expired'],
  'queue token (4.3 T-2..T-10)': ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'transferred', 'expired'],
  'reminder (4.4)': ['scheduled', 'sent', 'suppressed', 'failed', 'cancelled'],
  'enquiry (4.5)': ['open', 'answered', 'closed'],
  'link (3.4 L-2..L-5)': ['active', 'suspended', 'revoked'],
};

describe.each(machines)('state table: $name', (m) => {
  it('status set equals the 05-SCHEMA CHECK list', () => expect([...m.statuses].sort()).toEqual([...DB_STATUSES[m.name]!].sort()));

  const pairs = m.statuses.flatMap((f) => m.statuses.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(m.canTransition(from as never, to as never)).toBe(m.allowed[from]!.includes(to)));

  it('terminal statuses have no outgoing transition', () => {
    for (const s of m.statuses) expect(m.isTerminal(s as never)).toBe(m.terminal.includes(s));
  });
  it('rejects unknown statuses', () => {
    const any = m.statuses[0]!;
    expect(m.canTransition('nonsense' as never, any as never)).toBe(false);
    expect(m.canTransition(any as never, 'nonsense' as never)).toBe(false);
  });
});

describe('booking: patient cancel (03-APP-FLOW 4.1 forbidden list; US-EN-14.1)', () => {
  it('patient may cancel confirmed only', () => {
    expect(booking.canPatientCancel('confirmed')).toBe(true);
    expect(booking.canPatientCancel('checked_in')).toBe(false);
    expect(booking.canPatientCancel('completed')).toBe(false);
    expect(booking.canPatientCancel('cancelled')).toBe(false);
  });
  it('checked_in -> checked_in is forbidden (named in the spec)', () => expect(booking.canTransition('checked_in', 'checked_in')).toBe(false));
});

describe('queue token rules (US-EN-21.2, 21.3, 21.5)', () => {
  it('recall allowed while call_count < 9', () => {
    expect(token.canRecall(1)).toBe(true);
    expect(token.canRecall(8)).toBe(true);
    expect(token.canRecall(9)).toBe(false);
  });
  it('console suggests skip after 3 calls [CONV]', () => {
    expect(token.shouldSuggestSkip(2)).toBe(false);
    expect(token.shouldSuggestSkip(3)).toBe(true);
  });
  it('call order: priority first, then oldest issue time', () => {
    const t = (id: string, priority: 'normal' | 'priority', iso: string) => ({ id, priority, issuedAt: new Date(iso) });
    const list = [
      t('n-early', 'normal', '2026-11-16T01:00:00Z'),
      t('p-late', 'priority', '2026-11-16T01:30:00Z'),
      t('n-late', 'normal', '2026-11-16T01:10:00Z'),
      t('p-early', 'priority', '2026-11-16T01:20:00Z'),
    ];
    expect([...list].sort(token.compareWaiting).map((x) => x.id)).toEqual(['p-early', 'p-late', 'n-early', 'n-late']);
  });
  it('label A-001 first, zero-padded to 3, 4 digits after 999 (queue_tokens__label__ck)', () => {
    expect(token.formatTokenLabel('A', 1)).toBe('A-001');
    expect(token.formatTokenLabel('A', 2)).toBe('A-002');
    expect(token.formatTokenLabel('B', 999)).toBe('B-999');
    expect(token.formatTokenLabel('AB', 1000)).toBe('AB-1000');
    for (const n of [1, 2, 999, 1000]) expect(token.formatTokenLabel('A', n)).toMatch(/^[A-Z]{1,2}-[0-9]{3,4}$/);
  });
  it('business day rolls over at tenant-local midnight (Asia/Kathmandu = UTC+05:45)', () => {
    expect(token.businessDate(new Date('2026-11-15T18:14:59Z'), 'Asia/Kathmandu')).toBe('2026-11-15');
    expect(token.businessDate(new Date('2026-11-15T18:15:00Z'), 'Asia/Kathmandu')).toBe('2026-11-16');
    expect(token.businessDate(new Date('2026-11-15T18:15:00Z'), 'UTC')).toBe('2026-11-15');
  });
});
