// T0D-FIX-1 item 2 (LD-446, CR DEPLOY-AXIS-012 item 2, related defect): listInventoryAlerts `status` arrives as an ARRAY once the core pipeline
// has split the csv (one value -> ['open'], several -> ['open','acknowledged']); a string (csv) is still accepted. No DB: the service is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAlerts = vi.fn(async (_ctx: unknown, q: unknown) => ({ data: [], page: { limit: (q as { limit: number }).limit } }));
vi.mock('../../service/alerts.api.service.js', () => ({ listAlerts, acknowledgeAlert: vi.fn() }));

const { parseAlertList } = await import('../../handlers/alerts.schemas.js');
const { alertHandlers } = await import('../../handlers/alerts.js');

const ctx = { ports: { IdentityPort: { assertRole: vi.fn(async () => undefined) } } } as never;
const call = (query: unknown) => alertHandlers['listInventoryAlerts']!({ query, params: {}, headers: {}, body: undefined } as never, ctx);

beforeEach(() => { listAlerts.mockClear(); });

describe('parseAlertList status: string or array (item 2)', () => {
  it('default is open + acknowledged', () => {
    expect(parseAlertList({}).status).toEqual(['open', 'acknowledged']);
    expect(parseAlertList(undefined).status).toEqual(['open', 'acknowledged']);
  });
  it('array form: one status and several', () => {
    expect(parseAlertList({ status: ['open'] }).status).toEqual(['open']);
    expect(parseAlertList({ status: ['open', 'acknowledged'] }).status).toEqual(['open', 'acknowledged']);
    expect(parseAlertList({ status: ['open', 'acknowledged', 'resolved'] }).status).toEqual(['open', 'acknowledged', 'resolved']);
  });
  it('string forms still work (csv and single)', () => {
    expect(parseAlertList({ status: 'open' }).status).toEqual(['open']);
    expect(parseAlertList({ status: 'open,acknowledged' }).status).toEqual(['open', 'acknowledged']);
  });
  it('duplicates are removed in both forms', () => {
    expect(parseAlertList({ status: ['open', 'open'] }).status).toEqual(['open']);
    expect(parseAlertList({ status: 'open,open' }).status).toEqual(['open']);
  });
  it('the rest of the query is unchanged: limit, cursor, alert_kind, store_id', () => {
    const store = '01a1a98a-ac40-7000-8000-00000000a500';
    const q = parseAlertList({ status: ['open'], limit: 20, cursor: 'abc_-9', alert_kind: 'below_reorder', store_id: store });
    expect(q).toMatchObject({ status: ['open'], limit: 20, cursor: 'abc_-9', alert_kind: 'below_reorder', store_id: store });
    expect(parseAlertList({ status: ['open'] }).limit).toBe(50);
  });
  it.each([
    ['unknown element in an array', { status: ['open', 'bogus'] }],
    ['unknown string', { status: 'bogus' }],
    ['empty array', { status: [] }],
    ['four elements', { status: ['open', 'acknowledged', 'resolved', 'open'] }],
    ['non string element', { status: [1] }],
    ['object element', { status: [{ $ne: 'open' }] }],
    ['nested array', { status: [['open']] }],
    ['number', { status: 5 }],
    ['unknown key', { status: ['open'], foo: 1 }],
    ['element that is itself a long string', { status: ['x'.repeat(500)] }],
  ])('rejects: %s', (_n, q) => { expect(() => parseAlertList(q)).toThrow(); });
});

describe('listInventoryAlerts handler: 200 for one status and for several (item 2)', () => {
  it('one status (array) -> 200 and the service gets ["open"]', async () => {
    const r = await call({ status: ['open'] });
    expect(r.status).toBe(200);
    expect(listAlerts).toHaveBeenCalledTimes(1);
    expect(listAlerts.mock.calls[0]![1]).toMatchObject({ status: ['open'], limit: 50 });
  });
  it('several statuses (array) -> 200 and the service gets both', async () => {
    const r = await call({ status: ['open', 'acknowledged'] });
    expect(r.status).toBe(200);
    expect(listAlerts.mock.calls[0]![1]).toMatchObject({ status: ['open', 'acknowledged'] });
  });
  it('the csv string form -> 200', async () => {
    expect((await call({ status: 'open,acknowledged' })).status).toBe(200);
  });
  it('a bad status never reaches the service', async () => {
    await expect(call({ status: ['bogus'] })).rejects.toBeTruthy();
    expect(listAlerts).not.toHaveBeenCalled();
  });
});
