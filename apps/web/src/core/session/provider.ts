// Chooses the session resolver (08 R10). staging/production: always C2 resolveSession — the dev in-memory
// BffSessionStore is never loaded there (it also asserts this itself). dev/test: C2 when LIMS_ORIGIN_API is set
// (devstack / stub), else the in-memory dev provider.
import { c2Resolver } from './c2';
import type { SessionResolver } from './types';

let resolver: SessionResolver | undefined;

export async function getSessionResolver(): Promise<SessionResolver> {
  if (resolver) return resolver;
  const env = process.env.LIMS_CORE_ENV;
  if (env === 'staging' || env === 'production' || process.env.LIMS_ORIGIN_API) return (resolver = c2Resolver);
  const { createDevBffSessionStore, devResolver } = await import('./store');
  return (resolver = devResolver(createDevBffSessionStore()));
}
