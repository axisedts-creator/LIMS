// C13 T07 — partner accounts, staff side: SA1–SA7 (02-TRD §5.3, §8.1; 03-APP-FLOW §2.4, §6 SA2; 05-SCHEMA §3.1, §3.8).
// Order in every operation: actor type -> IdentityPort.assertRole (C2: auth.forbidden, auth.mfa_required for the privileged manage permission at aal1) -> If-Match
// -> row lookup (tenant-bound, a foreign/unknown id is the same common.not_found) -> port checks -> writes -> sync jobs. All values are bound parameters; no
// request value is ever part of SQL text. Staff actor = { type:'user' }; created_by/updated_by come from ctx.actor only (REQ-SEC-024).
// Optimistic concurrency: UPDATE ... WHERE version = $n; 0 rows = common.version_conflict. Credit party is never changeable (TRD §5.3 SA4 DECISION).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { assertTransition, type PartnerStatus } from '../domain/partner.state.js';
import { toPartnerAdminDto, toPartnerAdminSummaryDto, type CreditPartyRef, type CentreRef, type PartnerRow } from '../mappers/partner.dto.js';

type Row = Record<string, any>;
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };
type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
type Core = {
  branch(c: unknown, i: { branchId: string }): Promise<{ id: string; isActive: boolean }>;
  centre(c: unknown, i: { centreId: string }): Promise<{ id: string; branchId: string; centreCode: string; name: string; isActive: boolean }>;
};
type CatalogPort = { getCreditParty(c: unknown, i: { creditPartyId: string; purpose: 'display' }): Promise<{ creditPartyId: string; code: string; name: string; isActive: boolean }> };

const READ = 'partners.partner.read';
const MANAGE = 'partners.partner.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARTNER_CODE = /^[A-Z0-9_-]{1,20}$/;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const OPEN_MANIFEST_STATES = "'draft','submitted','partially_received'"; // non-terminal manifest states (05-SCHEMA §3.6)
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_VERSION = 2147483647;

const JOBS = { price_list: ['partners.sync_price_list', 'pricelist:'], statements: ['partners.sync_statements', 'statements:'], tracking: ['partners.reconcile_orders', 'reconcile:partner:'] } as const;
type Scope = keyof typeof JOBS;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const notFound = (): never => { throw new LimsError('common.not_found'); };
const invalid = (): never => { throw new LimsError('common.validation_failed'); };
const tx = (ctx: HandlerContext): Q => ctx.tx as Q;

/** actor type -> assertRole. Anything but a staff user is refused before SQL or a port call. */
async function authorize(ctx: HandlerContext, permission: string): Promise<{ tenantId: string; actorId: string }> {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId) throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id };
}

/** [CONV] If-Match "<n>" as payments/lab: missing -> 428, malformed -> 400. */
function ifMatch(req: Req): number {
  const h = isObj(req.headers) ? req.headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) return invalid();
  return Number(m[1]);
}

function partnerId(req: Req): string {
  const v = isObj(req.params) ? req.params['partner_id'] : undefined;
  return typeof v === 'string' && v !== '' ? v : notFound(); // uuid shape: validated by the core against OpenAPI
}
const body = (req: Req): Record<string, unknown> => (isObj(req.body) ? req.body : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---- reads ----
// Counts and projection timestamps come from derived tables joined in the same SELECT (no WHERE inside; the tenant is bound on the outer statement and by RLS).
const COLS = 'p.id, p.partner_code, p.name, p.status, p.credit_party_id, p.receiving_branch_id, p.receiving_centre_id, p.conversion_mode, p.contact_email, p.contact_phone_e164, p.address_text, '
  + 'p.suspend_reason_code, p.created_at, p.version, '
  + "to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_key, "
  + 'COALESCE(u.n, 0)::int AS active_users, COALESCE(m.n, 0)::int AS open_manifests, pl.synced_at AS price_list_synced_at, st.synced_at AS statements_synced_at';
const FROM = 'FROM partners.partners p '
  + "LEFT JOIN (SELECT tenant_id, partner_id, sum((status = 'active')::int)::int AS n FROM partners.partner_users GROUP BY tenant_id, partner_id) u ON u.tenant_id = p.tenant_id AND u.partner_id = p.id "
  + `LEFT JOIN (SELECT tenant_id, partner_id, sum((state IN (${OPEN_MANIFEST_STATES}))::int)::int AS n FROM partners.manifests GROUP BY tenant_id, partner_id) m ON m.tenant_id = p.tenant_id AND m.partner_id = p.id `
  + 'LEFT JOIN partners.price_list_syncs pl ON pl.tenant_id = p.tenant_id AND pl.partner_id = p.id '
  + 'LEFT JOIN (SELECT tenant_id, partner_id, max(synced_at) AS synced_at FROM partners.statement_months GROUP BY tenant_id, partner_id) st ON st.tenant_id = p.tenant_id AND st.partner_id = p.id ';

async function loadDetail(ctx: HandlerContext, tenantId: string, id: string): Promise<PartnerRow> {
  const { rows } = await tx(ctx).query(`SELECT ${COLS} ${FROM}WHERE p.tenant_id = $1 AND p.id = $2`, [tenantId, id]);
  return (rows[0] as PartnerRow | undefined) ?? notFound();
}

async function creditParty(ctx: HandlerContext, creditPartyId: string): Promise<CreditPartyRef & { isActive: boolean }> {
  const cp = await (ctx.ports.CatalogPort as CatalogPort).getCreditParty(ctx, { creditPartyId, purpose: 'display' }); // C3: a foreign id is common.not_found
  return { id: cp.creditPartyId, party_code: cp.code, name: cp.name, isActive: cp.isActive };
}

async function centreOf(ctx: HandlerContext, centreId: string): Promise<CentreRef & { isActive: boolean; branchId: string }> {
  const c = await (ctx.core as unknown as Core).centre(ctx, { centreId });
  return { id: c.id, code: c.centreCode, name: c.name, isActive: c.isActive, branchId: c.branchId };
}

/** branch + centre of this tenant, both active, centre inside the branch (a foreign id is not_found; 05-SCHEMA §3.1 FKs are tenant-scoped too). */
async function checkPlace(ctx: HandlerContext, branchId: string, centreId: string): Promise<CentreRef> {
  const branch = await (ctx.core as unknown as Core).branch(ctx, { branchId });
  const centre = await centreOf(ctx, centreId);
  if (!branch.isActive || !centre.isActive) throw new LimsError('identity.centre_inactive');
  if (centre.branchId !== branchId) invalid(); // spec gap: no dedicated code for centre-not-in-branch -> 400
  return { id: centre.id, code: centre.code, name: centre.name };
}

async function toDto(ctx: HandlerContext, row: PartnerRow, known: { cp?: CreditPartyRef; centre?: CentreRef } = {}) {
  const cp = known.cp ?? await creditParty(ctx, row.credit_party_id);
  const centre = known.centre ?? await centreOf(ctx, row.receiving_centre_id);
  return toPartnerAdminDto(row, { id: cp.id, party_code: cp.party_code, name: cp.name }, { id: centre.id, code: centre.code, name: centre.name });
}

/** lock + tenant bound; absent / foreign = 404, stale If-Match = 409 */
async function lock(ctx: HandlerContext, tenantId: string, id: string, expected: number): Promise<Row> {
  const { rows } = await tx(ctx).query(
    'SELECT id, version, status, credit_party_id, receiving_branch_id, receiving_centre_id FROM partners.partners WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
  const cur = rows[0] ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  return cur;
}

async function enqueue(ctx: HandlerContext, tenantId: string, id: string, scopes: readonly Scope[]): Promise<void> {
  for (const s of scopes) {
    const [identifier, prefix] = JOBS[s];
    await tx(ctx).query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [identifier, JSON.stringify({ tenant_id: tenantId, partner_id: id }), `${prefix}${id}`]);
  }
}

// ---- cursor: base64url(JSON{v:1, s: sort, k: key, i: id}); carries no authority (02-CV §4.3) ----
const encodeCursor = (s: string, k: string, i: string): string => Buffer.from(JSON.stringify({ v: 1, s, k, i })).toString('base64url');
function decodeCursor(raw: unknown, sort: string): { key: string; id: string } {
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== sort || typeof o['k'] !== 'string' || typeof o['i'] !== 'string' || !UUID.test(o['i'])) return bad();
  if (!(sort === 'partner_code' ? PARTNER_CODE : ISO_US).test(o['k'])) return bad();
  return { key: o['k'], id: o['i'] };
}

// ---- SA1 ----
export async function list(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, READ);
  const q = isObj(req.query) ? req.query : {};
  const vals: unknown[] = [tenantId];
  const where = ['p.tenant_id = $1'];
  const add = (v: unknown): string => { vals.push(v); return `$${vals.length}`; };
  if (q['status'] !== undefined) where.push(`p.status = ${add(q['status'] === 'suspended' ? 'suspended' : 'active')}`);
  if (typeof q['q'] === 'string' && q['q'] !== '') { const p = add(`%${q['q'].replace(/[\\%_]/g, '\\$&')}%`); where.push(`(p.partner_code ILIKE ${p} OR p.name ILIKE ${p})`); }
  const sort = q['sort'] === '-created_at' ? '-created_at' : 'partner_code';
  if (q['cursor'] !== undefined) {
    const c = decodeCursor(q['cursor'], sort);
    where.push(sort === 'partner_code' ? `p.partner_code > ${add(c.key)}` : `(p.created_at, p.id) < (${add(c.key)}::timestamptz, ${add(c.id)}::uuid)`);
  }
  const n = Number(q['limit']);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
  const order = sort === 'partner_code' ? 'p.partner_code ASC' : 'p.created_at DESC, p.id DESC';
  const { rows } = await tx(ctx).query(`SELECT ${COLS} ${FROM}WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${add(limit + 1)}`, vals);
  const page = rows.slice(0, limit) as PartnerRow[];
  const cps = new Map<string, CreditPartyRef>(); const centres = new Map<string, CentreRef>();
  for (const r of page) { // one port call per distinct id; display purpose only
    if (!cps.has(r.credit_party_id)) cps.set(r.credit_party_id, await creditParty(ctx, r.credit_party_id));
    if (!centres.has(r.receiving_centre_id)) centres.set(r.receiving_centre_id, await centreOf(ctx, r.receiving_centre_id));
  }
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  const key = (r: PartnerRow): string => (sort === 'partner_code' ? r.partner_code : String(r.created_key ?? new Date(r.created_at).toISOString()));
  return { status: 200, body: {
    data: page.map((r) => toPartnerAdminSummaryDto(r, cps.get(r.credit_party_id)!, centres.get(r.receiving_centre_id)!)),
    page: { limit, ...(last ? { next_cursor: encodeCursor(sort, key(last), last.id) } : {}) },
  } };
}

// ---- SA3 ----
export async function get(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, READ);
  return { status: 200, body: await toDto(ctx, await loadDetail(ctx, tenantId, partnerId(req))) };
}

// ---- SA2 ----
export async function create(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const b = body(req);
  const code = str(b['partner_code']) ?? invalid();
  const name = str(b['name']) ?? invalid();
  const cpId = str(b['credit_party_id']) ?? invalid();
  const branchId = str(b['receiving_branch_id']) ?? invalid();
  const centreId = str(b['receiving_centre_id']) ?? invalid();

  const cp = await creditParty(ctx, cpId);
  if (!cp.isActive) throw new LimsError('partners.credit_party_inactive');
  const centre = await checkPlace(ctx, branchId, centreId);

  let mode = str(b['conversion_mode']);
  if (mode === undefined) { // tenant default; no row yet = on_receipt (05-SCHEMA §3.8)
    const s = await tx(ctx).query('SELECT default_conversion_mode FROM partners.settings WHERE tenant_id = $1', [tenantId]);
    mode = str(s.rows[0]?.['default_conversion_mode']) ?? 'on_receipt';
  }
  const id = uuidv7();
  const ins = await tx(ctx).query(
    'INSERT INTO partners.partners (id, tenant_id, partner_code, name, credit_party_id, receiving_branch_id, receiving_centre_id, conversion_mode, contact_email, contact_phone_e164, address_text, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) ON CONFLICT DO NOTHING RETURNING id',
    [id, tenantId, code, name, cpId, branchId, centreId, mode, str(b['contact_email']) ?? null, str(b['contact_phone_e164']) ?? null, str(b['address_text']) ?? null, actorId],
  ).catch((e: { code?: string; constraint?: string }) => { throw e?.code === '23505' ? duplicate(/credit_party/.test(e.constraint ?? '')) : e; });
  if (ins.rows.length === 0) { // lost a race or a pre-existing row: which unique key?
    const hit = await tx(ctx).query('SELECT id FROM partners.partners WHERE tenant_id = $1 AND partner_code = $2', [tenantId, code]);
    throw duplicate(hit.rows.length === 0);
  }
  // same tx (TRD §10.2): the lazy settings row; an existing one is never overwritten
  await tx(ctx).query('INSERT INTO partners.settings (tenant_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, actorId]);
  await enqueue(ctx, tenantId, id, ['price_list', 'statements']);
  return { status: 201, body: await toDto(ctx, await loadDetail(ctx, tenantId, id), { cp, centre }) };
}
const duplicate = (creditParty: boolean): LimsError => new LimsError(creditParty ? 'partners.credit_party_in_use' : 'partners.code_duplicate');

// ---- SA4 ----
const OPTIONAL = ['contact_email', 'contact_phone_e164', 'address_text'] as const;
export async function update(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req);
  const id = partnerId(req);
  const b = body(req);
  const cur = await lock(ctx, tenantId, id, expected);

  const sets: string[] = []; const vals: unknown[] = [tenantId, id, expected];
  const set = (col: string, v: unknown): void => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const unset = b['unset'] === undefined ? [] : Array.isArray(b['unset']) ? b['unset'] : invalid();
  for (const u of unset as unknown[]) { // only the nullable columns; everything else is NOT NULL
    if (typeof u !== 'string' || !(OPTIONAL as readonly string[]).includes(u) || b[u] !== undefined) invalid();
    if (!sets.some((s) => s.startsWith(`${u} =`))) sets.push(`${u} = NULL`);
  }
  for (const col of ['name', 'conversion_mode', ...OPTIONAL] as const) { const v = str(b[col]); if (v !== undefined) set(col, v); }
  const branchId = str(b['receiving_branch_id']); const centreId = str(b['receiving_centre_id']);
  if (branchId !== undefined || centreId !== undefined) {
    const nb = branchId ?? String(cur['receiving_branch_id']); const nc = centreId ?? String(cur['receiving_centre_id']);
    await checkPlace(ctx, nb, nc);
    if (branchId !== undefined) set('receiving_branch_id', branchId);
    if (centreId !== undefined) set('receiving_centre_id', centreId);
  }
  if (sets.length === 0) invalid(); // nothing to change; credit_party_id, partner_code, status, tenant_id, version are never settable here
  set('updated_by', actorId);
  await bump(ctx, sets, vals);
  await enqueue(ctx, tenantId, id, ['price_list']); // TRD §8.1: centre/mode/contact changes feed the price-list projection
  return { status: 200, body: await toDto(ctx, await loadDetail(ctx, tenantId, id)) };
}

/** UPDATE ... WHERE tenant_id = $1 AND id = $2 AND version = $3; vals[0..2] are those three. 0 rows = someone else changed it first. */
async function bump(ctx: HandlerContext, sets: string[], vals: unknown[]): Promise<void> {
  const r = await tx(ctx).query(
    `UPDATE partners.partners SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, vals);
  if (r.rows.length === 0) throw new LimsError('common.version_conflict');
}

// ---- SA5 ----
export async function suspend(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req);
  const id = partnerId(req);
  const b = body(req);
  const reason = str(b['reason_code']) ?? invalid();
  const reasonText = str(b['reason_text']) ?? null;
  // x-coded-set is annotation-only in core and the DDL has no CHECK/FK on suspend_reason_code (05-SCHEMA §7): validate here as payments refund.service activeCode
  const coded = (await tx(ctx).query('SELECT code, requires_text, is_active FROM partners.g_cs_reasons WHERE set_name = $1 AND code = $2',
    ['partner_suspend_reasons', reason])).rows.find((r) => r['code'] === reason);
  if (!coded || coded['is_active'] !== true) invalid();
  if (coded!['requires_text'] === true && !reasonText?.trim()) invalid();
  const cur = await lock(ctx, tenantId, id, expected);
  assertTransition(cur['status'] as PartnerStatus, 'suspended');
  // only the status flips: users, pickups and manifests stay as they are (03-APP-FLOW §2.4); partnerContext then answers 403 partners.partner_inactive
  await bump(ctx, ["status = 'suspended'", 'suspended_at = now()', 'suspended_by = $4', 'suspend_reason_code = $5', 'suspend_reason_text = $6', 'updated_by = $4'],
    [tenantId, id, expected, actorId, reason, reasonText]);
  return { status: 200, body: await toDto(ctx, await loadDetail(ctx, tenantId, id)) };
}

// ---- SA6 ----
export async function reactivate(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, MANAGE);
  const expected = ifMatch(req);
  const id = partnerId(req);
  const cur = await lock(ctx, tenantId, id, expected);
  assertTransition(cur['status'] as PartnerStatus, 'active');
  const cp = await creditParty(ctx, String(cur['credit_party_id'])); // the partner's own party, never a request value
  if (!cp.isActive) throw new LimsError('partners.credit_party_inactive');
  await bump(ctx, ["status = 'active'", 'suspended_at = NULL', 'suspended_by = NULL', 'suspend_reason_code = NULL', 'suspend_reason_text = NULL', 'updated_by = $4'], [tenantId, id, expected, actorId]);
  await enqueue(ctx, tenantId, id, ['price_list', 'statements']);
  return { status: 200, body: await toDto(ctx, await loadDetail(ctx, tenantId, id), { cp }) };
}

// ---- SA7 ----
export async function resync(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, MANAGE);
  const id = partnerId(req);
  const raw = body(req)['scopes'];
  const scopes = Array.isArray(raw) ? [...new Set(raw)] : invalid();
  if (scopes.length === 0 || !scopes.every((s): s is Scope => typeof s === 'string' && Object.hasOwn(JOBS, s))) invalid();
  const { rows } = await tx(ctx).query('SELECT id FROM partners.partners WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (rows.length === 0) notFound(); // a foreign id never enqueues work
  await enqueue(ctx, tenantId, id, scopes as Scope[]);
  return { status: 202, body: {} };
}
