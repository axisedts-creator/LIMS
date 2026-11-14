// C2-T29 traceability (07-SECURITY §6 "list complete"): every §6 test id is proven by a named test file that still contains the named anchor.
// A moved/deleted/renamed proof fails here. Ids with no DB-free proof are listed in LIVE_ONLY (DB / GoTrue needed) and must have a live/db file that exists.
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/security
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const API = 'services/api/src/modules/identity/';
const WORK = 'services/worker/src/jobs/identity/__tests__/';
const SEC = `${API}__tests__/security/`;

type Proof = [file: string, anchor: RegExp];
const T: Record<string, Proof[]> = {
  // 6.1 cross-tenant: runtime P-7 here; P-5 in the SQL suites; the rest see LIVE_ONLY
  'P-1': [[`${SEC}contract.security.test.ts`, /P-1 object-id operations/]],
  'P-2': [[`${API}service/__tests__/org.service.test.ts`, /P-2: branch of tenant B and a random branch id are rejected identically/], [`${API}service/__tests__/user.service.test.ts`, /foreign tenant/]],
  'P-3': [[`${API}service/__tests__/org.service.test.ts`, /tenant probes \(07-SECURITY P-2\/P-3/], [`${WORK}build_audit_export.test.ts`, /P-3, P-4/]],
  'P-4': [[`${WORK}build_audit_export.test.ts`, /P-4: tenant B rows never appear/]],
  'P-5': [['db/tests/identity/T0B-10.C2_policies.test.sql', /tenant isolation/]],
  'P-6': [[`${API}service/__tests__/support.integration.test.ts`, /P-6 support session of tenant A is worthless against tenant B/]],
  'P-8': [[`${API}service/__tests__/support.integration.test.ts`, /AC-E4\.6 \/ P-8/], [`${API}ports/__tests__/IdentityPort.c2.test.ts`, /platform actor without support session -> identity\.support_session_required/]],
  'P-7': [[`${API}__tests__/probes/platform-forbidden.probe.test.ts`, /P-7 platform operations as a tenant user/]],
  // 6.2
  'C-1': [[`${API}__tests__/audit-view.service.test.ts`, /C-1/]],
  'C-2': [[`${API}ports/__tests__/IdentityPort.c2.test.ts`, /assertRole/]],
  'C-3': [[`${API}ports/__tests__/IdentityPort.c2.test.ts`, /branch/i]],
  // 6.3
  'E-1': [[`${API}service/__tests__/role.service.test.ts`, /platform\.\*, actor-only and unknown codes/]],
  'E-2': [[`${API}service/__tests__/role.service.test.ts`, /E-2/]],
  'E-3': [[`${API}service/__tests__/tenant-access.handlers.test.ts`, /E-3/]],
  'E-4': [[`${API}claims/__tests__/resolver.test.ts`, /membership_inactive/], [`${API}claims/__tests__/resolver.test.ts`, /AC-A5\.1/]],
  'E-5': [[`${API}service/__tests__/support.integration.test.ts`, /E-5/]],
  'E-6': [[`${API}platform/__tests__/authz.test.ts`, /E-6/], [`${API}__tests__/probes/platform-forbidden.probe.test.ts`, /E-6/]],
  'E-7': [[`${API}claims/__tests__/resolver.test.ts`, /unauthenticated/]],
  'E-8': [[`${SEC}contract.security.test.ts`, /E-8 request bodies are closed/]],
  'E-9': [[`${API}handlers/__tests__/session.resolve.test.ts`, /E-9/]],
  // 6.4
  'AU-T1': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T1/]],
  'AU-T2': [[`${API}gotrue/__tests__/fake.contract.test.ts`, /AU-T2/]],
  'AU-T2a': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T2a/]],
  'AU-T2b': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T2b/]],
  'AU-T2c': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T2c/], [`${SEC}static.security.test.ts`, /AU-T2c no X-Forwarded-For/]],
  'AU-T2d': [[`${API}handlers/__tests__/session-kinds.login.test.ts`, /AU-T2d/]],
  'AU-T3': [[`${API}handlers/__tests__/mfa.verify.test.ts`, /AU-T3/]],
  'AU-T4': [[`${API}handlers/__tests__/recovery.setpassword.test.ts`, /AU-T4/]],
  'AU-T5': [[`${API}handlers/__tests__/recovery.request.test.ts`, /AU-T5/], [`${WORK}send_recovery.test.ts`, /AU-T5/]],
  'AU-T6': [[`${API}handlers/__tests__/recovery.confirm.test.ts`, /AU-T6/]],
  'AU-T7': [[`${API}handlers/__tests__/session.resolve.test.ts`, /AU-T7/]],
  'AU-T8': [[`${SEC}static.security.test.ts`, /AU-T8 session cookie attributes/]],
  'AU-T9': [[`${SEC}static.security.test.ts`, /AU-T9 staff web bundle/]],
  'AU-T10': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T10/]],
  'AU-T11': [[`${API}handlers/__tests__/recovery.setpassword.test.ts`, /AU-T11/]],
  'AU-T13': [[`${API}handlers/__tests__/session-kinds.app.test.ts`, /AU-T13/], [`${API}ports/__tests__/IdentityPort.t31.test.ts`, /AU-T13/]],
  'AU-T14': [[`${API}handlers/__tests__/session-kinds.login.test.ts`, /AU-T14/]],
  'AU-T15': [[`${API}handlers/__tests__/session-kinds.app.test.ts`, /AU-T15/]],
  'AU-T16': [[`${API}handlers/__tests__/session-kinds.app.test.ts`, /AU-T16/]],
  'AU-T17': [[`${API}handlers/__tests__/session-kinds.login.test.ts`, /AU-T17/]],
  'AU-T18': [[`${API}handlers/__tests__/session.resolve.test.ts`, /AU-T18/], [`${SEC}static.security.test.ts`, /no identity SQL writes core\.memberships\.is_active/]],
  'AU-T19': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T19/]],
  'AU-T20': [[`${API}service/__tests__/self.service.test.ts`, /AU-T20/]],
  'AU-T21': [[`${API}handlers/__tests__/mfa.verify.test.ts`, /AU-T21/], [`${SEC}contract.security.test.ts`, /AU-T21 pre-auth operations/]],
  'AU-T22': [[`${API}service/__tests__/self.service.test.ts`, /AU-T22/]],
  'AU-T23': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T23/]],
  'AU-T24': [[`${API}service/__tests__/auth.service.test.ts`, /AU-T24/]],
  // 6.5
  'D-T1': [[`${API}domain/__tests__/settings.ranges.test.ts`, /setting_out_of_range/], ['db/tests/identity/T0B-10.C2_schema.test.sql', /_ck|CHECK/i]],
  'D-T2': [[`${WORK}per_tenant.test.ts`, /pending_effective_fy_bs|pending/i], [`${API}service/__tests__/settings.service.test.ts`, /pending_effective_fy_bs|pending/i]],
  'D-T3': [[`${API}__tests__/audit-view.service.test.ts`, /D-T3/]],
  'D-T4': [[`${API}__tests__/audit-export.static.test.ts`, /D-T4/], [`${SEC}static.security.test.ts`, /no module-local spreadsheet formula guard/]],
  'D-T5': [[`${API}service/__tests__/branding.service.test.ts`, /SVG named \.svg/], [`${API}service/__tests__/branding.service.test.ts`, /infected/]],
  'D-T6': [[`${API}service/__tests__/settings.handlers.test.ts`, /approval_ref/], ['db/tests/identity/T0B-10.C2_schema.test.sql', /approval_ref/]],
  'D-T7': [[`${API}service/__tests__/user.service.test.ts`, /D-T7/], [`${SEC}contract.security.test.ts`, /D-T7 phone pattern/]],
  'D-T8': [[`${API}service/__tests__/user.service.test.ts`, /D-T8/]],
  'D-T9': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T9/]],
  'D-T10': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T10/]],
  'D-T11': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T11/], [`${SEC}contract.security.test.ts`, /D-T11/]],
  'D-T12': [[`${API}service/__tests__/dead-letter.static.test.ts`, /D-T12/], [`${SEC}static.security.test.ts`, /no identity SQL names core\.dead_letters/]],
  'D-T13': [[`${API}service/__tests__/tenant.service.test.ts`, /D-T13/]],
  'D-T14': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T14/]],
  'D-T15': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T15/]],
  'D-T16': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T16/]],
  'D-T17': [[`${API}service/__tests__/dead-letter.service.test.ts`, /D-T17/]],
  'D-T18': [[`${API}service/__tests__/dead-letter.static.test.ts`, /D-T18/]],
  'D-T19': [[`${WORK}maintenance.test.ts`, /D-T19/], [`${SEC}static.security.test.ts`, /D-T19/]],
  'D-T20': [[`${API}service/__tests__/branding.service.test.ts`, /D-T20/], [`${API}service/__tests__/ird.service.test.ts`, /D-T20/]],
  'D-T21': [[`${API}service/__tests__/tenant.service.test.ts`, /D-T21/], [`${API}service/__tests__/settings.service.test.ts`, /D-T21/]],
  'D-T22': [[`${API}__tests__/audit-export.service.test.ts`, /D-T22/]],
  'D-T23': [[`${API}service/__tests__/ird.readiness.test.ts`, /D-T23/]],
};

// §6 ids that need a real DB and/or GoTrue to prove. Each names the file that must exist as the home of its proof; the proof itself is NOT run by this pack.
const LIVE_ONLY: Record<string, string[]> = {
  'AU-T12': [`${API}gotrue/__tests__/http.live.test.ts`],            // GoTrue $2a$10$ hash prefix (needs the live GoTrue container)
};

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('07-SECURITY §6 traceability', () => {
  it('every §6 id of 07-SECURITY is either mapped or declared live-only (the list is complete)', () => {
    const spec = read('spec/chunks/C2-identity-admin/07-SECURITY.md');
    const sec = spec.slice(spec.indexOf('## 6. Required security tests'), spec.indexOf('## 7. Secrets used'));
    const ids = [...new Set([...sec.matchAll(/^- (P-\d+|C-\d+|E-\d+|AU-T\d+[a-d]?|D-T\d+) /gm)].map((m) => m[1]!))];
    expect(ids.length).toBeGreaterThan(70);
    const missing = ids.filter((i) => !(i in T) && !(i in LIVE_ONLY));
    expect(missing, 'ids of §6 with no proof mapping').toEqual([]);
    const stale = [...Object.keys(T), ...Object.keys(LIVE_ONLY)].filter((i) => !ids.includes(i));
    expect(stale, 'mapped ids that are not in §6').toEqual([]);
  });

  it.each(Object.entries(T).flatMap(([id, proofs]) => proofs.map(([f, re]) => [id, f, re] as const)))('%s proven in %s (anchor %s)', (_id, file, anchor) => {
    expect(existsSync(join(ROOT, file)), `${file} exists`).toBe(true);
    expect(read(file), `${file} lost its anchor`).toMatch(anchor);
  });

  it.each(Object.entries(LIVE_ONLY).flatMap(([id, fs]) => fs.map((f) => [id, f] as const)))('%s live proof home %s exists', (_id, file) => {
    expect(existsSync(join(ROOT, file))).toBe(true);
  });
});
