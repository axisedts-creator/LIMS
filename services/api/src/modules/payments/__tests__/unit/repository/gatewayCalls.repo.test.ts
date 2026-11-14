// PG-T04 — gatewayCalls.repo (05-SCHEMA payments.gateway_calls; TRD §7.6; REQ-SEC-056/098).
// Assumed seam (tester; writer may dispute via notes): repository/gatewayCalls.repo.ts exports
//   insertGatewayCall(tx: Pick<Tx,'query'>, row: GatewayCallInsert) -> Promise<void>
//   GatewayCallInsert = { id, tenantId, intentId?, refundId?, merchantAccountId?, gateway, operation, attempt?, httpStatus?, outcome,
//                         gatewayStatusRaw?, responseRedacted?, durationMs, createdBy }
// One parameterised INSERT INTO payments.gateway_calls (no string-built values). The repo is the last gate: it re-applies the
// allowlist, so an unredacted body handed to it still stores allowlisted keys only; gatewayStatusRaw is cut to 64 chars.
import { describe, expect, it } from 'vitest';
import { insertGatewayCall } from '../../../repository/gatewayCalls.repo.js';

const U = (n: number): string => `0190c403-0000-7000-8000-${String(n).padStart(12, '0')}`;
const base = { id: U(1), tenantId: U(2), gateway: 'khalti', operation: 'khalti_lookup', outcome: 'answer', durationMs: 12, createdBy: U(3) } as const;

function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  return { calls, query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; } } as never as
    { calls: typeof calls; query: (s: string, v?: unknown[]) => Promise<unknown> };
}

describe('insertGatewayCall', () => {
  it('issues exactly one parameterised INSERT into payments.gateway_calls', async () => {
    const tx = fakeTx();
    await insertGatewayCall(tx as never, { ...base, intentId: U(4), attempt: 2, httpStatus: 200, gatewayStatusRaw: 'Completed', responseRedacted: { status: 'Completed' } } as never);
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]!.sql).toMatch(/INSERT\s+INTO\s+payments\.gateway_calls/i);
    expect(tx.calls[0]!.sql).not.toMatch(/Completed|khalti_lookup|0190c403/); // values travel as parameters
    expect(tx.calls[0]!.values).toEqual(expect.arrayContaining([U(1), U(2), U(3), 'khalti', 'khalti_lookup', 'answer', 12, 'Completed']));
  });

  it('re-applies the allowlist: unknown keys and Khalti mobile in responseRedacted are never sent to the DB', async () => {
    const tx = fakeTx();
    await insertGatewayCall(tx as never, { ...base, responseRedacted: { status: 'Completed', total_amount: 5, mobile: '9800000000', payment_url: 'https://x', zzz: 'leak' } } as never);
    const all = JSON.stringify(tx.calls[0]!.values);
    expect(all).toContain('Completed');
    expect(all).not.toMatch(/9800000000|payment_url|leak|zzz|mobile/);
  });

  it('responseRedacted is sent as a JSON string of <= 2048 octets even for oversized allowlisted values', async () => {
    const tx = fakeTx();
    await insertGatewayCall(tx as never, { ...base, gateway: 'esewa', operation: 'esewa_status', responseRedacted: { status: 'S', error_message: 'e'.repeat(9000) } } as never);
    const json = tx.calls[0]!.values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(json).toBeDefined();
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(2048);
  });

  it('gatewayStatusRaw is cut to 64 chars', async () => {
    const tx = fakeTx();
    await insertGatewayCall(tx as never, { ...base, gatewayStatusRaw: 'Q'.repeat(500) } as never);
    const raw = tx.calls[0]!.values.find((v) => typeof v === 'string' && /^Q+$/.test(v)) as string;
    expect(raw.length).toBe(64);
  });

  it('absent optionals are sent as null, attempt defaults to 1, null responseRedacted stays null', async () => {
    const tx = fakeTx();
    await insertGatewayCall(tx as never, { ...base } as never);
    const v = tx.calls[0]!.values;
    expect(v).toContain(null);
    expect(v).toContain(1);
    expect(v.some((x) => typeof x === 'string' && x.startsWith('{'))).toBe(false);
  });

  it('a DB error (e.g. CHECK violation) propagates raw', async () => {
    const tx = { query: async () => { throw Object.assign(new Error('violates check constraint'), { code: '23514' }); } };
    await expect(insertGatewayCall(tx as never, { ...base } as never)).rejects.toMatchObject({ code: '23514' });
  });
});
