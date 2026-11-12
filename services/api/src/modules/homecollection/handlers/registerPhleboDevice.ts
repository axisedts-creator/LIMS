// A1 POST /v1/homecollection/devices (homecollection.sync.upload; 201 DeviceDto, 200 on re-register)
import type { Handler } from '../../../core/module.js';
import { registerPhleboDevice } from '../device.service.js';

export const handler: Handler = (req, ctx) => registerPhleboDevice(ctx, req.headers, req.body);
