// #14a POST /v1/lab/orders/{order_id}/label-prints (CR-C4-010; x-idempotency none, E3; AC-02.2): readiness only, writes nothing (08 A13 D-4, A2.10)
import type { Handler } from '../../../core/module.js';
import { requestOrderLabelPrint } from '../service/label.service.js';

export const handler: Handler = (req, ctx) => requestOrderLabelPrint(ctx, req.params, req.body);
