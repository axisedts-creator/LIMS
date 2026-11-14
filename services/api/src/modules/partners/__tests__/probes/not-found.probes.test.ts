// C13 T22 — AB1 / AB3 / AB15, ST1-ST3 generic probe: a by-id read of an object that is not visible to the caller (another partner's, another tenant's, another centre's, or nothing at all)
// answers the SAME 404 common.not_found, with no write, no side effect, and an error that carries nothing of the id's owner. Row-level hiding is the DB's job (ST5, live DB: T24);
// this proves the handler layer maps "no visible row" to an indistinguishable 404 for every GET-by-id operation of partners.yaml (generated from the spec).
// The world is EMPTY except the caller's own partner-context row, so any handler that answers 200 / 403 / 500 for an unseen id fails.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { ALL, ids, recCtx, reqFor, settle } from './kit.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const BY_ID = ALL.filter((o) => o.method === 'GET' && /\{[a-z_]+_id\}/.test(o.path) && !o.path.endsWith('/users') && o.operationId !== 'listPartnerUsersForPartner');
const OTHER = '01940e00-0000-7000-8000-c13220000f99';
const reportPort = { ReportingPort: { async openReleasedReportFile() { throw new LimsError('common.not_found'); } } };

const outcome = async (opId: string, id: string) => {
  const o = ALL.find((x) => x.operationId === opId)!;
  const k = recCtx(o.staff ? 'user' : 'partner', { activePartner: true, portal: reportPort as any });
  const req = reqFor(o);
  for (const key of Object.keys(req.params)) if (/_id$/.test(key)) req.params[key] = id;
  const r = await settle(H[opId]!(req, k.ctx));
  return { r, k };
};

describe('generator guard', () => {
  it('covers the by-id reads of manifests, orders, pickups, slips, reports, partners', () => {
    expect(BY_ID.map((o) => o.operationId).sort()).toEqual(expect.arrayContaining(['downloadPartnerReport', 'downloadPatientAccessSlip', 'getInboundManifest', 'getManifest', 'getManifestPrintView',
      'getPartner', 'getPartnerOrder', 'getPatientAccessSlip', 'getPickupRequest']));
  });
});

describe.each(BY_ID.map((o) => [o.operationId] as const))('%s', (opId) => {
  it('unseen id -> 404 common.not_found, no write, no job, no audit "allowed" row', async () => {
    const { r, k } = await outcome(opId, OTHER);
    expect(r.ok, `${opId} resolved: ${JSON.stringify((r as any).value)}`).toBe(false);
    if (!r.ok) { expect(r.error.code, String(r.error.message)).toBe('common.not_found'); expect(r.error.statusCode).toBe(404); }
    expect(k.writes()).toEqual([]);
    expect(k.audit.filter((e) => e.outcome === 'allowed')).toEqual([]);
  });

  it('indistinguishable: two different unseen ids give the identical error (code, status, message), and the id is never echoed', async () => {
    const a = await outcome(opId, OTHER); const b = await outcome(opId, ids.actor);
    expect(a.r.ok || b.r.ok).toBe(false);
    if (!a.r.ok && !b.r.ok) {
      expect([a.r.error.code, a.r.error.statusCode, a.r.error.message]).toEqual([b.r.error.code, b.r.error.statusCode, b.r.error.message]);
      const blob = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(a.r.error).map((n) => [n, a.r.error[n]])));
      expect(blob).not.toContain(OTHER);
    }
  });
});
