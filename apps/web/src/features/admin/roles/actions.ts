'use server';
// RM-T05 server action: applyRolePack (CR-C2-RM-001 / LD-150). Body is { pack_code } only; tenant and actor come from the token (LD-150).
import { call, type Result } from '../server/api';

export interface ApplyRolePackResult { pack_code: string; created: string[]; updated: string[]; unchanged: string[] }
const PACK_CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;

export async function applyRolePack(pack_code: string): Promise<Result<ApplyRolePackResult>> {
  if (typeof pack_code !== 'string' || !PACK_CODE_RE.test(pack_code)) return { ok: false, status: 400, code: 'common.validation_failed', pointers: ['/pack_code'] };
  return call<ApplyRolePackResult>('POST', '/v1/identity/role-packs/apply', { body: { pack_code }, idempotent: true });
}
