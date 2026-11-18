// T0B-MSGDESK-1 (LD-321): SQL of the broadcast desk (engagement.broadcast_template, broadcast, broadcast_recipient; migration 20261117240000).
// Every statement is parameterised and carries tenant_id = $1 on top of RLS. Column lists are fixed text; only closed enums choose SQL fragments.
// AUDIENCE: one statement per call (UNION ALL over the asked party kinds), so preview, draft count, request recount and the frozen list at approval
// read the same rows for the same filter and data (done_when 2). [CONV] sources, pinned by the T0B-MSGDESK-1 tests and flagged in .orchestra/cr/T0B-MSGDESK-1.md:
//   laboratory = partners.partners (status active), client = catalog.credit_parties (kind <> partner_lab, is_active),
//   franchise = core.collection_centres (centre_kind franchise, is_active) with the oldest active reporting.centre_contacts row of the channel,
//   lab_user = core.memberships (actor_type user, status active) + core.users (is_active). Address: phone for sms / whatsapp, email for email.
//   A party with no address for the channel is not a recipient (never counted, never queued).
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
export type Row = Record<string, any>;
export type Channel = 'sms' | 'whatsapp' | 'email';
export type PartyKind = 'laboratory' | 'franchise' | 'client' | 'lab_user';

const TPL_COLS = 'id, name, channel, subject, body, is_active, version, created_at, updated_at';
const B_COLS = 'id, template_id, audience_filter, status, recipient_count, opted_out_count, requested_by, approved_by, approved_at, created_at, updated_at, version';
const R_COLS = 'id, broadcast_id, party_kind, party_id, channel_address, status, skip_reason, outbox_id, created_at';

// ---------- templates ----------
export const listTemplates = async (tx: Q, a: { tenantId: string; isActive?: boolean; channel?: Channel; limit: number; offset: number }): Promise<Row[]> => {
  const v: unknown[] = [a.tenantId];
  let w = '';
  if (a.isActive !== undefined) { v.push(a.isActive); w += ` AND is_active = $${v.length}`; }
  if (a.channel !== undefined) { v.push(a.channel); w += ` AND channel = $${v.length}`; }
  v.push(a.limit + 1, a.offset);
  return (await tx.query(`SELECT ${TPL_COLS} FROM engagement.broadcast_template WHERE tenant_id = $1${w} ORDER BY name, id LIMIT $${v.length - 1} OFFSET $${v.length}`, v)).rows;
};
export const getTemplate = async (tx: Q, a: { tenantId: string; id: string; lock?: boolean }): Promise<Row | undefined> =>
  (await tx.query(`SELECT ${TPL_COLS} FROM engagement.broadcast_template WHERE tenant_id = $1 AND id = $2${a.lock ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id])).rows[0];
export const insertTemplate = async (tx: Q, a: { id: string; tenantId: string; name: string; channel: Channel; subject: string | null; body: string; actorId: string }): Promise<Row> =>
  (await tx.query(`INSERT INTO engagement.broadcast_template (id, tenant_id, name, channel, subject, body, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${TPL_COLS}`,
    [a.id, a.tenantId, a.name, a.channel, a.subject, a.body, a.actorId])).rows[0];
export const updateTemplate = async (tx: Q, a: { tenantId: string; id: string; version: number; name: string; subject: string | null; body: string; isActive: boolean; actorId: string }): Promise<Row | undefined> =>
  (await tx.query(`UPDATE engagement.broadcast_template SET name = $4, subject = $5, body = $6, is_active = $7, version = version + 1, updated_at = now(), updated_by = $8
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${TPL_COLS}`, [a.tenantId, a.id, a.version, a.name, a.subject, a.body, a.isActive, a.actorId])).rows[0];

// ---------- provider (LD-321: real sending needs a provider the founder configured; the recording adapter never reaches a handset) ----------
export const hasProvider = async (tx: Q, a: { tenantId: string; channel: Channel }): Promise<boolean> =>
  (await tx.query(`SELECT 1 FROM reporting.channel_accounts WHERE tenant_id = $1 AND channel = $2 AND is_active = true AND provider_kind <> 'recording' LIMIT 1`, [a.tenantId, a.channel])).rows.length > 0;

// ---------- audience ----------
const ADDR: Record<Channel, { phone: boolean }> = { sms: { phone: true }, whatsapp: { phone: true }, email: { phone: false } };
function source(kind: PartyKind, channel: Channel): string {
  const phone = ADDR[channel].phone;
  switch (kind) {
    case 'laboratory':
      return `SELECT 'laboratory'::text AS party_kind, p.id AS party_id, p.name AS party_name, ${phone ? 'p.contact_phone_e164' : 'p.contact_email'} AS address
        FROM partners.partners p WHERE p.tenant_id = $1 AND ($2::boolean = false OR p.status = 'active')`;
    case 'client':
      return `SELECT 'client'::text, c.id, c.name, ${phone ? 'c.contact_phone_e164' : 'c.contact_email'}
        FROM catalog.credit_parties c WHERE c.tenant_id = $1 AND c.kind <> 'partner_lab' AND ($2::boolean = false OR c.is_active)`;
    case 'franchise':
      return `SELECT 'franchise'::text, cc.id, cc.name,
          (SELECT k.address FROM reporting.centre_contacts k WHERE k.tenant_id = cc.tenant_id AND k.centre_id = cc.id AND k.channel = $3 AND k.is_active ORDER BY k.created_at, k.id LIMIT 1)
        FROM core.collection_centres cc WHERE cc.tenant_id = $1 AND cc.centre_kind = 'franchise' AND ($2::boolean = false OR cc.is_active)`;
    case 'lab_user':
      return `SELECT 'lab_user'::text, m.id, u.display_name, ${phone ? 'u.phone_e164' : 'u.email_normalized'}
        FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.actor_type = 'user' AND ($2::boolean = false OR (m.status = 'active' AND u.is_active))`;
  }
}
const audienceCte = (kinds: readonly PartyKind[], channel: Channel) =>
  `WITH ch AS (SELECT $3::text AS channel), a (party_kind, party_id, party_name, address) AS (${kinds.map((k) => source(k, channel)).join(' UNION ALL ')}) `; // ch types $3 when no franchise source uses it
const WHERE_ADDR = `WHERE a.address IS NOT NULL AND char_length(a.address) BETWEEN 1 AND 254`;
const args = (a: { tenantId: string; activeOnly: boolean; channel: Channel }) => [a.tenantId, a.activeOnly, a.channel];

/** Count plus the first `sample` rows, in ONE statement (count(*) OVER () runs before LIMIT). */
export async function audiencePreview(tx: Q, a: { tenantId: string; kinds: readonly PartyKind[]; activeOnly: boolean; channel: Channel; sample: number }): Promise<{ count: number; rows: Row[] }> {
  const { rows } = await tx.query(`${audienceCte(a.kinds, a.channel)}SELECT a.party_kind, a.party_id, a.address, count(*) OVER () AS n FROM a ${WHERE_ADDR}
    ORDER BY a.party_kind, a.party_id LIMIT ${Math.trunc(a.sample)}`, args(a));
  return { count: rows.length ? Number(rows[0].n) : 0, rows };
}
export async function audienceCount(tx: Q, a: { tenantId: string; kinds: readonly PartyKind[]; activeOnly: boolean; channel: Channel }): Promise<number> {
  const { rows } = await tx.query(`${audienceCte(a.kinds, a.channel)}SELECT count(*) AS n FROM a ${WHERE_ADDR}`, args(a));
  return Number(rows[0]?.n ?? 0);
}
/** The recipient list itself, at most `max` rows (the caller asks cap + 1 to detect an audience above the cap). */
export const audienceRows = async (tx: Q, a: { tenantId: string; kinds: readonly PartyKind[]; activeOnly: boolean; channel: Channel; max: number }): Promise<Row[]> =>
  (await tx.query(`${audienceCte(a.kinds, a.channel)}SELECT a.party_kind, a.party_id, a.party_name, a.address FROM a ${WHERE_ADDR}
    ORDER BY a.party_kind, a.party_id LIMIT ${Math.trunc(a.max)}`, args(a))).rows;

// ---------- broadcasts ----------
export const listBroadcasts = async (tx: Q, a: { tenantId: string; status?: string; limit: number; offset: number }): Promise<Row[]> => {
  const v: unknown[] = [a.tenantId];
  let w = '';
  if (a.status !== undefined) { v.push(a.status); w = ` AND status = $${v.length}`; }
  v.push(a.limit + 1, a.offset);
  return (await tx.query(`SELECT ${B_COLS} FROM engagement.broadcast WHERE tenant_id = $1${w} ORDER BY created_at DESC, id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v)).rows;
};
export const getBroadcast = async (tx: Q, a: { tenantId: string; id: string; lock?: boolean }): Promise<Row | undefined> =>
  (await tx.query(`SELECT ${B_COLS} FROM engagement.broadcast WHERE tenant_id = $1 AND id = $2${a.lock ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id])).rows[0];
export const insertBroadcast = async (tx: Q, a: { id: string; tenantId: string; templateId: string; filter: object; recipientCount: number; optedOut: number; actorId: string }): Promise<Row> =>
  (await tx.query(`INSERT INTO engagement.broadcast (id, tenant_id, template_id, audience_filter, recipient_count, opted_out_count, requested_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7, $7) RETURNING ${B_COLS}`, [a.id, a.tenantId, a.templateId, JSON.stringify(a.filter), a.recipientCount, a.optedOut, a.actorId])).rows[0];
/** Guarded status move: only from `from`, only at `version`; 0 rows = someone else moved it first. */
export const moveBroadcast = async (tx: Q, a: { tenantId: string; id: string; version: number; from: readonly string[]; to: string; actorId: string;
  recipientCount?: number; optedOut?: number; approve?: boolean }): Promise<Row | undefined> =>
  (await tx.query(`UPDATE engagement.broadcast SET status = $5, version = version + 1, updated_at = now(), updated_by = $6,
       recipient_count = coalesce($7, recipient_count), opted_out_count = coalesce($8, opted_out_count),
       approved_by = CASE WHEN $9::boolean THEN $6 ELSE approved_by END, approved_at = CASE WHEN $9::boolean THEN now() ELSE approved_at END
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = ANY($4::text[]) RETURNING ${B_COLS}`,
    [a.tenantId, a.id, a.version, a.from, a.to, a.actorId, a.recipientCount ?? null, a.optedOut ?? null, a.approve === true])).rows[0];

// ---------- recipients ----------
export async function insertRecipients(tx: Q, a: { tenantId: string; broadcastId: string; actorId: string;
  rows: ReadonlyArray<{ id: string; kind: string; partyId: string; address: string; status: 'queued' | 'skipped'; skipReason: string | null }> }): Promise<void> {
  if (!a.rows.length) return;
  await tx.query(`INSERT INTO engagement.broadcast_recipient (id, tenant_id, broadcast_id, party_kind, party_id, channel_address, status, skip_reason, created_by)
    SELECT r.id, $1, $2, r.kind, r.party_id, r.address, r.status, r.skip_reason, $3
    FROM unnest($4::uuid[], $5::text[], $6::uuid[], $7::text[], $8::text[], $9::text[]) AS r(id, kind, party_id, address, status, skip_reason)`,
  [a.tenantId, a.broadcastId, a.actorId, a.rows.map((r) => r.id), a.rows.map((r) => r.kind), a.rows.map((r) => r.partyId), a.rows.map((r) => r.address),
    a.rows.map((r) => r.status), a.rows.map((r) => r.skipReason)]);
}
export async function setOutbox(tx: Q, a: { tenantId: string; broadcastId: string; rows: ReadonlyArray<{ id: string; outboxId: string; status: 'queued' | 'failed' }> }): Promise<void> {
  if (!a.rows.length) return;
  await tx.query(`UPDATE engagement.broadcast_recipient t SET outbox_id = r.outbox_id, status = r.status, updated_at = now()
    FROM unnest($3::uuid[], $4::uuid[], $5::text[]) AS r(id, outbox_id, status)
    WHERE t.tenant_id = $1 AND t.broadcast_id = $2 AND t.id = r.id`, [a.tenantId, a.broadcastId, a.rows.map((r) => r.id), a.rows.map((r) => r.outboxId), a.rows.map((r) => r.status)]);
}
export const listRecipients = async (tx: Q, a: { tenantId: string; broadcastId: string; status?: string; limit: number; offset: number }): Promise<Row[]> => {
  const v: unknown[] = [a.tenantId, a.broadcastId];
  let w = '';
  if (a.status !== undefined) { v.push(a.status); w = ` AND status = $${v.length}`; }
  v.push(a.limit + 1, a.offset);
  return (await tx.query(`SELECT ${R_COLS} FROM engagement.broadcast_recipient WHERE tenant_id = $1 AND broadcast_id = $2${w}
    ORDER BY party_kind, party_id LIMIT $${v.length - 1} OFFSET $${v.length}`, v)).rows;
};
