// #35 getLeveyJenningsChart (02-TRD §5.5, §7.10). Schema, auth and x-permission are enforced by the core pipeline from contracts/openapi/quality.yaml; this maps query -> service
// and fails closed without a request context. A computed view, not a resource: no ETag. Tenant and actor come from the context only.
import type { Handler } from '../../../core/module.js';
import { createChartService } from '../service/chart.service.js';
import { obj, staff } from './setup.handlers.js';

const chart = createChartService();   // methods are looked up per call

export const chartHandlers = Object.freeze({
  getLeveyJenningsChart: staff((c, req) => {
    const q = obj(req.query);
    return chart.getLeveyJenningsChart(c as any, {
      planId: q['plan_id'], view: q['view'], levelId: q['level_id'], lotId: q['lot_id'], observedAtFrom: q['observed_at_from'], observedAtTo: q['observed_at_to'],
    }) as any;
  }),
} satisfies Record<string, Handler>);
