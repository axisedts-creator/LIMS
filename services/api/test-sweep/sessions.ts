// T0B-SWEEP-1 (LD-269) done_when 3: the seven session kinds, the per-run ES256 test key and the session rows behind them.
// The private key lives only in memory; the public key is written by run.ts to os.tmpdir() (never the repo) for LIMS_CORE_JWT_KEY_FILE.
// Session rows are plain SQL on the throwaway local database; every JWT then goes through the REAL identity claimsResolver
// (app.identity_resolve_session DEFINER). Synthetic tenant_a ids come from db/seeds/010_core__synthetic_tenants.sql.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const SESSION_KINDS = [
  'platform_superadmin_aal2', 'platform_support_aal1', 'tenant_corp_admin', 'tenant_narrow', 'partner', 'patient', 'mobile_staff',
] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function createRunKey(): { publicKeyPem: string; sign(claims: Record<string, unknown>): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign(claims) {
      const input = `${b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
      const sig = cryptoSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${input}.${b64u(sig)}`;
    },
  };
}

// ---- synthetic tenant_a fixtures (seed 010) ----
export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
const SYSTEM_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
interface Spec {
  dbKind: 'platform' | 'tenant_staff' | 'partner' | 'patient' | 'staff_mobile';
  aal: 'aal1' | 'aal2'; user: string; membership?: string; platformRole?: string;
}
const SPECS: Record<SessionKind, Spec> = {
  platform_superadmin_aal2: { dbKind: 'platform', aal: 'aal2', user: '0193a5c0-5e0b-7000-8000-000000000001', platformRole: 'platform_superadmin' },
  platform_support_aal1: { dbKind: 'platform', aal: 'aal1', user: '0193a5c0-5e0b-7000-8000-000000000002', platformRole: 'platform_support' },
  tenant_corp_admin: { dbKind: 'tenant_staff', aal: 'aal2', user: '01a1a98a-ac40-7000-8000-00000000a300', membership: '01a1a98a-ac40-7000-8000-00000000a500' },
  tenant_narrow: { dbKind: 'tenant_staff', aal: 'aal1', user: '01a1a98a-ac40-7000-8000-00000000a301', membership: '01a1a98a-ac40-7000-8000-00000000a501' }, // front_desk
  partner: { dbKind: 'partner', aal: 'aal2', user: '01a1a98a-ac40-7000-8000-00000000a30e', membership: '01a1a98a-ac40-7000-8000-00000000a50e' }, // partner_admin
  patient: { dbKind: 'patient', aal: 'aal1', user: '01a1a98a-ac40-7000-8000-00000000a30f', membership: '01a1a98a-ac40-7000-8000-00000000a50f' },
  mobile_staff: { dbKind: 'staff_mobile', aal: 'aal1', user: '01a1a98a-ac40-7000-8000-00000000a307', membership: '01a1a98a-ac40-7000-8000-00000000a507' }, // phlebotomist
};
const SEEDED_ROLES: Partial<Record<SessionKind, string[]>> = {
  tenant_corp_admin: ['tenant_admin'], tenant_narrow: ['front_desk'], mobile_staff: ['phlebotomist'],
};

/** Permission set each kind holds, from contracts/permissions.yaml + the corp_admin role pack (what the sweep expects, not what the API says). */
export function permissionSets(repoRoot: string): Record<SessionKind, Set<string>> {
  const p = parse(readFileSync(join(repoRoot, 'contracts', 'permissions.yaml'), 'utf8')) as any;
  const byRole = (role: string) => (p.permissions as { code: string; roles?: string[] }[]).filter((x) => x.roles?.includes(role)).map((x) => x.code);
  const fixed = p.fixed_actor_permissions;
  const member: string[] = fixed.partner.partner_member;
  const admin: string[] = (fixed.partner.partner_admin as string[]).flatMap((c) => (c === '<partner_member set>' ? member : [c]));
  const packs = parse(readFileSync(join(repoRoot, 'services/api/src/modules/identity/role-packs/role-packs.data.yaml'), 'utf8')) as any;
  const corp: string[] = packs.packs.flatMap((k: any) => k.roles).find((r: any) => r.code === 'corp_admin').permissions;
  const s = (...l: string[][]) => new Set(l.flat());
  return {
    platform_superadmin_aal2: s(byRole('platform_superadmin')),
    platform_support_aal1: s(byRole('platform_support')),
    tenant_corp_admin: s(corp, ...SEEDED_ROLES.tenant_corp_admin!.map(byRole)),
    tenant_narrow: s(byRole('front_desk')),
    partner: s(admin),
    patient: s(fixed.patient),
    mobile_staff: s(byRole('phlebotomist')),
  };
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

// T0B-SWEEP-2 (LD-270 done_when 3, HARNESS): SWEEP-1's 18 partners operations answered 403 partners.partner_inactive because no
// partners.partners / partner_users row backs the partner membership (seed 010 has the membership only). Plain SQL on the throwaway DB, no seed edit.
const PARTNER = { creditParty: '01a1a98a-ac40-7000-8000-00000000f0c1', partner: '01a1a98a-ac40-7000-8000-00000000f0a1', partnerUser: '01a1a98a-ac40-7000-8000-00000000f0b1' };
export const BRANCH_A = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE_A = '01a1a98a-ac40-7000-8000-00000000a201';
export const SWEEP_PARTNER_ID = PARTNER.partner;

async function seedActivePartner(q: Query): Promise<void> {
  await q(`INSERT INTO catalog.credit_parties (id, tenant_id, party_code, name, kind, created_by, updated_by)
           VALUES ($1, $2, 'SWEEP-P1', 'Sweep Partner Lab (SYNTHETIC)', 'partner_lab', $3, $3) ON CONFLICT DO NOTHING`, [PARTNER.creditParty, TENANT_A, SYSTEM_ACTOR]);
  await q(`INSERT INTO partners.partners (id, tenant_id, partner_code, name, status, credit_party_id, receiving_branch_id, receiving_centre_id, conversion_mode, created_by, updated_by)
           VALUES ($1, $2, 'SWEEP-P1', 'Sweep Partner (SYNTHETIC)', 'active', $3, $4, $5, 'on_receipt', $6, $6) ON CONFLICT DO NOTHING`,
  [PARTNER.partner, TENANT_A, PARTNER.creditParty, BRANCH_A, CENTRE_A, SYSTEM_ACTOR]);
  await q(`INSERT INTO partners.partner_users (id, tenant_id, partner_id, membership_id, partner_role, status, display_name, email_masked, activated_at,
             invited_by_actor_type, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'partner_admin', 'active', 'Sweep Partner Admin (SYNTHETIC)', 's***@sweep.invalid', now(), 'user', $5, $5) ON CONFLICT DO NOTHING`,
  [PARTNER.partnerUser, TENANT_A, PARTNER.partner, SPECS.partner.membership, SYSTEM_ACTOR]);
}

/** Inserts platform_staff + session rows (superuser, throwaway DB) and gives tenant_a's corp_admin role to the corp_admin membership. */
export async function createSessions(q: Query, key: ReturnType<typeof createRunKey>, issuer: string, audience: string): Promise<Record<SessionKind, string>> {
  const tokens = {} as Record<SessionKind, string>;
  await q('BEGIN');
  try {
    await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT_A, sub: SYSTEM_ACTOR, actor_type: 'system' })]);
    const role = await q(`SELECT id FROM core.roles WHERE tenant_id = $1 AND role_code = 'corp_admin'`, [TENANT_A]);
    if (!role.rows[0]) throw new Error('sweep: role pack elabcorp_default did not create corp_admin in tenant_a');
    await q(`INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [TENANT_A, SPECS.tenant_corp_admin.membership, role.rows[0].id, SYSTEM_ACTOR]);
    await seedActivePartner(q);
    for (const kind of SESSION_KINDS) {
      const sp = SPECS[kind];
      const gotrue = randomUUID();
      let staffId: string | null = null;
      if (sp.dbKind === 'platform') {
        staffId = randomUUID();
        await q(`INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $6)`, [staffId, sp.user, `${kind}@sweep.invalid`, `Sweep ${kind} (SYNTHETIC)`, sp.platformRole, SYSTEM_ACTOR]);
      }
      const idle = sp.dbKind === 'patient' ? 1440 : sp.dbKind === 'staff_mobile' ? 60 : 30;
      const app = sp.dbKind === 'patient' || sp.dbKind === 'staff_mobile';
      await q(`INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, platform_staff_id, gotrue_session_id, token_sha256, state, aal,
                 refresh_token_enc, access_token_enc, enc_key_id, access_expires_at, idle_timeout_minutes, idle_expires_at, absolute_expires_at,
                 app_instance_id, app_platform, expires_at, created_by, updated_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $10, 'sweep', now() + interval '1 hour', $11, now() + interval '2 hours',
                 now() + interval '6 hours', $12, $13, now() + interval '6 hours', $14, $14)`,
        [randomUUID(), sp.dbKind === 'platform' ? null : TENANT_A, sp.dbKind, sp.user, sp.membership ?? null, staffId, gotrue,
          createHash('sha256').update(randomBytes(32)).digest(), sp.aal, randomBytes(32), idle,
          app ? randomUUID() : null, app ? 'android' : null, SYSTEM_ACTOR]);
      const now = Math.floor(Date.now() / 1000);
      tokens[kind] = key.sign({ iss: issuer, aud: audience, sub: sp.user, session_id: gotrue, aal: sp.aal, iat: now, exp: now + 4 * 3600, role: 'authenticated' });
    }
    await q('COMMIT');
  } catch (e) {
    await q('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return tokens;
}
