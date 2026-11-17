// #1 POST /v1/lab/specimens/lookup (body: barcode | registration_no; 02-TRD §5.1 row 1; AC-04.2)
import type { Handler } from '../../../core/module.js';
import { lookupSpecimenByBarcode } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => lookupSpecimenByBarcode(ctx, req.body);
