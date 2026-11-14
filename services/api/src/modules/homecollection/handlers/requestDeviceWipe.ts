// H17 POST /v1/homecollection/devices/{device_id}/wipe (homecollection.device.manage; privileged; If-Match "<version>"; 200 DeviceDto / 409 common.version_conflict)
import type { Handler } from '../../../core/module.js';
import { requestDeviceWipe } from '../deviceAdmin.service.js';

export const handler: Handler = (req, ctx) => requestDeviceWipe(ctx, req.params, req.headers, req.body);
