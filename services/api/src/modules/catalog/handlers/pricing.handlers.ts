// #71–#81 price-list handlers (02-TRD §5 rows 71–81). Schema, auth, x-permission, aal2 and Idempotency-Key are the core pipeline's;
// these map request -> pricing.service and fail closed without an authenticated request context. Path params: price_list_id (#73–#76), price_list_version_id (#77–#81).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createPricingService, type PricingDeps } from '../service/pricing.service.js';
import { createQuoteService } from '../service/quote.service.js';
import type { Ctx } from '../service/masters.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createPricingService>;
type RCtx = Ctx & { events?: PricingDeps['events']; ports?: { IdentityPort?: PricingDeps['identity'] } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (s: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<RCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events) throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    return run(createPricingService({ events: c.events, ...(identity ? { identity } : {}) }), c as Ctx, req);
  };
}
const listId = (req: HandlerRequest) => obj(req.params)['price_list_id'];
const versionId = (req: HandlerRequest) => obj(req.params)['price_list_version_id'];

export const pricingHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listPriceLists: bind(async (s, ctx, req) => ({ status: 200, body: await s.listPriceLists(ctx, req.query) })),
  createPriceList: bind(async (s, ctx, req) => ({ status: 201, body: await s.createPriceList(ctx, req.body) })),
  getPriceListDetail: bind(async (s, ctx, req) => ({ status: 200, body: await s.getPriceListDetail(ctx, { id: listId(req) }) })),
  updatePriceList: bind(async (s, ctx, req) => ({ status: 200, body: await s.updatePriceList(ctx, { id: listId(req), expectedVersion: ifMatch(req), patch: req.body }) })),
  replacePriceListAssignments: bind(async (s, ctx, req) => ({
    status: 200, body: await s.replacePriceListAssignments(ctx, { id: listId(req), expectedVersion: ifMatch(req), body: req.body }),
  })),
  createPriceListVersionDraft: bind(async (s, ctx, req) => ({ status: 201, body: await s.createPriceListVersionDraft(ctx, { id: listId(req), body: req.body }) })),
  listPriceListItems: bind(async (s, ctx, req) => ({ status: 200, body: await s.listPriceListItems(ctx, { versionId: versionId(req), query: req.query }) })),
  upsertPriceListItems: bind(async (s, ctx, req) => ({ status: 200, body: await s.upsertPriceListItems(ctx, { versionId: versionId(req), body: req.body }) })),
  removePriceListItems: bind(async (s, ctx, req) => ({ status: 200, body: await s.removePriceListItems(ctx, { versionId: versionId(req), body: req.body }) })),
  publishPriceListVersion: bind(async (s, ctx, req) => ({
    status: 200, body: await s.publishPriceListVersion(ctx, { versionId: versionId(req), expectedVersion: ifMatch(req), body: req.body }),
  })),
  discardPriceListVersionDraft: bind(async (s, ctx, req) => ({
    status: 200, body: await s.discardPriceListVersionDraft(ctx, { versionId: versionId(req), expectedVersion: ifMatch(req) }),
  })),
  // T-19 #82: read-only POST, 200 with per-item errors in the body; needs no events port.
  quotePrices: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<RCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await createQuoteService().quotePrices(c as Ctx, req.body) };
  },
  // T-18 #83–#91. Path params: surcharge_rule_id, tax_type_id, tax_rule_id.
  listSurchargeRules: bind(async (s, ctx, req) => ({ status: 200, body: await s.listSurchargeRules(ctx, req.query) })),
  createSurchargeRule: bind(async (s, ctx, req) => ({ status: 201, body: await s.createSurchargeRule(ctx, req.body) })),
  endSurchargeRule: bind(async (s, ctx, req) => ({
    status: 200, body: await s.endSurchargeRule(ctx, { id: obj(req.params)['surcharge_rule_id'], expectedVersion: ifMatch(req), body: req.body }),
  })),
  listTaxTypes: bind(async (s, ctx, req) => ({ status: 200, body: await s.listTaxTypes(ctx, req.query) })),
  createTaxType: bind(async (s, ctx, req) => ({ status: 201, body: await s.createTaxType(ctx, req.body) })),
  updateTaxType: bind(async (s, ctx, req) => ({
    status: 200, body: await s.updateTaxType(ctx, { id: obj(req.params)['tax_type_id'], expectedVersion: ifMatch(req), patch: req.body }),
  })),
  listTaxRules: bind(async (s, ctx, req) => ({ status: 200, body: await s.listTaxRules(ctx, req.query) })),
  createTaxRule: bind(async (s, ctx, req) => ({ status: 201, body: await s.createTaxRule(ctx, req.body) })),
  endTaxRule: bind(async (s, ctx, req) => ({
    status: 200, body: await s.endTaxRule(ctx, { id: obj(req.params)['tax_rule_id'], expectedVersion: ifMatch(req), body: req.body }),
  })),
});
