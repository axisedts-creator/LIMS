// C9 T-25 — S-02 live variant (07-SECURITY §5; AB-07; 08 A17 P-16): a USER of tenant A whose membership covers centre A1 only (core.memberships.all_centres = false + core.membership_centres A1)
// drives the REAL getTatAlert / acknowledgeTatAlert / listTatAlerts handlers against a running, alerting tat_items row of centre A2 under real RLS (`tat_items__tenant_centre`):
// 404 common.not_found / empty page, and the owner-side row is byte-identical afterwards (no version bump, no ack row). Control: the same user sees the A1 row by SQL.
// Needs LIMS_TEST_DATABASE_URL (lims_api) + LIMS_TEST_ADMIN_DATABASE_URL (superuser); skips without them. ASSUMED: claims { tenant_id, sub, actor_type:'user', membership_id } as app.current_centre_ids() reads.
// Fails now (with a database): the quality DDL is not applied (C0 prerequisite).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CENTRE_A1, CENTRE_A2, SYS, T, TENANT_A, api, claimsOf, closePools, fire, live, loadManifest, makeHarness, opById, owner, requestFor, seedRow, seen, uid, withClaims } from './kit.js';

afterAll(async () => { await closePools(); });
const USER_PERMS = ['quality.tat_alert.read', 'quality.tat_alert.ack'];

describe.skipIf(!live)('S-02 live: a user scoped to centre A1 against a running alert of centre A2', () => {
  const MEMBERSHIP = uid(), A1_ITEM = uid(), A2_ITEM = uid();
  let handlers: Record<string, (...a: any[]) => Promise<any>>;
  // 'total' + 'registered_at' satisfy tat_items__start_basis__ck; running needs started_at (tat_items__running__ck)
  const running = (id: string, centre: string) => seedRow('quality.tat_items', { id, tenant_id: TENANT_A, centre_id: centre, state: 'running', segment: 'total', start_basis: 'registered_at', priority: 'routine',
    alert_level: 'breached', started_at: new Date('2026-11-14T08:00:00Z'), target_seconds: 3600, version: 1, expires_at: null });
  beforeAll(async () => {
    vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
    handlers = (await loadManifest()).handlers;
    await seedRow('core.memberships', { id: MEMBERSHIP, tenant_id: TENANT_A, actor_type: 'user', all_centres: false, is_active: true });
    await seedRow('core.membership_centres', { tenant_id: TENANT_A, membership_id: MEMBERSHIP, centre_id: CENTRE_A1 });
    await running(A1_ITEM, CENTRE_A1); await running(A2_ITEM, CENTRE_A2);
  }, T);
  const userClaims = () => claimsOf(TENANT_A, { actor_type: 'user', membership_id: MEMBERSHIP, sub: SYS });
  const as = async <R>(fn: (tx: any) => Promise<R>) => withClaims(api(), userClaims(), fn);   // COMMIT: a side effect would persist and show in the owner check
  const ownerRow = async () => (await owner('SELECT t::text AS r FROM quality.tat_items t WHERE id = $1', [A2_ITEM]))[0]?.r;
  const ownerAcks = async () => (await owner('SELECT count(*)::int AS n FROM quality.tat_alert_acks WHERE tat_item_id = $1', [A2_ITEM]))[0].n;

  it('control: by SQL the A1 user sees the A1 item and not the A2 item', async () => {
    await as(async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM quality.tat_items WHERE id = $1', [A1_ITEM])).rows[0].n).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM quality.tat_items WHERE id = $1', [A2_ITEM])).rows[0].n).toBe(0);
    });
  });

  it('getTatAlert and acknowledgeTatAlert on the A2 item: 404 common.not_found, row and acks unchanged', async () => {
    const before = [await ownerRow(), await ownerAcks()];
    for (const id of ['getTatAlert', 'acknowledgeTatAlert']) {
      const op = opById(id), h = makeHarness({ permissions: USER_PERMS, aal: 'aal1', allCentres: false, centreIds: [CENTRE_A1] }, id);
      const out = await as(async (c) => { h.ctx.tx = c; return fire(handlers[id]!, requestFor(op, { ids: { tat_item_id: A2_ITEM }, body: { note: 'synthetic' } }), h.ctx); });
      expect(out.reply, `${id} answered ${out.reply?.status}`).toBeUndefined();
      expect(out.error?.code, `${id}: ${out.error?.message}`).toBe('common.not_found');
      expect(out.error?.statusCode).toBe(404);
      expect(seen(out.error)).not.toContain(A2_ITEM);
      expect(h.audits).toEqual([]);
    }
    expect([await ownerRow(), await ownerAcks()], 'A2 item (version, ack columns) and its acks unchanged').toEqual(before);
  });

  it('listTatAlerts: the A2 alert is not in the page, also when centre_id=A2 is asked for; the owner confirms it exists', async () => {
    expect((await owner(`SELECT count(*)::int AS n FROM quality.tat_items WHERE id = $1 AND state = 'running' AND alert_level <> 'none'`, [A2_ITEM]))[0].n).toBe(1);
    const op = opById('listTatAlerts');
    for (const query of [{ centre_id: CENTRE_A2 }, {}]) {
      const h = makeHarness({ permissions: USER_PERMS, aal: 'aal1', allCentres: false, centreIds: [CENTRE_A1] }, op.id);
      // the harness CatalogPort throws for a visible A1 row (no test catalogue here): restrict the page to what RLS hides, or accept that the only failure is NOT an A2 leak
      const out = await as(async (c) => { h.ctx.tx = c; return fire(handlers[op.id]!, requestFor(op, { query }), h.ctx); });
      expect(JSON.stringify(out.reply?.body ?? seen(out.error)), 'A2 item never reaches the caller').not.toContain(A2_ITEM);
      if (query.centre_id) { expect(out.error, seen(out.error)).toBeUndefined(); expect(out.reply?.body?.data).toEqual([]); }
    }
  });
});
