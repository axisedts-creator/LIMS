// What the shell knows about a session after resolveSession. Never contains a token: the access JWT travels
// separately in Resolution and only to server-side code (REQ-SEC-068).
export interface ShellSession {
  readonly sessionId: string;
  readonly kind: string;
  readonly aal: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly actor: {
    readonly displayName: string;
    readonly tenantCode: string;
    readonly roles: readonly string[];
    /** ASSUMED source (C2 SessionState gap): session.actor.permissions — see .orchestra/cr/T0D-14.md */
    readonly permissions: readonly string[];
    /** LD-89 / CR-C8-001: optional until C2 resolveSession carries the actor's membership id. */
    readonly membershipId?: string;
  };
}

/** RFC 9457 problem+json as in contracts/errors.yaml (CV §8). */
export interface Problem { type: string; title: string; status: number; code: string; request_id?: string; [k: string]: unknown }

export type Resolution =
  | { ok: true; session: ShellSession; accessToken: string }
  | { ok: false; status: number; problem: Problem };

export interface SessionResolver {
  resolve(sessionId: string, opts: { touch: boolean }): Promise<Resolution>;
}

export const problem = (code: string, title: string, status: number): Problem =>
  ({ type: `urn:lims:error:${code}`, title, status, code });
