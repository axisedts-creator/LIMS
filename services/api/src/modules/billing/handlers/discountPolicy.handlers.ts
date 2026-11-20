// T0B-FINCTRL-1 (LD-321, LD-325 b, founder blanket authority LD-310) handlers of the accounting control masters of T0C-FINCTRL-1:
// listDiscountReasons, createDiscountReason, updateDiscountReason, listPartyDiscountSlabs, createPartyDiscountSlab, updatePartyDiscountSlab,
// deactivatePartyDiscountSlab, resolveDiscountSlab, listUserDiscountLimits, setUserDiscountLimit, listDiscountAuthorities, createDiscountAuthority,
// deactivateDiscountAuthority, getMyDiscountPolicy (holdLedgerEntry / releaseLedgerEntry live in accounts.handlers.ts).
// Schema, auth, x-permission (billing.discount_policy.read / billing.discount_policy.manage [privileged]) and Idempotency-Key replay are enforced by the core
// pipeline from contracts/openapi/billing.yaml; these map request -> service, fail closed without an authenticated context (bind), and the service re-validates.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { guarded } from './_guard.js';
import { createDiscountPolicyService, type DiscountPolicyService } from '../service/discountPolicy.service.js';
import { bind, obj } from './ledger.handlers.js';
import { ifMatch } from './settings.handlers.js';

let svc: DiscountPolicyService | undefined;
const service = (): DiscountPolicyService => (svc ??= createDiscountPolicyService());
const etag = (b: { version: number }) => ({ etag: `"${b.version}"` });
/** x-idempotency required: the pipeline replays; a direct call without the key is refused the same way. */
const needKey = (req: HandlerRequest) => {
  const k = obj(req.headers)['idempotency-key'];
  if (typeof k !== 'string' || k === '') throw new LimsError('common.idempotency_key_required');
};
const p = (req: HandlerRequest, k: string): unknown => obj(req.params)[k];

const discountPolicyHandlersRaw: Readonly<Record<string, Handler>> = Object.freeze({
  listDiscountReasons: bind(async (ctx, req) => ({ status: 200, body: await service().listReasons(ctx, req.query) })),
  createDiscountReason: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createReason(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  updateDiscountReason: bind(async (ctx, req) => {
    const b = await service().updateReason(ctx, { id: p(req, 'discount_reason_id'), expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  listPartyDiscountSlabs: bind(async (ctx, req) => ({ status: 200, body: await service().listSlabs(ctx, req.query) })),
  createPartyDiscountSlab: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createSlab(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  updatePartyDiscountSlab: bind(async (ctx, req) => {
    const b = await service().updateSlab(ctx, { id: p(req, 'party_discount_slab_id'), expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  deactivatePartyDiscountSlab: bind(async (ctx, req) => {
    const b = await service().updateSlab(ctx, { id: p(req, 'party_discount_slab_id'), expectedVersion: ifMatch(req), body: undefined, deactivate: true });
    return { status: 200, body: b, headers: etag(b) };
  }),
  resolveDiscountSlab: bind(async (ctx, req) => ({ status: 200, body: await service().resolve(ctx, req.query) })),
  listUserDiscountLimits: bind(async (ctx, req) => ({ status: 200, body: await service().listLimits(ctx, req.query) })),
  setUserDiscountLimit: bind(async (ctx, req) => {
    const b = await service().setLimit(ctx, { userId: p(req, 'user_id'), expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  listDiscountAuthorities: bind(async (ctx, req) => ({ status: 200, body: await service().listAuthorities(ctx, req.query) })),
  createDiscountAuthority: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createAuthority(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  deactivateDiscountAuthority: bind(async (ctx, req) => {
    const b = await service().deactivateAuthority(ctx, { id: p(req, 'discount_authority_id'), expectedVersion: ifMatch(req) });
    return { status: 200, body: b, headers: etag(b) };
  }),
  getMyDiscountPolicy: bind(async (ctx) => ({ status: 200, body: await service().myPolicy(ctx) })),
});

// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1): the contract x-permission is asked FIRST, before the wrapped handler reads or writes anything.
export const discountPolicyHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  ...discountPolicyHandlersRaw,
  listDiscountReasons: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['listDiscountReasons']!),
  createDiscountReason: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['createDiscountReason']!),
  updateDiscountReason: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['updateDiscountReason']!),
  listPartyDiscountSlabs: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['listPartyDiscountSlabs']!),
  createPartyDiscountSlab: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['createPartyDiscountSlab']!),
  updatePartyDiscountSlab: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['updatePartyDiscountSlab']!),
  deactivatePartyDiscountSlab: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['deactivatePartyDiscountSlab']!),
  resolveDiscountSlab: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['resolveDiscountSlab']!),
  listUserDiscountLimits: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['listUserDiscountLimits']!),
  setUserDiscountLimit: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['setUserDiscountLimit']!),
  listDiscountAuthorities: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['listDiscountAuthorities']!),
  createDiscountAuthority: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['createDiscountAuthority']!),
  deactivateDiscountAuthority: guarded('billing.discount_policy.manage', discountPolicyHandlersRaw['deactivateDiscountAuthority']!),
  getMyDiscountPolicy: guarded('billing.discount_policy.read', discountPolicyHandlersRaw['getMyDiscountPolicy']!),
});
