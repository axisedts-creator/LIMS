// C13.T16 shared harness (tester-owned; NOT a test file). Every test file repeats the three vi.mock() blocks (hoisting is per file):
//   vi.mock('next/navigation', ...)  vi.mock('server-only', () => ({}))  vi.mock('@/core/session/server', ...) with `session.perms`.
//
// ASSUMED contract (the spec fixes routes + BFF paths + kit components; writer disputes through .orchestra/notes if wrong):
//  * Pages are async server components under apps/web/src/app/(staff)/partners/ (Next 16: params/searchParams are Promises). They read the BFF only through
//    apps/web/src/features/partners/server/*.server.ts (serverFetch -> LIMS_ORIGIN_API, `/v1/partners/admin/...`) and hand DTOs to client components in
//    features/partners/components/. Session permissions: getShellSession().actor.permissions. Writes are server actions (features/partners/server/actions.ts).
//  * Every write carries `If-Match: "<version>"` where the operation needs it (TRD §5.3) and an `Idempotency-Key` where TRD §5.3 says "required".
//  * The reason pickers (CodedSelect) use the seed display texts of 05-SCHEMA §7 (constants in the feature; there is no partners coded-set endpoint in
//    contracts/openapi/partners.yaml, so nothing is fetched for them).
//  * Settings (SS1) have no `version` field: the GET response header `ETag: "<n>"` is echoed back as `If-Match` on PUT.
import { expect } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN } from './t16.fixtures';

export { ORIGIN };
process.env.LIMS_ORIGIN_API = ORIGIN;

export type Call = { method: string; url: URL; headers: Headers; body?: any };
export const calls: Call[] = [];
export const rec = async (r: Request) => {
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) });
};
export const of = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));
export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
export const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
export const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
type PageModule = { default: (p: any) => Promise<ReactNode> | ReactNode };
/** `rel` is relative to apps/web/src/app/(staff)/partners/, e.g. 'manifests/[manifest_id]' or '' for SP-1. */
export const pageModule = async (rel: string, file = 'page') => (await import(/* @vite-ignore */ `../../../app/(staff)/partners/${rel ? `${rel}/` : ''}${file}`)) as PageModule;
export const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
/** Renders a server page the way Next does: await the async component, then mount its output. */
export async function renderPage(rel: string, props: { params?: Record<string, string>; searchParams?: Record<string, string> } = {}) {
  const { default: Page } = await pageModule(rel);
  return wrap(await Page({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(props.searchParams ?? {}) }));
}
export const idemKey = (c: Call) => c.headers.get('idempotency-key');
export const ifMatch = (c: Call) => c.headers.get('if-match');
