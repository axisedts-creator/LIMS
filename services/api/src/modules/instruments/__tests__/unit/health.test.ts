// API-T02 — AC-13.2..13.5, 03-APP-FLOW §2.4. Pure evaluator (domain/health.ts).
// Expected API:
//   evaluateHealth(input: HealthInput, nowIso: IsoUtc): { state: 'offline'|'backlog'|'degraded'|'online'; silentInstrumentIds: string[] }
//   healthTransition(stored: HealthState, computed: HealthState): { from: HealthState; to: HealthState } | null  (null = unchanged -> no event)
//   HealthInput = { lastHeartbeatAt: IsoUtc | null; queueDepth: number; oldestPendingAgeSeconds: number; backlogThreshold: number;
//                   maxOldestPendingSeconds: number; tenantTimezone: string;
//                   liveInstruments: { id: string; liveAt: IsoUtc; lastMessageAt: IsoUtc | null; silenceWindowMinutes: number | null;
//                                      silenceActiveFrom: 'HH:MM' | null; silenceActiveTo: 'HH:MM' | null }[] }
import { describe, expect, it } from 'vitest';
import { evaluateHealth, healthTransition } from '../../domain/health.js';

const NOW = '2026-11-07T10:00:00.000Z';
const ago = (s: number) => new Date(Date.parse(NOW) - s * 1000).toISOString();
const base = {
  lastHeartbeatAt: ago(30),
  queueDepth: 0,
  oldestPendingAgeSeconds: 0,
  backlogThreshold: 500,
  maxOldestPendingSeconds: 900,
  tenantTimezone: 'UTC',
  liveInstruments: [] as unknown[],
};
const inst = (o: Record<string, unknown> = {}) => ({
  id: 'i1',
  liveAt: ago(86400),
  lastMessageAt: ago(3600),
  silenceWindowMinutes: 30,
  silenceActiveFrom: null,
  silenceActiveTo: null,
  ...o,
});
const ev = (o: Record<string, unknown> = {}) => evaluateHealth({ ...base, ...o } as never, NOW);

describe('AC-13.2 offline', () => {
  it('no heartbeat ever -> offline', () => expect(ev({ lastHeartbeatAt: null }).state).toBe('offline'));
  it('exactly 180 s -> still online (rule is > 180)', () => expect(ev({ lastHeartbeatAt: ago(180) }).state).toBe('online'));
  it('181 s -> offline', () => expect(ev({ lastHeartbeatAt: ago(181) }).state).toBe('offline'));
  it('heartbeat slightly in the future (clock skew) is not offline', () =>
    expect(ev({ lastHeartbeatAt: ago(-5) }).state).toBe('online'));
});

describe('AC-13.3 backlog', () => {
  it('queue_depth == threshold -> online; threshold + 1 -> backlog', () => {
    expect(ev({ queueDepth: 500 }).state).toBe('online');
    expect(ev({ queueDepth: 501 }).state).toBe('backlog');
  });
  it('oldest pending == 900 s -> online; 901 s -> backlog', () => {
    expect(ev({ oldestPendingAgeSeconds: 900 }).state).toBe('online');
    expect(ev({ oldestPendingAgeSeconds: 901 }).state).toBe('backlog');
  });
  it('per-agent threshold is honoured', () => expect(ev({ queueDepth: 11, backlogThreshold: 10 }).state).toBe('backlog'));
});

describe('AC-13.4 degraded (silent live instrument)', () => {
  it('silent longer than window, no active hours -> degraded with ids', () => {
    const r = ev({ liveInstruments: [inst({ lastMessageAt: ago(31 * 60) }), inst({ id: 'i2', lastMessageAt: ago(60) })] });
    expect(r).toEqual({ state: 'degraded', silentInstrumentIds: ['i1'] });
  });
  it('exactly at window -> not silent; online has empty silentInstrumentIds', () => {
    expect(ev({ liveInstruments: [inst({ lastMessageAt: ago(30 * 60) })] })).toEqual({ state: 'online', silentInstrumentIds: [] });
  });
  it('no silence_window_minutes -> never silent', () => {
    expect(ev({ liveInstruments: [inst({ silenceWindowMinutes: null, lastMessageAt: ago(999999) })] }).state).toBe('online');
  });
  it('never sent a message: falls back to live_at', () => {
    expect(ev({ liveInstruments: [inst({ lastMessageAt: null, liveAt: ago(31 * 60) })] }).state).toBe('degraded');
    expect(ev({ liveInstruments: [inst({ lastMessageAt: null, liveAt: ago(10 * 60) })] }).state).toBe('online');
  });
  it('active hours are evaluated in the tenant timezone, [from, to)', () => {
    // 10:00Z = 15:45 in Asia/Kathmandu (+05:45)
    const silent = { lastMessageAt: ago(3600) };
    const tz = { tenantTimezone: 'Asia/Kathmandu' };
    const run = (from: string, to: string) =>
      ev({ ...tz, liveInstruments: [inst({ ...silent, silenceActiveFrom: from, silenceActiveTo: to })] }).state;
    expect(run('08:00', '16:00')).toBe('degraded');
    expect(run('08:00', '15:00')).toBe('online'); // outside window: silence ignored
    expect(run('15:45', '17:00')).toBe('degraded'); // from inclusive
    expect(run('08:00', '15:45')).toBe('online'); // to exclusive
  });
});

describe('AC-13.5 precedence and change detection', () => {
  const silent = [inst({ lastMessageAt: ago(7200) })];
  it('offline > backlog > degraded > online', () => {
    expect(ev({ lastHeartbeatAt: ago(500), queueDepth: 9999, liveInstruments: silent }).state).toBe('offline');
    expect(ev({ queueDepth: 9999, liveInstruments: silent }).state).toBe('backlog');
    expect(ev({ liveInstruments: silent }).state).toBe('degraded');
    expect(ev().state).toBe('online');
  });
  it('unchanged state -> null (no event)', () => {
    for (const s of ['offline', 'backlog', 'degraded', 'online'] as const) expect(healthTransition(s, s)).toBeNull();
  });
  it('changed state -> {from,to}', () =>
    expect(healthTransition('online', 'offline')).toEqual({ from: 'online', to: 'offline' }));
  it('never-heartbeated agent stays offline -> no transition', () => {
    expect(healthTransition('offline', ev({ lastHeartbeatAt: null }).state)).toBeNull();
  });
});
