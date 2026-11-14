// AuthResolver registry (02-TRD §6.3, 08 §4.11): one owning module per scheme; resolver output -> DbClaims.
import { AUTH_RESOLVER_OWNERS, type ModuleName } from '../module.js';
import { buildAuthResolverClaims, type DbClaims } from './claims.js';
import { AuthError, internal } from './errors.js';

export interface AuthResolver {
  resolve(credential: string, tx: unknown): Promise<unknown>;
  // LD-66 / CR-C6-021: optional ErrorCode thrown instead of auth.unauthenticated for pre-resolver credential rejections (empty, non-string, > 4096).
  readonly invalidError?: string;
}
export interface AuthResolverRegistry {
  has(key: string): boolean;
  authenticate(key: string, credential: string, tx: unknown): Promise<DbClaims>;
}

const MAX_CREDENTIAL = 4096; // [CONV]
const unauthenticated = () => new AuthError('auth.unauthenticated');

export function createAuthResolverRegistry(
  modules: ReadonlyArray<{ readonly name: string; readonly authResolvers?: Readonly<Record<string, unknown>> }>,
): AuthResolverRegistry {
  const map = new Map<string, { module: ModuleName; resolver: AuthResolver }>();
  for (const m of modules) {
    for (const [key, r] of Object.entries(m.authResolvers ?? {})) {
      if (!Object.hasOwn(AUTH_RESOLVER_OWNERS, key) || AUTH_RESOLVER_OWNERS[key] !== m.name) {
        throw new Error(`module ${m.name}: authResolvers.${key} is not allowed from this module`);
      }
      if (map.has(key)) throw new Error(`module ${m.name}: authResolvers.${key} is already registered`);
      if (typeof (r as AuthResolver | undefined)?.resolve !== 'function') throw new Error(`module ${m.name}: authResolvers.${key} has no resolve()`);
      map.set(key, { module: m.name as ModuleName, resolver: r as AuthResolver });
    }
  }
  return {
    has: (key) => map.has(key),
    async authenticate(key, credential, tx) {
      const e = map.get(key);
      if (!e) throw unauthenticated(); // fail closed
      if (typeof credential !== 'string' || credential.length === 0 || credential.length > MAX_CREDENTIAL) {
        throw e.resolver.invalidError ? new AuthError(e.resolver.invalidError) : unauthenticated();
      }
      const r = await e.resolver.resolve(credential, tx);
      if (r === undefined) throw unauthenticated();
      if (r && typeof r === 'object' && 'error' in r) {
        const code = (r as { error: unknown }).error;
        throw typeof code === 'string' && code ? new AuthError(code) : internal();
      }
      return buildAuthResolverClaims(e.module, r);
    },
  };
}
