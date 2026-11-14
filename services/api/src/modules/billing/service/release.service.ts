// B14 createReleaseOverride and the release-eligibility decision behind B15 / BillingPort.getReleaseEligibility (02-TRD §5 B14/B15, §6.2 rules 1–6; PRD US-BL-07.1/.2;
// 07-SECURITY REQ-SEC-062/067). Runs in the caller's transaction (ctx.tx). Tenant and actor come from ctx only; order existence and centre come from
// ctx.ports.FrontdeskPort.getOrderSummary (tenant-scoped, common.not_found otherwise). The override table is append-only; the free reason text never reaches the activity log.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { toPaisa } from '../domain/money/paisa.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { decideRelease, releasePolicyEnforced, type BalanceCtx, type ReleaseBasis } from './balance.service.js';
import { iso, isRec, UTC_INSTANT, UUID } from './invoiceRead.service.js';

export type ReleaseCtx = BalanceCtx & { readonly ports?: Record<string, any> };
export interface OrderSummary { readonly branchId: string; readonly centreId: string; readonly billingMode?: string }
type Npr = { amountPaisa: number; currency: 'NPR' };
export interface Eligibility { orderId: string; eligible: boolean; basis: ReleaseBasis; balanceDue: Npr; overrideId?: string; evaluatedAt: string }

const CONTROL = /[\u0000-\u001f\u007f]/;
const invalid = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
export const npr = (amountPaisa: number): Npr => ({ amountPaisa, currency: 'NPR' });

export function session(ctx: ReleaseCtx): { tenantId: string; tx: never } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tenantId: ctx.tenantId, tx: ctx.tx as never };
}

/** The order must exist for this tenant (C6 answers common.not_found otherwise). A bad id is refused before any other call. */
export async function loadOrder(ctx: ReleaseCtx, orderId: unknown): Promise<{ orderId: string; summary: OrderSummary }> {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) throw invalid('/orderId');
  const fd = ctx.ports?.['FrontdeskPort'];
  if (!fd) throw new LimsError('common.internal');
  return { orderId, summary: (await fd.getOrderSummary(ctx, { orderId })) as OrderSummary };
}

export function createReleaseService(deps: { repo?: BillingRepo } = {}) {
  const repo = deps.repo ?? billingRepo;

  /** TRD §6.2, first match wins. Read only. */
  async function getEligibility(ctx: ReleaseCtx, input: unknown): Promise<Eligibility> {
    const { tenantId, tx } = session(ctx);
    const { orderId, summary } = await loadOrder(ctx, isRec(input) ? input['orderId'] : undefined);
    const now = ctx.now();
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    const invoiced = totals ? toPaisa(totals.invoiced_paisa) : 0, paid = totals ? toPaisa(totals.paid_paisa) : 0, credited = totals ? toPaisa(totals.credited_paisa) : 0;
    const billingMode = totals?.billing_mode ?? summary.billingMode ?? 'cash';
    const policyEnforced = await releasePolicyEnforced(ctx);   // unreadable policy = enforced (fail closed); a failing IdentityPort rejects
    const override = policyEnforced && billingMode !== 'credit' ? await repo.findActiveOverride(tx, { tenantId, orderId, at: now }) : undefined;
    const verdict = decideRelease({
      policyEnforced, billingMode, hasActiveOverride: override !== undefined, issuedInvoiceCount: totals ? Number(totals.issued_invoice_count) : 0,
      invoicedPaisa: invoiced, paidPaisa: paid, creditedPaisa: credited,
    });
    return {
      orderId, eligible: verdict.eligible, basis: verdict.basis, balanceDue: npr(invoiced - credited - paid),
      ...(verdict.basis === 'override' && override ? { overrideId: String(override['id']) } : {}), evaluatedAt: now,
    };
  }

  /** B14: one append-only row for the calling membership at the order's centre + one `override_created` activity row. No event, no ledger / balance write. */
  async function createOverride(ctx: ReleaseCtx, input: unknown): Promise<{ overrideId: string; createdAt: string }> {
    const { tenantId, tx } = session(ctx);
    const membershipId = ctx.actor.membershipId;
    if (ctx.actor.type !== 'user' || membershipId === undefined) throw new LimsError('auth.forbidden');   // only a person can override (REQ-SEC-062)
    const raw = isRec(input) ? input : {};
    const bad: string[] = [];
    const code = raw['reasonCode'];
    if (typeof code !== 'string' || code.length < 1 || code.length > 64 || CONTROL.test(code)) bad.push('/reasonCode');
    const text = raw['reasonText'];
    if (text !== undefined && (typeof text !== 'string' || text.length > 500)) bad.push('/reasonText');
    const exp = raw['expiresAt'];
    if (exp !== undefined && (typeof exp !== 'string' || !UTC_INSTANT.test(exp) || Number.isNaN(Date.parse(exp)))) bad.push('/expiresAt');
    if (typeof raw['orderId'] !== 'string' || !UUID.test(raw['orderId'])) bad.push('/orderId');
    if (bad.length) throw invalid(...bad);
    const { orderId, summary } = await loadOrder(ctx, raw['orderId']);

    const id = uuidv7();
    const row = await repo.insertReleaseOverride(tx, {
      id, tenantId, orderId, centreId: summary.centreId, reasonCode: code as string, reasonText: (text as string | undefined) ?? null, expiresAt: (exp as string | undefined) ?? null,
      membershipId, userId: ctx.actor.id,
    });
    if (!row) throw new LimsError('common.internal');
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: summary.centreId, action: 'override_created', document_kind: 'release_override', document_id: id, document_no: null,
      actor_id: ctx.actor.id, actor_membership_id: membershipId, actor_type: ctx.actor.type, occurred_at: ctx.now(), request_id: ctx.requestId ?? null,
      details: { order_id: orderId, reason_code: code, expires_at: exp ?? null }, created_by: ctx.actor.id,   // never the free reason text
    });
    return { overrideId: id, createdAt: iso(row['created_at']) };
  }
  return { getEligibility, createOverride };
}
export type ReleaseService = ReturnType<typeof createReleaseService>;
