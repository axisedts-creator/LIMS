// POST /settings/branding-assets (02-TRD §5.6; US-C4; P-19). Multipart file + kind only; 201 BrandingAsset.
import { bindSettings, obj } from './settings.http.js';

export const uploadBrandingAsset = bindSettings((s, ctx, req) => {
  const b = obj(req.body);
  return s.uploadBrandingAsset(ctx, { file: b['file'], kind: b['kind'] });
});
