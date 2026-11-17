// bearerJwt: verify the GoTrue JWT, then call the identity claimsResolver (mandatory, sole claims source; 08 R10, CR-C2-005).
import type { BffKind } from './bff-key.js';
import { buildDbClaims, type DbClaims, type ResolvedClaims } from './claims.js';
import { internal } from './errors.js';
import type { JwtVerifier, VerifiedJwt } from './jwt.js';

export type EndpointFamily = 'staff' | 'partner' | 'patient' | 'mobile' | 'api';
export interface ClaimsRequest {
  readonly clientIp: string;
  readonly requestId: string;
  readonly endpointFamily: EndpointFamily;
  readonly bffKey?: BffKind;
}
/** C2 02-TRD §6.1. */
export interface ClaimsResolver {
  resolve(jwt: VerifiedJwt, request: ClaimsRequest): Promise<ResolvedClaims>;
}

export async function authenticateBearer(
  deps: { readonly verifier: JwtVerifier; readonly claimsResolver?: ClaimsResolver | undefined },
  token: string,
  request: ClaimsRequest,
): Promise<{ claims: DbClaims; resolved: Exclude<ResolvedClaims, { kind: 'rejected' }> }> {
  const jwt = await deps.verifier.verify(token); // rejects before the resolver is ever called
  if (typeof deps.claimsResolver?.resolve !== 'function') throw internal(); // no identity module: fail closed, never JWT claims
  // Only the typed context is forwarded; nothing else from the request reaches the resolver (AC-0D-2.2).
  const req: ClaimsRequest = {
    clientIp: request.clientIp, requestId: request.requestId, endpointFamily: request.endpointFamily,
    ...(request.bffKey ? { bffKey: request.bffKey } : {}),
  };
  const resolved = await deps.claimsResolver.resolve(jwt, req);
  const claims = buildDbClaims(resolved); // throws for rejected / malformed
  return { claims, resolved: resolved as Exclude<ResolvedClaims, { kind: 'rejected' }> };
}

/**
 * Endpoint family for the session-kind check (02-TRD §6.5, 08 R10) from the route template, never a client header.
 * [CONV] other /v1/identity/auth/* routes are 'partner' with the partner BFF key, else 'staff'; module API routes are 'api'.
 */
export function endpointFamilyOf(routeUrl: string, bffKey?: BffKind): EndpointFamily {
  if (routeUrl.startsWith('/v1/identity/auth/patient/')) return 'patient';
  if (routeUrl.startsWith('/v1/identity/mobile/')) return 'mobile';
  if (routeUrl.startsWith('/v1/identity/auth/')) return bffKey === 'partner' ? 'partner' : 'staff';
  return 'api';
}
