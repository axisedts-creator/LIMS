// C5.T-21 — page wiring for `/lab/verification` and `/lab/approval` (server components; node env, MSW). Synthetic data only.
// ASSUMED contract (dispute to rename): app/(staff)/lab/verification/page.tsx default async Page({searchParams}) → <VerificationQueue items permissions/>,
//   app/(staff)/lab/approval/page.tsx → <ApprovalQueue items permissions/>. Data: GET /v1/lab/verification-queue?stage=verify|approve (#listVerificationQueue,
//   `lab.result.read`); only the documented filters department_id, priority, flagged_only are forwarded from the page's searchParams (a stray `patient`/`q` param never
//   reaches the API, REQ-SEC-028); invalid values are dropped, not forwarded. A refused/failed read must not crash the page: items = [] is NOT acceptable for a 5xx
//   (that would say "Nothing waiting" while results wait) → the page throws so error.tsx renders (same as every other lab page).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';

const ORIGIN = 'http://api.test';
const QUEUE = `${ORIGIN}/v1/lab/verification-queue`;
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/verification',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const DEPT = '01a1a98a-ac40-7000-8000-000000000777';
const row = { result: { id: '01a1a98a-ac40-7000-8000-000000000001', version: 1, status: 'resulted' }, registration_no: 'REG0001', patient_display: { full_name: 'Synthetic Patient', age_sex: '40Y M', patient_code: 'P1' }, priority: 'routine' };
const seen: URL[] = [];
const api = setupServer(
  http.get(QUEUE, ({ request }) => { seen.push(new URL(request.url)); return HttpResponse.json({ data: [row], page: { has_more: false } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); seen.length = 0; });
afterAll(() => api.close());

const render = async (mod: () => Promise<{ default: (p: any) => Promise<ReactElement> | ReactElement }>, sp: Record<string, string> = {}) =>
  (await (await mod()).default({ searchParams: Promise.resolve(sp) })) as ReactElement;
const verification = () => import('@/app/(staff)/lab/verification/page');
const approval = () => import('@/app/(staff)/lab/approval/page');

describe('/lab/verification page', () => {
  it('renders <VerificationQueue> with the queue rows and the session permissions; reads stage=verify', async () => {
    session.permissions = ['lab.result.read', 'lab.result.verify'];
    const el = await render(verification);
    const { VerificationQueue } = await import('../components/VerificationQueue');
    expect(el.type).toBe(VerificationQueue);
    const p = el.props as { items: { registration_no: string }[]; permissions: string[] };
    expect(p.items.map((i) => i.registration_no)).toEqual(['REG0001']);
    expect(p.permissions).toEqual(['lab.result.read', 'lab.result.verify']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.searchParams.get('stage')).toBe('verify');
  });

  it('forwards ONLY department_id, priority, flagged_only; a stray patient/q/stage param is dropped; a bad uuid or non-boolean is dropped', async () => {
    session.permissions = ['lab.result.read', 'lab.result.verify'];
    await render(verification, { department_id: DEPT, priority: 'stat', flagged_only: 'true', patient: 'Jane Doe', q: 'REG0001', stage: 'approve' });
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ stage: 'verify', department_id: DEPT, priority: 'stat', flagged_only: 'true' });
    seen.length = 0;
    await render(verification, { department_id: 'not-a-uuid', flagged_only: 'yes' });
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ stage: 'verify' });
  });

  it('a 5xx read throws (error.tsx), it does not render an empty queue ("Nothing waiting" would be a lie)', async () => {
    session.permissions = ['lab.result.read', 'lab.result.verify'];
    api.use(http.get(QUEUE, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 500, code: 'common.internal' }, { status: 500 })));
    const err = await render(verification).then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(String((err as Error)?.message)).not.toMatch(/Cannot find|Failed to (resolve|load)/); // must fail on the 500, not on a missing module
    expect((err as { status?: number }).status).toBe(500);
  });
});

describe('/lab/approval page', () => {
  it('renders <ApprovalQueue> with the rows and permissions; reads stage=approve with the same filter whitelist', async () => {
    session.permissions = ['lab.result.read', 'lab.result.approve'];
    const el = await render(approval, { priority: 'stat', patient: 'Jane Doe' });
    const { ApprovalQueue } = await import('../components/ApprovalQueue');
    expect(el.type).toBe(ApprovalQueue);
    expect((el.props as { items: unknown[] }).items).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ stage: 'approve', priority: 'stat' });
  });

  it('the route files have error + loading siblings like the other lab screens', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const dir of ['verification', 'approval']) {
      for (const f of ['page.tsx', 'error.tsx', 'loading.tsx']) {
        expect(existsSync(fileURLToPath(new URL(`../../../app/(staff)/lab/${dir}/${f}`, import.meta.url))), `${dir}/${f}`).toBe(true);
      }
    }
  });
});
