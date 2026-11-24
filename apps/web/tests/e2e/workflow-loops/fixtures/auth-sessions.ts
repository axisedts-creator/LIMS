// Multi-Agent Authentication & Session Fixtures for Playwright
// Injects pre-authenticated cookie headers (__Host-lims_sid) across 7 agent personas.
import type { BrowserContext } from '@playwright/test';

export const ENV = {
  baseUrl: (process.env.E2E_BASE_URL ?? process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  clerkToken: process.env.E2E_CLERK_TOKEN || 'sid-clerk-tenant-a',
  techToken: process.env.E2E_TECH_TOKEN || 'sid-tech-tenant-a',
  pathoToken: process.env.E2E_PATHOLOGIST_TOKEN || 'sid-pathologist-tenant-a',
  adminToken: process.env.E2E_ADMIN_TOKEN || 'sid-admin-tenant-a',
  tenantBToken: process.env.E2E_TENANT_B_TOKEN || 'sid-admin-tenant-b',
  centre2Token: process.env.E2E_CENTRE_2_TOKEN || 'sid-clerk-centre-2',
};

/** Convert relative path to fully-qualified URL against baseURL */
export function toUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${ENV.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Set the secure host cookie for a specific persona token */
export async function setPersonaCookie(ctx: BrowserContext, token: string, _baseUrl = ENV.baseUrl): Promise<void> {
  await ctx.addCookies([
    {
      name: '__Host-lims_sid',
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

/** Clear all auth cookies (e.g., for Patient or Anonymous testing) */
export async function clearAuthCookies(ctx: BrowserContext): Promise<void> {
  await ctx.clearCookies();
}

/** Agent 1: Front Desk Clerk (Tenant A, Centre 1) */
export async function useClerkSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.clerkToken);
}

/** Agent 2: Bench Technologist (Tenant A, Centre 1) */
export async function useTechSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.techToken);
}

/** Agent 3: Consultant Pathologist (Tenant A, Centre 1, AAL2) */
export async function usePathologistSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.pathoToken);
}

/** Agent 4: Tenant Administrator (Tenant A, All Centres) */
export async function useAdminSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.adminToken);
}

/** Agent 5: Patient / Public Auditor (Unauthenticated clean session) */
export async function usePublicPatientSession(ctx: BrowserContext): Promise<void> {
  await clearAuthCookies(ctx);
}

/** Agent 6a: Red Team Attacker (Tenant B Administrator) */
export async function useTenantBAdminSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.tenantBToken);
}

/** Agent 6b: Red Team Branch Scoping Attacker (Tenant A, Scoped to Centre 2) */
export async function useCentre2ClerkSession(ctx: BrowserContext): Promise<void> {
  await setPersonaCookie(ctx, ENV.centre2Token);
}
