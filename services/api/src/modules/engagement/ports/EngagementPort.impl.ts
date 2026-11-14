// EngagementPort module implementation (08 A17 P-20, 06-PLAN T-EP1; IC §4.17; 08 R25). Replaces the T-01 stub-equivalent bodies with tenant-scoped reads.
// Read-only: every statement is a single-table SELECT binding tenant_id (REQ-SEC-024, in addition to RLS); no catalog-schema or public-view relation (A17 P-21).
// The port writes no access_log (the caller does) and never logs the address (07 §2 denylist).
// Actors: 'user' needs a permission via IdentityPort.assertRole; 'system' needs none; device / patient -> auth.forbidden before any read.
import { LimsError } from '../../../core/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOME_PERMS = ['homecollection.visit.assign', 'homecollection.visit.read'] as const;
const MEMBERSHIP_PERM = 'frontdesk.registration.create';

type Row = Record<string, any>;
type Ctx = {
  tenantId: string; actor: { type: string }; tx: { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> };
  now(): string; ports: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
};

const invalid = () => new LimsError('common.validation_failed');

/** staff must hold one of `perms`; system passes; every other actor type is refused (deny by actor type, not by permission). */
async function authorise(ctx: Ctx, perms: readonly string[]): Promise<void> {
  const type = ctx.actor?.type;
  if (type === 'system') return;
  if (type !== 'user') throw new LimsError('auth.forbidden');
  let last: unknown;
  for (const permission of perms) {
    try { await ctx.ports.IdentityPort.assertRole(ctx, { permission }); return; } catch (e) { last = e; }
  }
  throw last;
}

/** pg `date` -> 'YYYY-MM-DD' (driver may hand back a Date or a string). */
const day = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

export const engagementPort = Object.freeze({
  async getHomeAddress(ctx: Ctx, input: { homeAddressId: string; purpose: string }): Promise<{ addressText: string; landmark?: string; latitude?: string; longitude?: string }> {
    await authorise(ctx, HOME_PERMS);
    if (input?.purpose !== 'home_visit' || !UUID.test(String(input.homeAddressId))) throw invalid(); // purpose limitation for P2 data
    const { rows } = await ctx.tx.query(
      'SELECT address_text, landmark, latitude, longitude FROM engagement.addresses WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, input.homeAddressId]);
    const r = rows[0];
    if (!r) throw new LimsError('common.not_found');
    return {
      addressText: r['address_text'],
      ...(r['landmark'] != null ? { landmark: r['landmark'] } : {}),
      ...(r['latitude'] != null ? { latitude: String(r['latitude']) } : {}),
      ...(r['longitude'] != null ? { longitude: String(r['longitude']) } : {}),
    };
  },

  async getActiveMembership(ctx: Ctx, input: { patientId: string; at?: string }): Promise<{ membershipId: string; planCode: string; planName: string; priceListId: string; validTo: string } | undefined> {
    await authorise(ctx, [MEMBERSHIP_PERM]);
    if (!UUID.test(String(input?.patientId))) throw invalid();
    const at = input.at ?? ctx.now();
    if (Number.isNaN(Date.parse(at))) throw invalid();
    const today = new Date(at).toISOString().slice(0, 10);
    const { rows } = await ctx.tx.query(
      "SELECT id, plan_id, valid_from, valid_to FROM engagement.patient_memberships WHERE tenant_id = $1 AND patient_id = $2 AND status = 'active'", [ctx.tenantId, input.patientId]);
    // valid_from <= at < valid_to on dates; latest valid_from wins if cards overlap.
    const m = rows.filter((r) => day(r['valid_from']) <= today && today < day(r['valid_to'])).sort((a, b) => day(b['valid_from']).localeCompare(day(a['valid_from'])))[0];
    if (!m) return undefined;
    const { rows: plans } = await ctx.tx.query(
      'SELECT code, display_name, price_list_id FROM engagement.membership_plans WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, m['plan_id']]);
    const p = plans[0];
    if (!p) return undefined;
    return { membershipId: m['id'], planCode: p['code'], planName: p['display_name'], priceListId: p['price_list_id'], validTo: `${day(m['valid_to'])}T00:00:00.000Z` };
  },
});
