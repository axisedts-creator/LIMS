// @lims/test-fixtures `actors` (C0 02-TRD §3.5). Fixed ids; per tenant: the 10 default roles of
// contracts/permissions.yaml (03-IC §11) + the special actors the probes need. No emails/phones (REQ-SEC-136).
import { tenants } from '../tenants/index.ts';

export type ActorType = 'user' | 'patient' | 'partner' | 'portal' | 'device' | 'system';
export interface Actor {
  readonly key: string;
  readonly id: string;
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly role?: string;
  readonly partnerRole?: 'partner_member' | 'partner_admin';
  readonly deviceKind?: 'bridge_agent' | 'queue_display';
  readonly aal?: 'aal1' | 'aal2';
  readonly locked: boolean;
  readonly centreIds?: readonly string[];
}

export const DEFAULT_ROLES = ['tenant_admin', 'front_desk', 'finance', 'lab_technologist', 'pathologist', 'lab_manager',
  'centre_staff', 'phlebotomist', 'owner_viewer', 'radiologist'] as const;

type Spec = Omit<Actor, 'id' | 'tenantId' | 'locked' | 'key'> & { readonly name: string; readonly locked?: boolean };

const SPECIALS: readonly Spec[] = [
  { name: 'centre_staff_centre1', actorType: 'user', role: 'centre_staff' }, // centreIds filled below
  { name: 'locked_user', actorType: 'user', role: 'front_desk', locked: true },
  { name: 'finance_aal1', actorType: 'user', role: 'finance', aal: 'aal1' }, // auth.mfa_required tests
  { name: 'partner_member', actorType: 'partner', partnerRole: 'partner_member' },
  { name: 'partner_admin', actorType: 'partner', partnerRole: 'partner_admin' },
  { name: 'patient', actorType: 'patient' },
  { name: 'portal_link', actorType: 'portal' },
  { name: 'bridge_agent', actorType: 'device', deviceKind: 'bridge_agent' },
  { name: 'queue_display', actorType: 'device', deviceKind: 'queue_display' },
  { name: 'system', actorType: 'system' },
];

const specs: readonly Spec[] = [...DEFAULT_ROLES.map((r): Spec => ({ name: r, actorType: 'user', role: r })), ...SPECIALS];

export const actors: readonly Actor[] = (['tenant_a', 'tenant_b'] as const).flatMap((k) => {
  const t = tenants[k];
  const nibble = k === 'tenant_a' ? 'a' : 'b';
  return specs.map(({ name, locked, ...rest }, i): Actor => ({
    ...rest,
    key: `${k}.${name}`,
    // [CONV] same id family as tenants: <tenant nibble>3<nn>
    id: `01a1a98a-ac40-7000-8000-00000000${nibble}3${i.toString(16).padStart(2, '0')}`,
    tenantId: t.id,
    locked: locked ?? false,
    ...(name === 'centre_staff_centre1' ? { centreIds: [t.centres[0]!.id] } : {}),
  }));
});
