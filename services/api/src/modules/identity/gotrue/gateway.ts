// GoTrueGateway: the only seam between the identity module and GoTrue (02-TRD §8). Endpoint mapping: ./mapping.md.
export type Uuid = string;

export interface GoTrueTokens {
  accessToken: string; refreshToken: string; expiresAt: number /* epoch s */; sessionId: Uuid; userId: Uuid; aal: 'aal1' | 'aal2';
}

export interface GoTrueGateway {
  signInWithPassword(email: string, password: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  refresh(refreshToken: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false; reason: 'revoked' | 'reused' | 'invalid' }>;
  signOut(accessToken: string, scope: 'local' | 'global'): Promise<void>;
  adminCreateUser(input: { email: string; emailConfirm: boolean }): Promise<{ userId: Uuid } | { exists: true; userId: Uuid }>;
  adminUpdatePassword(userId: Uuid, password: string): Promise<void>;
  adminSignOutUser(userId: Uuid): Promise<void>;                     // all sessions
  adminFindUserByEmail(email: string): Promise<{ userId: Uuid } | null>;  // used only inside worker jobs (no timing oracle on HTTP path)
  adminDeleteFactor(userId: Uuid, factorId: Uuid): Promise<void>;
  sendInvite(email: string, redirectPath: '/auth/confirm'): Promise<void>;
  sendRecovery(email: string, redirectPath: '/auth/confirm'): Promise<void>;
  verifyEmailToken(tokenHash: string, type: 'invite' | 'recovery'): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  mfaEnrollTotp(accessToken: string, friendlyName?: string): Promise<{ factorId: Uuid; otpauthUri: string; secret: string; qrSvg?: string }>;
  mfaChallengeAndVerify(accessToken: string, factorId: Uuid, code: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  mfaListFactors(accessToken: string): Promise<readonly { factorId: Uuid; type: 'totp'; status: 'verified' | 'unverified'; friendlyName?: string }[]>;
}

/** GoTrue answered with a 4xx the caller must treat as a failed operation. Message = method + status + GoTrue error_code only (never bodies, keys, passwords). */
export class GoTrueError extends Error {
  constructor(readonly method: string, readonly status: number, readonly errorCode: string) {
    super(`gotrue ${method} failed: ${status} ${errorCode}`);
    this.name = 'GoTrueError';
  }
}
