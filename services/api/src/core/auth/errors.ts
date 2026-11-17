// Auth-path error: a LimsError (core/errors.ts) whose unregistered codes still carry 401 on the error object.
import { LimsError } from '../errors.js';

export class AuthError extends LimsError {
  constructor(code: string) {
    super(code); // message = code only: never the token, claim values or which check failed
    this.name = 'AuthError';
    // [CONV] a code missing from the registry on an auth path is still a 401, never a 2xx; toProblem renders it 500 common.internal.
    if (this.statusCode === 500 && code !== 'common.internal') this.statusCode = 401;
  }
}

/** Malformed resolver output etc.: a server bug, not the caller's fault. */
export const internal = (): AuthError => new AuthError('common.internal');
