// GET feature flags of the tenant (02-TRD §5.6; AC-C5.1).
import { bindSettings } from './settings.http.js';
import { guarded } from './_guard.js';

export const listFeatureFlags = guarded('identity.settings.manage', bindSettings((s, ctx) => s.listFeatureFlags(ctx, {})));
