// Auth-path error carrying a registry code + its HTTP status from contracts/errors.yaml.
// ponytail: T0D-04 (core/errors.ts LimsError + problem+json) supersedes this; then AuthError becomes a LimsError alias.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../module.js';

let statuses: ReadonlyMap<string, number> | undefined;
function statusOf(code: string): number {
  statuses ??= new Map(
    (parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number }>)
      .map((e) => [e.code, e.http]),
  );
  // [CONV] a code missing from the registry on an auth path is still a 401, never a 2xx/500 leak.
  return statuses.get(code) ?? 401;
}

export class AuthError extends Error {
  readonly statusCode: number;
  constructor(readonly code: string) {
    super(code); // message = code only: never the token, claim values or which check failed
    this.statusCode = statusOf(code);
  }
}

/** Malformed resolver output etc.: a server bug, not the caller's fault. */
export const internal = (): AuthError => new AuthError('common.internal');
