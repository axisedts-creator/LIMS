// E01 enrolAgent (02-TRD §7.1/§7.2; 03-APP-FLOW A2/A3/A5; 01-PRD AC-01.4-01.7, AC-02.2, AC-02.3; 07-SECURITY S-01, S-05, S-06).
// Also the shared device-request guards of E02/E03/E07/E08. Tenant, agent and credential come from the resolver claims only.
// Every unusable code / agent answers the same 401 auth.device_token_invalid (no oracle).
import { AuthError } from '../../../core/auth/errors.js';
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as agents.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { CredentialKind } from '../domain/credential.state.js';
import type { Row, Tx } from '../repo/agents.repo.js';
import { createDeviceRepo, type DeviceRepo } from '../repo/device.repo.js';
import { fail, isUuid } from './agents.service.js';
import { generateDeviceToken, requireCredentialKind } from './credentials.service.js';

export interface DeviceCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly claims?: { readonly credential_kind?: unknown; readonly credential_id?: unknown };
  readonly clientIp?: string;
  readonly requestId?: string;
  readonly tx: unknown;
  readonly now?: () => string | Date;
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };
}
export interface DeviceResult { status: number; body: any; headers?: Record<string, string> }

const FINGERPRINT = /^[0-9a-f]{64}$/;
const REPLACED_REASON = 'device_replaced';                 // A3, seeded g_cs_revoke_reasons (05-SCHEMA §2, ruling API-T06)
const ENROLLABLE = ['pending_enrolment', 'active', 'revoked'];   // A2 / A3 / A5; retired is terminal

export const deviceInvalid = () => new AuthError('auth.device_token_invalid');

/** Request context + credential kind gate. Runs before any repo access. */
export function deviceScope(ctx: DeviceCtx, kind: CredentialKind) {
  if (typeof ctx?.tenantId !== 'string' || !isUuid(ctx.tenantId) || ctx.actor?.type !== 'device' || !isUuid(ctx.actor.id) || !ctx.tx) {
    throw new LimsError('auth.unauthenticated');
  }
  requireCredentialKind(ctx.claims ?? {}, kind);
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, agentId: ctx.actor.id };
}
export type DeviceScope = ReturnType<typeof deviceScope>;

/** The calling agent, visible in the caller's tenant and `active`; anything else -> 401. */
export async function activeAgent(repo: DeviceRepo, s: DeviceScope): Promise<Row> {
  const a = await repo.findAgent(s.tx, s.tenantId, s.agentId);
  if (!a || a.tenant_id !== s.tenantId || a.id !== s.agentId || a.status !== 'active') throw deviceInvalid();
  return a;
}
export const clock = (deps: { now?: () => Date }, ctx: DeviceCtx): number => new Date(deps.now?.() ?? ctx.now?.() ?? new Date()).getTime();
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown, max: number, path: string): string => (typeof v === 'string' && v.length >= 1 && v.length <= max ? v : fail(path));

export function createEnrolmentService(deps: { repo?: DeviceRepo; now?: () => Date } = {}) {
  const repo = deps.repo ?? createDeviceRepo();
  return {
    async enrolAgent(ctx: DeviceCtx, input: { hostFingerprintSha256?: unknown; agentVersion?: unknown; launcherVersion?: unknown; osVersion?: unknown }): Promise<DeviceResult> {
      const s = deviceScope(ctx, 'enrolment_code');
      const credentialId = ctx.claims?.credential_id;
      if (!isUuid(credentialId)) throw deviceInvalid();
      if (typeof input?.hostFingerprintSha256 !== 'string' || input.hostFingerprintSha256.length !== 64 || !FINGERPRINT.test(input.hostFingerprintSha256)) fail('/host_fingerprint_sha256');
      const agentVersion = str(input.agentVersion, 32, '/agent_version');
      const launcherVersion = str(input.launcherVersion, 32, '/launcher_version');
      const osVersion = str(input.osVersion, 64, '/os_version');
      if (typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');
      const now = clock(deps, ctx);
      const nowIso = new Date(now).toISOString();

      // Row lock serialises concurrent redemptions for this agent; the CAS below is the single-use guarantee.
      const agent = await repo.lockAgent(s.tx, s.tenantId, s.agentId);
      if (!agent || agent.tenant_id !== s.tenantId || agent.id !== s.agentId || !ENROLLABLE.includes(agent.status)) throw deviceInvalid();
      const code = await repo.findCredential(s.tx, s.tenantId, credentialId);
      if (!code || code.tenant_id !== s.tenantId || code.agent_id !== agent.id || code.kind !== 'enrolment_code' || code.status !== 'active'
        || !(new Date(code.expires_at).getTime() > now)) throw deviceInvalid();
      if (!(await repo.markCredentialUsed(s.tx, s.tenantId, credentialId, nowIso))) throw deviceInvalid();

      const previous = await repo.listActiveCredentials(s.tx, s.tenantId, agent.id, 'device_token');
      const { token, secretSha256 } = generateDeviceToken();
      const newId = uuidv7();
      await repo.insertCredential(s.tx, s.tenantId, { id: newId, centre_id: agent.centre_id, agent_id: agent.id, kind: 'device_token', secret_sha256: secretSha256, issued_by: agent.id });
      for (const old of previous) {
        await repo.revokeCredential(s.tx, s.tenantId, old.id, { reasonCode: REPLACED_REASON, actorId: agent.id, replacedByCredentialId: newId });
      }
      await repo.completeEnrolment(s.tx, s.tenantId, agent.id, { hostFingerprintSha256: input.hostFingerprintSha256 as string, enrolledAt: nowIso, agentVersion, launcherVersion, osVersion, actorId: agent.id });
      await ctx.audit.access({ action: 'device_credential.issue', entityType: 'agent_credential', entityId: newId, centreId: agent.centre_id, outcome: 'allowed' });
      return { status: 201, body: { agent_id: agent.id, centre_id: agent.centre_id, device_token: token, server_time: nowIso, config_version: agent.latest_config_version } };
    },
  };
}
export type EnrolmentService = ReturnType<typeof createEnrolmentService>;
