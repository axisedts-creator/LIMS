// T0C-AUDIT-WIRE-1 (audit RS-13, LD-277) — identity operation wiring. Every operationId of contracts/openapi/identity.yaml is either wired to a real
// handler or listed in KNOWN_STUBS with a reason (done_when 4). The four audit/event read handlers must be wired to the function their own file exports
// (done_when 1). A "stub" is the `notImplemented` handler of handlers/index.ts: it throws LimsError common.internal "identity <op> not implemented".
// Detection runs each handler once with an empty request and an empty context (no tx, no actor: nothing can reach a database).
// Behaviour of the four known stubs must stay as it is (done_when 4: "their behaviour is not changed here").
import { describe, expect, it } from 'vitest';
import { handlers } from '../handlers/index.js';
import { getAuditEntry } from '../handlers/getAuditEntry.js';
import { listAccessLogEntries } from '../handlers/listAccessLogEntries.js';
import { listAuditEntries } from '../handlers/listAuditEntries.js';
import { listAuthEvents } from '../handlers/listAuthEvents.js';
import { readIdentitySpec } from './audit-view.helpers.js';

const KNOWN_STUBS: Record<string, string> = {
  listRolePacks: 'CR-C2-RM-001 (LD-150) operation; RM-T05 / LD-158 registers a fail-closed stub only, the real handler is a later task',
  applyRolePack: 'CR-C2-RM-001 (LD-150) operation; RM-T05 / LD-158 registers a fail-closed stub only, the real applyRolePack is not part of RM-T05',
  listAccessReviews: 'access-review screens have no handler task yet; stays fail-closed (common.internal) until one is planned',
  recordAccessReview: 'access-review screens have no handler task yet; stays fail-closed (common.internal) until one is planned',
};
const FOUR = { listAuditEntries, getAuditEntry, listAccessLogEntries, listAuthEvents } as const;

const spec: any = readIdentitySpec();
const HTTP = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const ids: string[] = Object.values<any>(spec.paths).flatMap((item) => HTTP.map((m) => item?.[m]?.operationId).filter((x): x is string => typeof x === 'string'));

const emptyReq: any = { params: {}, query: {}, headers: {}, body: undefined };
async function isStub(op: string): Promise<boolean> {
  const run = (async () => { try { await (handlers as Record<string, any>)[op](emptyReq, {}); return false; } catch (e: any) {
    return e?.code === 'common.internal' && /not implemented/.test(JSON.stringify(e, Object.getOwnPropertyNames(e)));
  } })();
  return Promise.race([run, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
}

describe('identity operation wiring (T0C-AUDIT-WIRE-1)', () => {
  it('the spec has operations and the stub list names only real operationIds, each with a reason', () => {
    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [op, why] of Object.entries(KNOWN_STUBS)) { expect(ids, op).toContain(op); expect(why.trim().length, `reason for ${op}`).toBeGreaterThan(10); }
  });

  it.each(ids)('%s is wired to a real handler, or is in KNOWN_STUBS', async (op) => {
    expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
    const stub = await isStub(op);
    if (op in KNOWN_STUBS) expect(stub, `${op} is listed as a known stub but is wired: remove it from KNOWN_STUBS`).toBe(true);
    else expect(stub, `${op} is an unregistered stub (throws "not implemented") and is not in KNOWN_STUBS`).toBe(false);
  });

  it.each(Object.keys(FOUR))('%s is registered as the function its own handler file exports (not the stub)', (op) => {
    expect((handlers as Record<string, unknown>)[op]).toBe((FOUR as Record<string, unknown>)[op]);
  });

  it('exactly the four known stubs are stubs today (RS-13 leaves only these)', async () => {
    const stubs: string[] = [];
    for (const op of ids) if (await isStub(op)) stubs.push(op);
    expect(stubs.sort()).toEqual(Object.keys(KNOWN_STUBS).sort());
  });

  it.each(Object.keys(KNOWN_STUBS))('known stub %s still fails closed with common.internal (behaviour unchanged)', async (op) => {
    const e: any = await (handlers as Record<string, any>)[op](emptyReq, {}).then(() => undefined, (x: unknown) => x);
    expect(e?.code).toBe('common.internal');
  });
});
