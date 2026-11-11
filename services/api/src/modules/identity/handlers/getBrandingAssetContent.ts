// GET branding asset content (02-TRD §5.6; 08 A13 P-2). Bytes and headers come from ctx.download.stream via the service, unchanged.
import { bindSettings, obj } from './settings.http.js';

export const getBrandingAssetContent = bindSettings((s, ctx, req) => s.getBrandingAssetContent(ctx, { assetId: obj(req.params)['asset_id'] }));
