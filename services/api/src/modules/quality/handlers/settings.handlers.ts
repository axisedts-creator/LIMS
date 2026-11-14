// #51-#54 settings + coded sets (02-TRD §5.8). Schema, auth and x-permission are enforced by the core pipeline from contracts/openapi/quality.yaml; these map request -> service,
// set the ETag of #51/#52 (the settings row has a version; coded-set rows do not) and fail closed without a request context. Tenant and actor come from the context only.
import type { Handler } from '../../../core/module.js';
import { createSettingsService } from '../service/settings.service.js';
import { ifMatch, obj, staff } from './setup.handlers.js';

const settings = createSettingsService();   // methods are looked up per call
const p = (req: { params?: unknown }, k: string) => obj(req.params)[k];

export const settingsHandlers = Object.freeze({
  getQualitySettings: staff((c) => settings.getQualitySettings(c as any, {}) as any, { etag: true }),
  updateQualitySettings: staff((c, req) => settings.updateQualitySettings(c as any, { expectedVersion: ifMatch(req), body: req.body }) as any, { etag: true }),
  listQualityCodedSet: staff((c, req) => settings.listQualityCodedSet(c as any, { setName: p(req, 'set_name') }) as any),
  upsertQualityCode: staff((c, req) => settings.upsertQualityCode(c as any, { setName: p(req, 'set_name'), code: p(req, 'code'), body: req.body }) as any),
} satisfies Record<string, Handler>);
