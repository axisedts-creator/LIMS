// T0B-ADMINPERM-1 shared helper (LD-310): the codes a tenant staff actor can never hold, and the staff set = registry minus those.
// Used by admin-all-permissions.test.ts and by every test that pins corp_admin (spec set UNION STAFF, LD-310 overrides 11-ROLE-MATRIX).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const ROOT = join(import.meta.dirname, '../../../../../../..');
export type RegEntry = { code: string; privileged: boolean; roles: string[] };
export const registry = (parse(readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8')) as { permissions: RegEntry[] }).permissions;
export const ALL = registry.map((p) => p.code);

// Codes a tenant staff actor can never hold. One line reason each. Everything else in the registry is a staff code.
export const EXCLUDED: Record<string, string> = {
  // platform staff: the provider's own identity, acts in a tenant only through a support session (REQ-SEC-063)
  'platform.tenant.read': 'platform staff only',
  'platform.tenant.manage': 'platform staff only',
  'platform.support_session.open': 'platform staff only',
  'platform.dead_letter.manage': 'platform staff only',
  'platform.staff.manage': 'platform staff only',
  // system actor
  'identity.signatory.read': 'system actor of reporting only',
  // portal and patient actors (fixed_actor_permissions.portal / patient / patient_pre_auth)
  'reporting.portal.view': 'portal and patient actors',
  'reporting.portal.download': 'portal and patient actors',
  'reporting.portal.challenge': 'portal actor',
  'engagement.self.read': 'patient actor',
  'engagement.self.manage': 'patient actor',
  'engagement.booking.create': 'patient actor',
  'engagement.link.redeem': 'patient actor',
  'engagement.payment.create': 'patient actor',
  'engagement.enquiry.create': 'patient actor',
  'engagement.auth.challenge': 'patient pre-auth stage only',
  // device actors (fixed_actor_permissions.device)
  'instruments.ingest.submit': 'device actor bridge_agent',
  'instruments.ingest.heartbeat': 'device actor bridge_agent',
  'instruments.ingest.host_query': 'device actor bridge_agent',
  'instruments.ingest.config_read': 'device actor bridge_agent',
  'instruments.ingest.enrol': 'device actor bridge_agent',
  'engagement.queue.board_read': 'device actor queue_display',
  // partner actors (fixed_actor_permissions.partner)
  'partners.order.read': 'partner actor',
  'partners.manifest.submit': 'partner actor',
  'partners.report.read': 'partner actor',
  'partners.statement.read': 'partner actor',
  'partners.price_list.read': 'partner actor',
  'partners.pickup.request': 'partner actor',
  'partners.referrer.read': 'partner actor',
  'partners.referrer.manage': 'partner_admin actor',
  'partners.partner_user.manage': 'partner_admin actor',
};
export const STAFF = ALL.filter((c) => !(c in EXCLUDED));
