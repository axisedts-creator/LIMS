// H16 GET /v1/homecollection/devices (homecollection.device.manage; privileged)
import type { Handler } from '../../../core/module.js';
import { listPhleboDevices } from '../deviceAdmin.service.js';

export const handler: Handler = (req, ctx) => listPhleboDevices(ctx, req.query);
