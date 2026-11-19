// GET own IRD annexes (02-TRD §5.6; 03-APP-FLOW §2.5). Own annex records + referenced platform annex_1 + readiness.
import { bindSettings } from './settings.http.js';
import { guarded } from './_guard.js';

export const listOwnIrdAnnexes = guarded('identity.settings.manage', bindSettings((s, ctx) => s.listOwnIrdAnnexes(ctx, {})));
