// C13.T19 shared helpers (tester-owned). Builds on the T05 harness (fake next/*, fetch fake for the API; no msw/jsdom in apps/partner).
// Each test file keeps its own vi.mock(...) header (vi.mock is hoisted per file); everything else lives here.
// LEAD DECISION LD-140 (2026-11-13, cited): feature code builds only from @lims/ui components and tokens; no hex colours, no inline style objects; one primary button per page; every status shows tone, icon and word.
import { renderToStaticMarkup } from 'react-dom/server';
import { AUTH, installFetch, json, reply, resolved, seen, setEnv } from '../t05/harness';

export { AUTH, JWT, json, reply, resetApi, restoreFetch, seen } from '../t05/harness';

export const LAB = 'Synthetic Lab Alpha';
export const PARTNER = 'Synthetic Partner X';
export const urls: string[] = [];
export const id = (n: number, kind = 0) => `01940e00-0000-7000-8000-c13190${String(kind).padStart(3, '0')}${String(n).padStart(3, '0')}`;

const READ = ['partners.order.read', 'partners.manifest.submit', 'partners.report.read', 'partners.statement.read', 'partners.price_list.read', 'partners.pickup.request', 'partners.referrer.read'];
export const MEMBER_PERMS = READ;
export const ADMIN_PERMS = [...READ, 'partners.referrer.manage', 'partners.partner_user.manage'];

export interface MeOpts { role?: 'partner_admin' | 'partner_member'; perms?: string[]; mode?: 'on_receipt' | 'on_submit'; slips?: boolean; lab?: string; name?: string; mfa?: boolean }
export const me = (o: MeOpts = {}) => ({
  partner: { id: id(1, 900), partner_code: 'SPX', name: o.name ?? PARTNER },
  user: { partner_user_id: id(2, 900), display_name: 'Synthetic Admin', partner_role: o.role ?? 'partner_admin', mfa_enrolled: o.mfa ?? true },
  tenant: { display_name: o.lab ?? LAB, calendar_display: 'ad', timezone: 'Asia/Kathmandu' },
  permissions: o.perms ?? (o.role === 'partner_member' ? MEMBER_PERMS : ADMIN_PERMS),
  features: { access_slip_enabled: o.slips ?? true, conversion_mode: o.mode ?? 'on_receipt', include_default_price_list: true },
});

export const centre = { id: id(1, 800), name: 'Synthetic Centre' };
export const mf = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n, 100), manifest_no: `MF260000${n}`, state: 'submitted', line_count: 3, lines_converted: 0, lines_failed: 0, receiving_centre: centre,
  submitted_at: '2026-11-12T06:00:00.000Z', created_at: '2026-11-12T05:00:00.000Z', version: 3, ...o,
});
export const line = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n, 110), line_no: n, state: 'draft', partner_sample_ref: `REF-00${n}`,
  patient: { full_name: `Synthetic Patient ${n}`, sex: 'female', age_years: 43 },
  consents: { sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v1' },
  orderables: [{ orderable_id: id(n, 120), kind: 'test', code: 'CBC', name: 'Complete blood count' }],
  priority: 'routine', collected_at: '2026-11-12T04:00:00.000Z', version: 1, ...o,
});
export const manifest = (n: number, lines: unknown[], o: Record<string, unknown> = {}) => ({ ...mf(n, { line_count: lines.length }), notes: 'Synthetic note', collected_on: '2026-11-12', lines, ...o });
export const order = (n: number, o: Record<string, unknown> = {}) => ({
  order_id: id(n, 200), registration_no: `0001SY0001${String(n).padStart(2, '0')}`, manifest: { id: id(1, 100), manifest_no: 'MF2600001' }, line_id: id(n, 110), partner_sample_ref: `REF-00${n}`,
  patient: { full_name: `Synthetic Patient ${n}`, sex: 'female', age_years: 43 }, priority: 'routine', tracking_status: 'registered', registered_at: '2026-11-12T07:00:00.000Z', last_event_at: '2026-11-12T08:00:00.000Z', report_count: 0, has_new_report: false, ...o,
});
export const report = (n: number, o: Record<string, unknown> = {}) => ({
  report_id: id(n, 300), version_no: 1, order_id: id(n, 200), registration_no: `0001SY0001${String(n).padStart(2, '0')}`, patient: { full_name: `Synthetic Patient ${n}` },
  kind: 'final', status: 'valid', released_at: '2026-11-13T05:00:00.000Z', panel_names: ['Lipid panel'], is_new: false, ...o,
});

type Body = unknown | Response | ((body: unknown, req: Request) => Response | Promise<Response>);
/** Registers fake API responses by pathname; the session always resolves active. /v1/partners/me defaults to an admin context. */
export function serve(map: Record<string, Body> = {}, meOpts: MeOpts = {}) {
  reply[`${AUTH}/session/resolve`] = () => json(200, resolved('active'));
  const all: Record<string, Body> = { '/v1/partners/me': me(meOpts), ...map };
  for (const [p, b] of Object.entries(all)) reply[p] = typeof b === 'function' ? (b as never) : () => (b instanceof Response ? b.clone() : json(200, b));
}
export const failing = (status: number, code = 'common.internal') => json(status, { code, status, title: code, detail: 'UPSTREAM-SECRET-DETAIL' });

export function boot() {
  setEnv();
  installFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { urls.push(new Request(input as never, init).url); return inner(input, init); }) as typeof fetch;
}
export const calls = (path: string) => urls.filter((u) => new URL(u).pathname === path).map((u) => new URL(u));

type Page = { default: (p: unknown) => unknown };
/** Renders `src/app/(app)/<rel>/page.tsx` (rel '' = the segment root) as a Next 16 server component to static markup. */
export async function renderPage(rel: string, params: Record<string, string> = {}, search: Record<string, string> = {}): Promise<string> {
  const mod = (await import(/* @vite-ignore */ `../../src/app/(app)/${rel ? `${rel}/` : ''}page.tsx`)) as Page;
  return renderToStaticMarkup((await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(search) })) as never);
}
/** Same, but returns the thrown error (notFound / redirect / ErrorState throw) instead of markup. */
export const settle = (p: Promise<string>) => p.then((html) => ({ html, err: undefined as unknown }), (err: unknown) => {
  if (/Cannot find module|Failed to (load|resolve)|ERR_MODULE_NOT_FOUND/.test(String(err))) throw err; // a missing page is a failure, never a "handled error"
  return { html: '', err };
});
export const attempt = (rel: string, params: Record<string, string> = {}, search: Record<string, string> = {}) => settle(renderPage(rel, params, search));

export const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
export const primaries = (html: string) => (html.match(/lims-btn-primary/g) ?? []).length;
export const title = (html: string) => /<h1 class="lims-page-title">([^<]*)</.exec(html)?.[1];
export const helpKey = (html: string) => /data-help-key="([^"]*)"/.exec(html)?.[1];
export const headers = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
/** The chip (tone + word) rendered for a status word, e.g. chip(html,'Partly received') -> 'info'. */
export const chipTone = (html: string, word: string) => new RegExp(`data-tone="(\\w+)"[^>]*>(?:(?!</span>).)*?${word}<`, 's').exec(html)?.[1];
export const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => decode(m[1]!));
export const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map((m) => ({ attrs: m[1]!, text: m[2]!.replace(/<[^>]+>/g, '').trim() }));
