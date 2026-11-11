// SQLSTATE -> registry ErrorCode (02-TRD §6.4 table). A module may catch the raw error and re-map it first.
// Mapped errors carry only the registry code: never the DB message, constraint, table or detail (REQ-SEC-026).
import { AuthError } from '../auth/errors.js';

export interface DbErrorDeps {
  readonly log?: { warn(obj: object, msg?: string): void } | undefined;
  readonly metrics?: { inc(name: string): void } | undefined;
}

// ponytail: AuthError is the registry-code error until T0D-04 lands LimsError.
export type MappedError = Error & { readonly code: string; readonly statusCode: number };

// "connection errors" row: socket errnos from the driver, SQLSTATE class 08, and server shutdown / not accepting (57P01-57P03).
const CONNECTION_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
const DEPENDENCY = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03']);
const SQLSTATE = /^[0-9A-Z]{5}$/;

export function mapDbError(err: unknown, deps: DbErrorDeps = {}): Error {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return err as Error;
  if (CONNECTION_ERRNOS.has(code) || code.startsWith('08') && SQLSTATE.test(code) || DEPENDENCY.has(code)) {
    return new AuthError('common.dependency_unavailable');
  }
  if (!SQLSTATE.test(code)) return err as Error; // non-DB error or an already-mapped `<module>.<name>` code
  switch (code) {
    case 'P0001':
      return new AuthError((err as Error).message === 'immutable_row' ? 'common.immutable_record' : 'common.internal');
    case '42501':
      deps.metrics?.inc('lims_rls_denied_total');
      return new AuthError('common.not_found');
    case '23503':
      return new AuthError('common.not_found');
    case '23505':
      deps.log?.warn({ event: 'unmapped_unique_violation', constraint: (err as { constraint?: unknown }).constraint }, 'unmapped_unique_violation');
      return new AuthError('common.internal');
    case '23514':
      return new AuthError('common.validation_failed');
    default:
      return new AuthError('common.internal'); // [CONV] fail closed: an unlisted SQLSTATE never reaches the client as-is
  }
}
