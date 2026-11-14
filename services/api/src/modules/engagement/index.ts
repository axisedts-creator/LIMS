// Engagement ModuleManifest (02-TRD §3.2, 02-CONVENTIONS §2.2). Autoloaded from modules/engagement/index.ts.
// Boot checks (TRD §10.1): config is validated at import, so a bad LIMS_ENGAGEMENT_* set stops the process before it serves.
// Handlers not yet built are placeholders; the tasks that implement them replace them.
import type { ModuleManifest } from '../../core/module.js';
import { queueDisplayToken } from './auth/display.resolver.js';
import { patientPreAuth } from './auth/preauth.resolver.js';
import { loadEngagementConfig } from './config.js';
import { handlers } from './handlers/index.js';
import { engagementPort } from './ports/EngagementPort.impl.js';

export const config = loadEngagementConfig();

export const manifest: ModuleManifest = {
  name: 'engagement',
  openapi: 'contracts/openapi/engagement.yaml',
  handlers,
  // [CONV] 08 A17 P-20 / 06-PLAN T-01 override TRD §3.2 "ports: {}": C16 owns EngagementPort.
  ports: { EngagementPort: engagementPort },
  produces: ['engagement.booking.confirmed.v1', 'engagement.booking.cancelled.v1'],
  // TRD §9.3
  systemPermissions: [
    'engagement.self.read', 'engagement.booking.manage', 'engagement.booking.cancel', 'engagement.reminder.manage',
    'engagement.link.read', 'engagement.link.revoke', 'engagement.bookable_item.manage', 'engagement.membership.enrol',
  ],
  authResolvers: { patientPreAuth, queueDisplayToken }, // patientPreAuth: T-A2 (CR-C16-005); queueDisplayToken: T-Q3
};
