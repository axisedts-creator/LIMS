import 'server-only';
// Shared pre-flight checks for the C3 BFF functions: refuse bad input before any request leaves the server (REQ-SEC-028).
import { ApiError } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { IDEMPOTENCY_KEY_RE, UUID_RE } from './types';

export const badRequest = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
/** Ids go into URL paths, so only UUIDs pass; anything else is indistinguishable from "not found". */
export function uuid(id: string): string {
  if (!UUID_RE.test(id)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return id;
}
export function idemKey(key: string): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) throw badRequest();
  return key;
}
export function ifMatch(version: number): string {
  if (!Number.isInteger(version) || version < 1) throw badRequest();
  return `"${version}"`;
}
export function reason(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > 500) throw badRequest();
  return text;
}
export const json = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });
