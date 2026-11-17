// T0D-TESTMGMT-1 setup: module mocks shared by every testmgmt1 test file. State lives on globalThis.__TM (see testmgmt1.kit.tsx).
import { vi } from 'vitest';

type TM = { search: string; pathname: string; permissions: string[]; navLog: string[] };
const tm = (): TM => ((globalThis as any).__TM ??= { search: '', pathname: '/catalog/tests', permissions: [], navLog: [] });

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (u: string) => { tm().navLog.push(String(u)); },
    replace: (u: string) => { tm().navLog.push(String(u)); },
    refresh: () => undefined,
    back: () => undefined,
  }),
  usePathname: () => tm().pathname,
  useSearchParams: () => new URLSearchParams(tm().search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: tm().permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => tm().pathname,
}));
