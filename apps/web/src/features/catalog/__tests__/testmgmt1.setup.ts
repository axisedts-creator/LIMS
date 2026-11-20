// T0D-TESTMGMT-1 shared mocks (setupFiles). State lives on globalThis.__TM so the test files and the mocked modules see the same object.
import { vi, type Mock } from 'vitest';

type TM = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  navLog: string[];
  push: Mock<(u: string) => void>;
  replace: Mock<(u: string) => void>;
  refresh: Mock<() => void>;
};
const g = globalThis as unknown as { __TM?: TM };
const navLog: string[] = [];
g.__TM = {
  nav: { search: '', path: '/catalog/tests' },
  session: { permissions: [] },
  navLog,
  push: vi.fn((u: string) => { navLog.push(String(u)); }),
  replace: vi.fn((u: string) => { navLog.push(String(u)); }),
  refresh: vi.fn(),
};
const tm = () => g.__TM!;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => tm().push(u), replace: (u: string) => tm().replace(u), refresh: () => tm().refresh(), back: vi.fn() }),
  usePathname: () => tm().nav.path,
  useSearchParams: () => new URLSearchParams(tm().nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: tm().session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => tm().nav.path,
}));
