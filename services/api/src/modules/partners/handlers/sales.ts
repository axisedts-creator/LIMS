// T0B-SALES-1 (LD-321, LD-325 b): the 15 sales hierarchy operations of partners.yaml (/v1/partners/admin/sales/...). Logic in service/sales.service.ts.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/sales.service.js';

export const listSalesDesignations: Handler = (req, ctx) => s.listDesignations(req, ctx);
export const createSalesDesignation: Handler = (req, ctx) => s.createDesignation(req, ctx);
export const updateSalesDesignation: Handler = (req, ctx) => s.updateDesignation(req, ctx);
export const listSalesRepresentatives: Handler = (req, ctx) => s.listRepresentatives(req, ctx);
export const createSalesRepresentative: Handler = (req, ctx) => s.createRepresentative(req, ctx);
export const updateSalesRepresentative: Handler = (req, ctx) => s.updateRepresentative(req, ctx);
export const deactivateSalesRepresentative: Handler = (req, ctx) => s.deactivateRepresentative(req, ctx);
export const getSalesTree: Handler = (req, ctx) => s.getTree(req, ctx);
export const assignPartyToRepresentative: Handler = (req, ctx) => s.assignParty(req, ctx);
export const unassignPartyFromRepresentative: Handler = (req, ctx) => s.unassignParty(req, ctx);
export const listRepresentativeClients: Handler = (req, ctx) => s.listClients(req, ctx);
export const listServiceAreas: Handler = (req, ctx) => s.listServiceAreas(req, ctx);
export const createServiceArea: Handler = (req, ctx) => s.createServiceArea(req, ctx);
export const updateServiceArea: Handler = (req, ctx) => s.updateServiceArea(req, ctx);
export const deactivateServiceArea: Handler = (req, ctx) => s.deactivateServiceArea(req, ctx);
