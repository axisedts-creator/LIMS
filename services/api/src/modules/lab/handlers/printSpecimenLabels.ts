// #14 POST /v1/lab/specimens/labels (02-TRD §5.1 row 14; AC-02.1, AC-02.3, AC-02.5): the only counter / access-log point of the label flow (08 A13 D-4, D-11)
import type { Handler } from '../../../core/module.js';
import { printSpecimenLabels } from '../service/label.service.js';

export const handler: Handler = (req, ctx) => printSpecimenLabels(ctx, req.body);
