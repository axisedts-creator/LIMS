// A5 POST /v1/homecollection/devices/{device_id}/sign-off (homecollection.sync.upload; 204 / 409 unsynced_changes)
import type { Handler } from '../../../core/module.js';
import { signOffPhleboDevice } from '../device.service.js';

export const handler: Handler = (req, ctx) => signOffPhleboDevice(ctx, req.params, req.headers, req.body);
