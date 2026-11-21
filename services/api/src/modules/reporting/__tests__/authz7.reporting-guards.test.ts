// SEC-AUTHZ-7 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the reporting operations that the classifier snapshot shows as
// `unguarded` (40) or `guarded-other` (15: the narrative, print-profile and report-read rows whose handler asserts another permission or none for its own
// x-permission). Each handler is called directly (the central stage 8a is NOT in play; LIMS_CORE_AUTHZ_MODE stays shadow), so what is proven is the handler's OWN guard:
//   ctx.ports.IdentityPort.assertRole(ctx, { permission })  BEFORE any data is read or written (tx, events, jobs, storage, audit, other ports).
// Pinned interface (same as SEC-AUTHZ-5 catalog and SEC-AUTHZ-6 billing): it is the FIRST thing a handler does (before validation, Idempotency-Key, If-Match, tx);
// it throws LimsError auth.forbidden | auth.mfa_required | identity.support_session_required and the handler lets that through unchanged (no new error code);
// a context without IdentityPort.assertRole fails closed (nothing read). A later centre-scoped assertRole (after the row is loaded) may stay: this guard is the baseline.
// Expected permission = the operation's contract x-permission, unless the operation is in services/api/src/core/pipeline/authz-exceptions.json (then its
// handlerPermission) or is named in a SEC-AUTHZ-7 change request (.orchestra/cr/SEC-AUTHZ-7*.md: wrong contract x-permission, for the contract owner).
// NARRATIVE: reporting.narrative.write and reporting.narrative.sign are different permissions and stay different (the first is held by lab_technologist, the second is not).
// UNTOUCHED: verifyReportQr (public), receiveProviderCallback / verifyProviderCallback (path token) and the 9 portal-session operations never ask IdentityPort.
// Nothing is widened: no contract, permission registry, role pack or SQL file changes (the reviewer reads the git diff). Synthetic data only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { callbackHandlers } from '../handlers/callbacks.handlers.js';
import { deliveryHandlers } from '../handlers/delivery.handlers.js';
import { messagingAdminHandlers } from '../handlers/messaging-admin.handlers.js';
import { narrativeHandlers } from '../handlers/narrative.handlers.js';
import { narrativeImageHandlers } from '../handlers/narrative-image.handlers.js';
import { outsourcedHandlers } from '../handlers/outsourced.handlers.js';
import { portalHandlers } from '../handlers/portal.handlers.js';
import { printHandlers } from '../handlers/print.handlers.js';
import { printProfileHandlers } from '../handlers/printProfile.handlers.js';
import { regenerateHandlers } from '../handlers/regenerate.handlers.js';
import { releaseHandlers } from '../handlers/release.handlers.js';
import { reportsReadHandlers } from '../handlers/reports-read.handlers.js';
import { retryRenderHandlers } from '../handlers/retry-render.handlers.js';
import { settingsHandlers } from '../handlers/settings.handlers.js';
import { templatesHandlers } from '../handlers/templates.handlers.js';
import { verifyHandlers } from '../handlers/verify.handlers.js';

// same merge as modules/reporting/index.ts (importing the manifest would build the real ports)
const handlers: Record<string, any> = {
  ...settingsHandlers, ...outsourcedHandlers, ...narrativeImageHandlers, ...narrativeHandlers, ...templatesHandlers, ...retryRenderHandlers, ...printHandlers, ...regenerateHandlers,
  ...releaseHandlers, ...reportsReadHandlers, ...portalHandlers, ...verifyHandlers, ...deliveryHandlers, ...messagingAdminHandlers, ...callbackHandlers, ...printProfileHandlers,
};

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'reporting.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) if (op && typeof op === 'object' && op.operationId && op['x-permission']) xPerm[op.operationId] = op['x-permission'];
}
const packs: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const roleGrants = new Map<string, Set<string>>();
for (const p of packs.permissions as Array<{ code: string; roles?: string[] }>) for (const r of p.roles ?? []) (roleGrants.get(r) ?? roleGrants.set(r, new Set()).get(r)!).add(p.code);
const holders = (perm: string): string[] => (packs.permissions as Array<{ code: string; roles?: string[] }>).find((p) => p.code === perm)?.roles ?? [];

const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-7.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';

// Snapshot at the start of SEC-AUTHZ-7 (tests/security/authz-classification.json, contracts/openapi/reporting.yaml): class unguarded (40).
export const UNGUARDED_REPORTING = [
  'confirmOutsourcedReport', 'createCentreContact', 'createReportTemplate', 'downloadOutsourcedReport', 'downloadReportPrintPdf', 'getDelivery', 'getReport', 'getReportPrint',
  'getReportTemplate', 'getReportVersion', 'getReportingSettings', 'listCentreContacts', 'listChannelAccounts', 'listCriticalAlerts', 'listDeliveries', 'listMessageTemplates',
  'listOutsourcedItems', 'listOutsourcedReports', 'listPortalLinks', 'listReportTemplates', 'listReportingCodes', 'listReports', 'previewReportTemplate', 'publishReportTemplate',
  'releaseReportVersion', 'replaceStaffAssignments', 'retryDelivery', 'retryRenderReportVersion', 'revokePortalLink', 'revokeReportQrToken', 'rotateChannelCallbackToken',
  'sendReportDelivery', 'updateCentreContact', 'updateReportTemplateDraft', 'updateReportingSettings', 'uploadOutsourcedReport', 'upsertChannelAccount', 'upsertMessageTemplateText',
  'upsertReferrerPreference', 'withdrawOutsourcedReport',
] as const;
// class guarded-other: the classifier saw another permission in reachable code (narrative.sign, billing.settings.manage, lab.specimen.read, report.release ...); the own x-permission is not asserted.
export const GUARDED_OTHER_REPORTING = [
  'createNarrativeTemplate', 'createReportPrint', 'downloadReportVersionPdf', 'getNarrativeImageContent', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates',
  'listPrintProfiles', 'listSignatoryProfiles', 'previewPrintProfile', 'saveNarrativeDraft', 'searchReports', 'updateNarrativeTemplate', 'upsertPrintProfile', 'upsertSignatoryProfile',
] as const;
export const GROUP = [...UNGUARDED_REPORTING, ...GUARDED_OTHER_REPORTING] as const;
// the later authority rules (release second step, revoke / withdraw reasons) or the conditional extra permissions (report.release for an unreleased version, bulk_download) may still deny: that is their own check.
const AUTHORITY = new Set(['releaseReportVersion', 'revokeReportQrToken', 'revokePortalLink', 'withdrawOutsourcedReport', 'createReportPrint', 'downloadReportVersionPdf', 'searchReports']);
const UNTOUCHED = ['verifyReportQr', 'receiveProviderCallback', 'verifyProviderCallback', 'createPortalOtpChallenge', 'verifyPortalOtp', 'getPortalReport', 'downloadPortalReportPdf', 'requestPortalLinkReissue',
  'endPortalSession', 'getPortalDues', 'createPortalPaymentRequest', 'getPortalPaymentRequest'] as const;

const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined; // contract x-permission wrong: CR written, exactness not checked
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const anyKey = new Proxy({} as Record<string, string>, { get: (_t, p) => (typeof p === 'string' ? ID : undefined), has: () => true });
const req = { params: anyKey, query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'k-authz7-0001' }, body: {} };

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  // any access to the transaction, events, jobs, storage, audit or another port counts as data access: a denied request must touch none of them.
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return p === 'query' ? query : vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => new Date('2026-11-19T00:00:00Z').toISOString(),
    tx: touch('tx'), events: touch('events'), jobs: touch('jobs'), storage: touch('storage'), audit: touch('audit'),
    ports: withPort ? { IdentityPort: { assertRole: assert } } : {},
  };
  return { ctx, log, query, assert, asserted };
}
const run = async (op: string, ctx: any, r: any = req) => {
  try { await handlers[op](r, ctx); return undefined; } catch (e) { return e as any; }
};
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>, op: string) => expect(r.log.filter((x) => x !== 'assert'), `${op}: no data read or written before/without the guard`).toEqual([]);
afterEach(() => { vi.restoreAllMocks(); });

describe('SEC-AUTHZ-7 reporting: the snapshot list is real', () => {
  it('has 55 distinct operations, each in reporting.yaml with a runtime handler and a reporting.* x-permission', () => {
    expect(UNGUARDED_REPORTING.length).toBe(40);
    expect(GUARDED_OTHER_REPORTING.length).toBe(15);
    expect(new Set(GROUP).size).toBe(55);
    for (const op of GROUP) {
      expect(typeof handlers[op], op).toBe('function');
      expect(xPerm[op], op).toMatch(/^reporting\./);
    }
  });
});

describe('SEC-AUTHZ-7 reporting: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, repository, events, storage and audit spies not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r, op);
  });

  it.each(['auth.mfa_required', 'identity.support_session_required'])('release, revoke, send, template, settings and read operations pass %s through unchanged (no new error code)', async (code) => {
    for (const op of ['releaseReportVersion', 'revokeReportQrToken', 'sendReportDelivery', 'publishReportTemplate', 'updateReportingSettings', 'rotateChannelCallbackToken', 'getReport', 'listReports', 'saveNarrativeDraft']) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      noData(r, op);
    }
  });

  it('a failing IdentityPort (dependency down) fails closed: the handler rejects and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', async () => { throw new Error('identity store unavailable'); });
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject when assertRole fails`).toBeDefined();
      noData(r, op);
    }
  });

  it('no IdentityPort in the context fails closed: the handler rejects with a LimsError and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', denyAll(), false);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject without a port`).toBeInstanceOf(LimsError);
      noData(r, op);
    }
  });

  it('a user holding every reporting permission EXCEPT the one needed is denied (no adjacent permission is enough)', async () => {
    const all = new Set([...Object.values(xPerm), ...exceptions.map((e) => e.handlerPermission), 'lab.specimen.read', 'billing.settings.manage']);
    for (const op of GROUP) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all].filter((p) => p !== want))));
      const err = await run(op, r.ctx);
      expect(err?.code, `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r, op);
    }
  });
});

describe('SEC-AUTHZ-7 reporting: user with exactly the permission reaches the handler', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission; with exactly that grant the guard does not deny', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    if (want) expect(r.asserted[0], `${op} asks ${want} first`).toBe(want);
    if (want && !AUTHORITY.has(op)) {
      expect(err?.code, `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
      expect(err?.code, `${op} must not be denied for MFA or support session`).not.toBe('auth.mfa_required');
    }
  });
});

describe('SEC-AUTHZ-7 reporting: narrative write and narrative sign stay different permissions', () => {
  const WRITE = 'reporting.narrative.write';
  const SIGN = 'reporting.narrative.sign';
  it('the contract is unchanged: save / read / list narratives need write, sign and amend need sign, template admin needs template.manage', () => {
    for (const op of ['saveNarrativeDraft', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates', 'uploadNarrativeImage']) expect(xPerm[op], op).toBe(WRITE);
    for (const op of ['signNarrativeReport', 'startNarrativeAmendment']) expect(xPerm[op], op).toBe(SIGN);
    for (const op of ['createNarrativeTemplate', 'updateNarrativeTemplate']) expect(xPerm[op], op).toBe('reporting.template.manage');
    expect(holders(WRITE)).toEqual(expect.arrayContaining(['pathologist', 'radiologist', 'lab_technologist']));
    expect(holders(SIGN).sort()).toEqual(['pathologist', 'radiologist']);
  });
  it.each(['saveNarrativeDraft', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates'])('%s: asks narrative.write first (never sign in its place): a signer-only grant is denied before any data', async (op) => {
    const r = rig('user', grantOnly(new Set([SIGN])));
    const err = await run(op, r.ctx);
    expect(err?.code, `${op} must not accept sign instead of write`).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe(WRITE);
    noData(r, op);
  });
  it.each(['saveNarrativeDraft', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates'])('%s: lab_technologist (write, not sign) reaches the handler (nothing narrowed)', async (op) => {
    const grants = roleGrants.get('lab_technologist') ?? new Set<string>();
    expect(grants.has(WRITE)).toBe(true);
    expect(grants.has(SIGN)).toBe(false);
    const r = rig('user', grantOnly(grants));
    const err = await run(op, r.ctx);
    expect(err?.code, `${op} must work for lab_technologist`).not.toBe('auth.forbidden');
    expect(new Set(r.asserted), `${op} asks write only`).toEqual(new Set([WRITE]));
  });
  it.each(['signNarrativeReport', 'startNarrativeAmendment'])('%s never asks narrative.write in place of sign (a write-only role is not a signer)', async (op) => {
    const r = rig('user', grantOnly(new Set([WRITE])));
    const err = await run(op, r.ctx);
    expect(err, `${op} must not succeed for a write-only grant`).toBeDefined();
    expect(r.asserted.filter((p) => p === WRITE), op).toEqual([]);
  });
  it.each(['createNarrativeTemplate', 'updateNarrativeTemplate'])('%s: asks reporting.template.manage (not sign, not write)', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', grantOnly(new Set([SIGN, WRITE])));
    const err = await run(op, r.ctx);
    expect(err?.code).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe(want);
    expect(want).not.toBe(SIGN);
    noData(r, op);
  });
});

describe('SEC-AUTHZ-7 reporting: the default role packs keep their reporting access (nothing is widened, nothing is narrowed)', () => {
  const OPS = GROUP.filter((op) => !AUTHORITY.has(op) && !exceptions.some((e) => e.operationId === op) && !new RegExp(`\\b${op}\\b`).test(crText));
  it('the matrix covers pathologist, lab_manager, tenant_admin and front_desk', () => {
    const roles = new Set(OPS.flatMap((op) => holders(xPerm[op]!)));
    for (const role of ['pathologist', 'lab_manager', 'tenant_admin', 'lab_technologist']) expect(roles.has(role), role).toBe(true);
    expect(OPS.length).toBeGreaterThan(35);
  });
  for (const role of [...new Set(OPS.flatMap((op) => holders(xPerm[op]!)))]) {
    it(`${role}: every operation whose x-permission the role holds is not denied by the handler's own guard`, async () => {
      const grants = roleGrants.get(role) ?? new Set<string>();
      for (const op of OPS.filter((o) => grants.has(xPerm[o]!))) {
        const r = rig('user', grantOnly(grants));
        const err = await run(op, r.ctx);
        expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
        expect(err?.code, `${op} must work for ${role} (holds ${xPerm[op]})`).not.toBe('auth.forbidden');
      }
    });
  }
  it('an exception row is only for an operation whose handler really needs another permission: every role holding the x-permission also holds the handler permission', () => {
    for (const e of exceptions.filter((x) => (GROUP as readonly string[]).includes(x.operationId))) {
      for (const role of holders(xPerm[e.operationId]!)) {
        expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role} holds ${xPerm[e.operationId]} but not ${e.handlerPermission} (a role would lose access; correct the contract with a change request instead)`).toBe(true);
      }
    }
  });
});

describe('SEC-AUTHZ-7 reporting: patient, partner and portal actors are denied on staff operations', () => {
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(GROUP)(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
      noData(r, op);
    });
  }
});

describe('SEC-AUTHZ-7 reporting: public result delivery, the two provider callbacks (path token) and the portal-session operations are untouched', () => {
  it.each(UNTOUCHED)('%s never asks IdentityPort (their own credential is the check)', async (op) => {
    expect(typeof handlers[op], op).toBe('function');
    const r = rig('user', denyAll());
    await run(op, r.ctx);
    expect(r.assert, `${op} must not call assertRole`).not.toHaveBeenCalled();
  });
});

describe('SEC-AUTHZ-7 reporting: a denial leaks no id, token or email into any log line', () => {
  it('console output during denied calls carries no tenant, actor, session or person id', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); });
    for (const op of GROUP) await run(op, rig('user', denyAll()).ctx);
    for (const l of lines) {
      expect(l).not.toContain(TENANT);
      expect(l).not.toContain(ACTOR);
      expect(l).not.toContain(ID);
      expect(l).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});
