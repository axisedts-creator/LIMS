// T0D-MSGDESK-1 shared mocks (setupFiles; tester-owned). Same mocks as T0D-TESTMGMT-1 (testmgmt1.setup.ts) plus ONE addition: the access token is a real shaped
// (unsigned) JWT whose `sub` is the signed-in user id (TM.actorId). The API stores requested_by / approved_by as that user id (broadcast.service: actor.id), and the
// shell session only knows the membership id, so the server page reads `sub` from the token it already holds to decide "is this broadcast mine" (second person rule).
import { vi, type Mock } from 'vitest';

type TM = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  actorId: string;
  navLog: string[];
  push: Mock<(u: string) => void>;
  replace: Mock<(u: string) => void>;
  refresh: Mock<() => void>;
};
const g = globalThis as unknown as { __TM?: TM };
const navLog: string[] = [];
g.__TM = {
  nav: { search: '', path: '/engagement/messages/broadcasts' },
  session: { permissions: [] },
  actorId: '01a1a98a-ac40-7000-8000-0000000f0900',
  navLog,
  push: vi.fn((u: string) => { navLog.push(String(u)); }),
  replace: vi.fn((u: string) => { navLog.push(String(u)); }),
  refresh: vi.fn(),
};
const tm = () => g.__TM!;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => tm().push(u), replace: (u: string) => tm().replace(u), refresh: () => tm().refresh(), back: vi.fn() }),
  usePathname: () => tm().nav.path,
  useSearchParams: () => new URLSearchParams(tm().nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: tm().actorId, tenant_id: 'syn' })}.synthetic-signature`,
  getShellSession: async () => ({ actor: { permissions: tm().session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => tm().nav.path,
}));
