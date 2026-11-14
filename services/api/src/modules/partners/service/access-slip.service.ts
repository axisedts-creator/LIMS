// C13 T14 — patient access slip R4 (request), R5 (poll), R6 (download). 02-TRD §5.2 R4-R6, §8.1; 03-APP-FLOW §5.5; 05-SCHEMA §3.7a; 07-SECURITY ST12, ST12a; 08 A2.1, A5.2, A5.3.
// Order (as T13 reports): actor type -> IdentityPort.assertRole(partners.report.read) -> partnerContext -> path validation (400 before any SQL on access_slips) -> R4: feature flag (403 before the report lookup) -> reads / insert.
// R4 makes NO port call under partner claims (ST12a): it INSERTs state `requested` (the only write a partner may do) and enqueues partners.issue_access_slip in the same transaction. Link / render / storage are the worker's (system actor).
// No column, job payload, log line or response of R4/R5/R6 carries the link: the URL exists only in the worker's memory and inside the stored PDF (R6 body).
// Every read of access_slips binds tenant_id AND partner_id (defence in depth next to RLS, ST2): a foreign / unknown / mismatching slip is one answer, 404 common.not_found.
// [CONV] R6 bytes go through ctx.download.stream (core helper, 08 A13 P-2): storage.read, then the access-log row (report.access_slip, allowed), no-store, nosniff, attachment. A missing object = 404, never an allowed row.
// [CONV] ponytail: R6 does not re-hash the object against file_sha256; add it (as R3, ST11) if the bucket is ever writable by anything but the worker.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { slip } from './observability.js';
import { uuidParam } from './partner-user.service.js';
import { gate, has, iso, PERM, type Obj, type Q } from './tracking.service.js';

const BUCKET = 'partners-slips';
const SETTINGS = 'SELECT access_slip_enabled FROM partners.settings WHERE tenant_id = $1';
const VALID_REPORT = "SELECT version_no, order_id FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2 AND report_id = $3 AND status = 'valid' ORDER BY version_no DESC LIMIT 1";
const INSERT = 'INSERT INTO partners.access_slips (tenant_id, id, partner_id, partner_user_id, report_id, version_no, order_id, state, created_at, created_by, updated_at, updated_by) '
  + "VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9, $8, $9)";
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
const ONE = 'SELECT id, report_id, version_no, state, created_at, link_id, link_expires_at, file_path, failure_code, issued_at FROM partners.access_slips WHERE tenant_id = $1 AND partner_id = $2 AND report_id = $3 AND id = $4';

const notFound = () => new LimsError('common.not_found');

/** R4 issuePatientAccessSlip */
export async function requestSlip(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.report);
  const reportId = uuidParam(req.params, 'report_id');
  const tx = ctx.tx as Q;
  const enabled = (await tx.query(SETTINGS, [ctx.tenantId])).rows[0]?.['access_slip_enabled']; // no row = default false (A17 P-22)
  if (enabled !== true) throw new LimsError('common.feature_disabled');
  const rep = (await tx.query(VALID_REPORT, [ctx.tenantId, ref.partnerId, reportId])).rows[0] as Obj | undefined;
  if (!rep) throw notFound(); // unknown / foreign / no valid version: one answer
  const id = uuidv7();
  const at = new Date(ctx.now() as string).toISOString();
  const versionNo = Number(rep['version_no']);
  await tx.query(INSERT, [ctx.tenantId, id, ref.partnerId, ref.partnerUserId, reportId, versionNo, rep['order_id'], at, ctx.actor!.id]);
  await tx.query(ENQUEUE, ['partners.issue_access_slip', JSON.stringify({ tenant_id: ctx.tenantId, access_slip_id: id }), `slip:${id}`]); // payload = ids only (ST12)
  slip(ctx, 'requested'); // T23: once per accepted request (a refusal above threw; an idempotent replay never re-runs the handler)
  return { status: 202, body: { id, report_id: reportId, version_no: versionNo, state: 'requested', created_at: at } };
}

async function find(req: HandlerRequest, ctx: HandlerContext): Promise<Obj> {
  const ref = await gate(ctx, PERM.report);
  const reportId = uuidParam(req.params, 'report_id');
  const slipId = uuidParam(req.params, 'access_slip_id');
  const row = (await (ctx.tx as Q).query(ONE, [ctx.tenantId, ref.partnerId, reportId, slipId])).rows[0] as Obj | undefined;
  if (!row) throw notFound();
  return row;
}

/** R5 getPatientAccessSlip: explicit allowlist, null columns omitted; never link_id, file columns or the link. */
export async function getSlip(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const r = await find(req, ctx);
  return {
    status: 200,
    body: {
      id: r['id'], report_id: r['report_id'], version_no: Number(r['version_no']), state: r['state'],
      ...(has(r['created_at']) ? { created_at: iso(r['created_at']) } : {}),
      ...(has(r['link_expires_at']) ? { link_expires_at: iso(r['link_expires_at']) } : {}),
      ...(has(r['failure_code']) ? { failure_code: r['failure_code'] } : {}),
      ...(has(r['issued_at']) ? { issued_at: iso(r['issued_at']) } : {}),
    },
  };
}

/** R6 downloadPatientAccessSlip: only an `issued` slip has a file (08 A5.3). */
export async function downloadSlip(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const r = await find(req, ctx);
  if (r['state'] !== 'issued' || typeof r['file_path'] !== 'string') throw notFound();
  const download = ctx.download as { stream(i: Obj): Promise<HandlerResult> } | undefined;
  if (!download) throw new LimsError('common.internal'); // fail closed
  const id = String(r['id']);
  const out = await download.stream({
    bucket: BUCKET, objectPath: r['file_path'], filename: `access-slip-${id}.pdf`, contentType: 'application/pdf', scanState: 'clean', // our own render, not an upload
    access: { action: 'report.access_slip', entityType: 'access_slip', entityId: id, outcome: 'allowed', detail: { access_slip_id: id, link_id: String(r['link_id'] ?? '') } },
  });
  if (out.status === 200) slip(ctx, 'downloaded'); // T23
  return out;
}
