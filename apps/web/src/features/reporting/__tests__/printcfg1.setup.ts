// T0D-PRINTCFG-1 shared mocks (setupFiles). State lives on globalThis.__PC so test files and mocked modules see the same object.
import { vi, type Mock } from 'vitest';

type PC = { nav: { search: string; path: string }; session: { permissions: string[] }; refresh: Mock<() => void> };
const g = globalThis as unknown as { __PC?: PC };
g.__PC = { nav: { search: '', path: '/reporting/settings' }, session: { permissions: [] }, refresh: vi.fn() };
const pc = () => g.__PC!;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => pc().refresh(), back: vi.fn() }),
  usePathname: () => pc().nav.path,
  useSearchParams: () => new URLSearchParams(pc().nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: pc().session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => pc().nav.path,
}));
