// C12.T-15 handlers #69-#79 (02-TRD §5.5). Order, always:
//  * tenant-context operations (#69-#76, #78): permission gate (NO branchId; before any tx statement or validation) -> path id (400) -> If-Match (428 / 400) -> strict query / body (tx untouched) -> service;
//  * #77 / #79 (branch scope): path id -> If-Match -> strict body (tx untouched) -> service, which loads the fact (404), its store (404 invisible), then assertRole({permission, branchId}) (P-B8).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/consumption.service.js';
import { parseFactList, parseLogEvent, parsePreview, parseReason, parseResolve, parseRuleCreate, parseRuleDeactivate, parseRuleList, parseRuleSupersede } from './consumption.schemas.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const created = (body: unknown) => ({ status: 201, body });
const pathId = (req: HandlerRequest, name: string): string => {
  const v = isObj(req.params) ? req.params[name] : undefined;
  if (!isUuid(v)) throw invalid(fieldError(`/${name}`));
  return v;
};
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });

export const consumptionHandlers: Readonly<Record<string, Handler>> = {
  listConsumptionRules: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.listRules(ctx, parseRuleList(req.query)));
  },
  createConsumptionRule: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.masterManage);
    return created(await svc.createRule(ctx, parseRuleCreate(req.body)));
  },
  getConsumptionRule: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.getRule(ctx, pathId(req, 'rule_id')));
  },
  supersedeConsumptionRule: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.masterManage);
    const id = pathId(req, 'rule_id');
    const v = parseIfMatch(req.headers);
    return created(await svc.supersedeRule(ctx, id, v, parseRuleSupersede(req.body)));
  },
  deactivateConsumptionRule: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.masterManage);
    const id = pathId(req, 'rule_id');
    const v = parseIfMatch(req.headers);
    parseRuleDeactivate(req.body);
    return ok(await svc.deactivateRule(ctx, id, v));
  },
  previewConsumption: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.previewConsumption(ctx, parsePreview(req.body)));
  },
  listConsumptionFacts: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.listFacts(ctx, parseFactList(req.query)));
  },
  logConsumptionEvent: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.benchRecord);
    return created(await svc.logEvent(ctx, parseLogEvent(req.body)));
  },
  resolveConsumptionFact: async (req, ctx) => {
    const id = pathId(req, 'fact_id');
    const v = parseIfMatch(req.headers);
    return ok(await svc.resolveFact(ctx, id, v, parseResolve(req.body)));
  },
  dismissConsumptionFact: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.masterManage);
    const id = pathId(req, 'fact_id');
    const v = parseIfMatch(req.headers);
    return ok(await svc.dismissFact(ctx, id, v, parseReason(req.body)));
  },
  reverseConsumptionFact: async (req, ctx) => {
    const id = pathId(req, 'fact_id');
    const v = parseIfMatch(req.headers);
    return ok(await svc.reverseFact(ctx, id, v, parseReason(req.body)));
  },
};
