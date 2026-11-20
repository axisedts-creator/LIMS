// T0D-PRINTCFG-1 shared harness (tester-owned): synthetic fixtures + a stateful MSW stand-in for the contract operations the screens use
// (contracts/openapi/reporting.yaml: listPrintProfiles, upsertPrintProfile, previewPrintProfile, listSignatoryProfiles, upsertSignatoryProfile,
// getReportPrint; identity.yaml: listBranches, listUsers, listRoles, uploadBrandingAsset; billing.yaml printInvoice). The screens are reached through the
// page default exports of /reporting/settings and /billing/settings (async server components); no component name is pinned for the new sections.
// Synthetic data only. Every request is recorded in API.calls.
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { vi } from 'vitest';
import { ToastProvider } from '@lims/ui/components/Toast';
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { parseMultipart, type ParsedForm } from '../../catalog/__tests__/web-t35.multipart';
import { settings as reportingSettings } from './c6-t31.fixtures';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

type PCState = { nav: { search: string; path: string }; session: { permissions: string[] }; refresh: { mockClear: () => void; mock: { calls: unknown[][] } } };
export const PC = (globalThis as unknown as { __PC: PCState }).__PC;

type Rec = Record<string, any>;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
export const BRANCH_A = ID(1), BRANCH_B = ID(2), JOB = ID(10), ASSET = ID(20), ASSET_OLD = ID(21), ME = ID(900);
export const U_PATHO = ID(101), U_PATHO2 = ID(102), U_TECH = ID(103);
export const ROLE_PATHO = ID(201), ROLE_TECH = ID(202);

export const MANAGE_REPORT = ['reporting.settings.manage'];
export const MANAGE_BILL = ['billing.settings.manage'];
export const MANAGE_BOTH = ['reporting.settings.manage', 'billing.settings.manage'];

export const branches = [
  { branch_id: BRANCH_A, code: 'KTM', name: 'Synthetic Branch Kathmandu', is_processing_lab: true, is_active: true, version: 1 },
  { branch_id: BRANCH_B, code: 'PKR', name: 'Synthetic Branch Pokhara', is_processing_lab: false, is_active: true, version: 1 },
];
const roleRef = (role_id: string, code: string, name: string) => ({ role_id, code, name });
export const userRow = (id: string, name: string, role: ReturnType<typeof roleRef>, o: Rec = {}) => ({
  membership_id: id, display_name: name, email_masked: 's***@s***', status: 'active', is_locked: false, roles: [role], all_centres: true, centre_count: 0, mfa_enrolled: true, version: 1, ...o,
});
export const PATHO_ROLE = roleRef(ROLE_PATHO, 'pathologist', 'Pathologist');
export const TECH_ROLE = roleRef(ROLE_TECH, 'technologist', 'Technologist');
export const roles = [
  { role_id: ROLE_PATHO, code: 'pathologist', name: 'Pathologist', is_default: true, mfa_required: true, permission_codes: ['lab.result.read', 'lab.result.approve'], member_count: 2, is_active: true, version: 1 },
  { role_id: ROLE_TECH, code: 'technologist', name: 'Technologist', is_default: true, mfa_required: false, permission_codes: ['lab.result.read', 'lab.result.verify'], member_count: 1, is_active: true, version: 1 },
];

export const profile = (o: Rec = {}): Rec => ({
  id: ID(300), document_kind: 'report', paper_mode: 'typed_header_footer', header_text: 'Synthetic Lab (SYNTHETIC)\nKathmandu', footer_text: 'Thank you (SYNTHETIC)',
  reserve_top_mm: 0, reserve_bottom_mm: 0, show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10, is_active: true,
  updated_at: '2026-11-17T04:15:00.000Z', updated_by: ME, ...o,
});
export const signatory = (id: string, name: string, o: Rec = {}): Rec => ({
  user_id: id, display_name: name, title: 'Consultant Pathologist (SYNTHETIC)', registration_no: 'SYN-REG-0001', signature_asset_id: ASSET_OLD, is_active: true,
  updated_at: '2026-11-17T04:15:00.000Z', updated_by: ME, ...o,
});

export const prob = (status: number, code: string, detail = `Synthetic server detail for ${code}.`) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic title', status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });

export type Call = { method: string; path: string; search: string; headers: Headers; json?: any; form?: ParsedForm; raw?: string };
export const API = {
  calls: [] as Call[],
  profiles: [] as Rec[],
  signatories: [] as Rec[],
  users: [] as Rec[],
  listFail: undefined as undefined | 403 | 500,
  usersFail: false,
  putFail: undefined as undefined | { status: number; code: string },
  sigPutFail: undefined as undefined | { status: number; code: string },
  uploadFail: undefined as undefined | { status: number; code: string },
  previewFail: false,
  previewReadyAfter: 0, // polls of GET prints/:id that answer "rendering" before "ready"
  polls: 0,
  reset() {
    this.calls.length = 0; this.profiles = []; this.signatories = []; this.users = [
      userRow(U_PATHO, 'Dr Synthetic Patho', PATHO_ROLE), userRow(U_PATHO2, 'Dr Second Patho', PATHO_ROLE), userRow(U_TECH, 'Tina Technologist', TECH_ROLE),
    ];
    this.listFail = undefined; this.usersFail = false; this.putFail = undefined; this.sigPutFail = undefined; this.uploadFail = undefined; this.previewFail = false;
    this.previewReadyAfter = 0; this.polls = 0;
  },
  of: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
};
export const puts = () => API.of('PUT', /\/v1\/reporting\/print-profiles$/);
export const previews = () => API.of('POST', /\/print-profiles\/preview$/);
export const uploads = () => API.of('POST', /\/v1\/identity\/users\/[^/]+\/signature$/);
export const brandingUploads = () => API.of('POST', /branding-assets/);
export const sigPuts = () => API.of('PUT', /\/signatory-profiles\//);

const log = async (request: Request, extra: Partial<Call> = {}) => {
  const url = new URL(request.url);
  const ct = request.headers.get('content-type') ?? '';
  const call: Call = { method: request.method, path: url.pathname, search: url.search, headers: request.headers, ...extra };
  if (request.method !== 'GET' && !extra.form) {
    const text = await request.clone().text().catch(() => '');
    call.raw = text;
    if (ct.includes('json')) { try { call.json = JSON.parse(text); } catch { /* not json */ } }
  }
  API.calls.push(call);
  return call;
};

const R = `${ORIGIN}/v1/reporting`;
export const api = setupServer(
  http.get(`${R}/print-profiles`, async ({ request }) => {
    await log(request);
    if (API.listFail === 403) return prob(403, 'auth.forbidden');
    if (API.listFail === 500) return prob(500, 'common.internal');
    const q = new URL(request.url).searchParams;
    let rows = API.profiles;
    if (q.get('document_kind')) rows = rows.filter((p) => p.document_kind === q.get('document_kind'));
    if (q.get('branch_id')) rows = rows.filter((p) => p.branch_id === q.get('branch_id'));
    return HttpResponse.json({ data: rows });
  }),
  http.put(`${R}/print-profiles`, async ({ request }) => {
    const c = await log(request);
    if (API.putFail) return prob(API.putFail.status, API.putFail.code);
    const saved = { id: ID(400 + API.profiles.length), is_active: true, show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10, reserve_top_mm: 0, reserve_bottom_mm: 0, header_text: '', footer_text: '', updated_at: '2026-11-18T04:15:00.000Z', updated_by: ME, ...c.json };
    API.profiles = [...API.profiles.filter((p) => !(p.document_kind === saved.document_kind && p.branch_id === saved.branch_id && p.recipient_type === saved.recipient_type)), saved];
    return HttpResponse.json(saved);
  }),
  http.post(`${R}/print-profiles/preview`, async ({ request }) => {
    await log(request);
    if (API.previewFail) return prob(500, 'common.internal');
    return HttpResponse.json({ id: JOB, state: 'rendering', variant: 'plain', copies: 1, expires_at: '2026-11-18T05:15:00.000Z' }, { status: 202 });
  }),
  http.get(`${R}/prints/:id`, async ({ request }) => {
    await log(request);
    const ready = API.polls++ >= API.previewReadyAfter;
    return HttpResponse.json({ id: JOB, state: ready ? 'ready' : 'rendering', variant: 'plain', copies: 1, expires_at: '2026-11-18T05:15:00.000Z' });
  }),
  http.get(`${R}/signatory-profiles`, async ({ request }) => { await log(request); return HttpResponse.json({ data: API.signatories }); }),
  http.put(`${R}/signatory-profiles/:uid`, async ({ request, params }) => {
    const c = await log(request);
    if (API.sigPutFail) return prob(API.sigPutFail.status, API.sigPutFail.code);
    const saved = { user_id: params['uid'], is_active: true, updated_at: '2026-11-18T04:15:00.000Z', updated_by: ME, ...c.json };
    API.signatories = [...API.signatories.filter((s) => s.user_id !== saved.user_id), saved];
    return HttpResponse.json(saved);
  }),
  http.get(`${R}/settings`, async ({ request }) => { await log(request); return HttpResponse.json(reportingSettings()); }),
  http.get(`${R}/centre-contacts`, async ({ request }) => { await log(request); return HttpResponse.json({ data: [] }); }),
  http.get(`${ORIGIN}/v1/billing/settings`, async ({ request }) => {
    await log(request);
    return HttpResponse.json({ invoice_series_scope: 'tenant', prices_include_tax: true, abbreviated_invoice_enabled: false, pay_by_qr_enabled: false, receipt_no_enabled: true, credit_days_auto_lock: false, cash_variance_alert_paisa: 50000, refund_alert_per_day: 5, version: 3 });
  }),
  http.get(`${ORIGIN}/v1/identity/branches`, async ({ request }) => { await log(request); return HttpResponse.json({ data: branches }); }),
  http.get(`${ORIGIN}/v1/identity/users`, async ({ request }) => {
    await log(request);
    if (API.usersFail) return prob(403, 'auth.forbidden');
    return HttpResponse.json({ data: API.users, page: { limit: 50 } });
  }),
  http.get(`${ORIGIN}/v1/identity/roles`, async ({ request }) => {
    await log(request);
    if (API.usersFail) return prob(403, 'auth.forbidden');
    return HttpResponse.json({ data: roles });
  }),
  // uploadUserSignature (identity.yaml): POST /v1/identity/users/{membership_id}/signature, multipart `file` only, answers the User with signatory.signature_asset_id.
  // The branding-assets route is deliberately NOT mocked: it would replace the lab logo (review T0D-PRINTCFG-1 item 1), so any call to it fails as an unhandled request.
  http.post(`${ORIGIN}/v1/identity/users/:uid/signature`, async ({ request, params }) => {
    const raw = await request.text();
    await log(request, { form: parseMultipart(request.headers.get('content-type') ?? '', raw), raw });
    if (API.uploadFail) return prob(API.uploadFail.status, API.uploadFail.code);
    return HttpResponse.json({ ...userRow(String(params['uid']), 'Synthetic', PATHO_ROLE), signatory: { signature_asset_id: ASSET } }, { status: 200 });
  }),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await log(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);

export const allowedProfileKeys = ['branch_id', 'document_kind', 'recipient_type', 'paper_mode', 'header_text', 'footer_text', 'reserve_top_mm', 'reserve_bottom_mm', 'show_logo', 'show_seller_pan', 'grayscale', 'font_size_pt', 'is_active'];
// PrintProfilePreviewRequest has additionalProperties:false and no branch_id / is_active: sending them would be a 400.
export const allowedPreviewKeys = allowedProfileKeys.filter((k) => k !== 'branch_id' && k !== 'is_active');
export const allowedSignatoryKeys = ['display_name', 'title', 'registration_no', 'signature_asset_id', 'is_active'];

async function openPage(path: string, mod: () => Promise<unknown>, perms: string[]) {
  PC.session.permissions = perms;
  PC.nav.path = path;
  PC.nav.search = '';
  const m = (await mod()) as { default: (p: unknown) => Promise<React.ReactNode> };
  const ui = await m.default({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
export const openReportingSettings = (perms: string[] = MANAGE_REPORT): Promise<ReturnType<typeof render>> => openPage('/reporting/settings', () => import('@/app/(staff)/reporting/settings/page'), perms);
export const openBillingSettings = (perms: string[] = MANAGE_BILL): Promise<ReturnType<typeof render>> => openPage('/billing/settings', () => import('@/app/(staff)/billing/settings/page'), perms);

/** Pick an option of a kit Select (react-aria button + listbox) or of a native select, by accessible names. */
export async function choose(u: UserEvent, label: RegExp, option: RegExp) {
  const btn = screen.queryAllByRole('button', { name: label })[0];
  if (btn) { await u.click(btn); await u.click(await screen.findByRole('option', { name: option })); return; }
  const sel = screen.getByRole('combobox', { name: label }) as HTMLSelectElement;
  await u.selectOptions(sel, within(sel).getByRole('option', { name: option }));
}

/** Browser image stubs: jsdom has no canvas or image decoding. Records the canvas size at export time. */
export const img = { w: 1800, h: 600, outBytes: 50_000, exported: [] as { w: number; h: number; type?: string }[], drawn: [] as unknown[][] };
export function stubImaging() {
  img.w = 1800; img.h = 600; img.outBytes = 50_000; img.exported.length = 0; img.drawn.length = 0;
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: img.w, height: img.h, close() { /* noop */ } }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage: (...a: unknown[]) => { img.drawn.push(a); }, fillRect() { /* noop */ }, fillStyle: '', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
  })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    img.exported.push({ w: this.width, h: this.height, ...(type ? { type } : {}) });
    cb(new Blob([new Uint8Array(img.outBytes).fill(7)], { type: type ?? 'image/png' }));
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type?: string) {
    img.exported.push({ w: this.width, h: this.height, ...(type ? { type } : {}) });
    return `data:${type ?? 'image/png'};base64,${'A'.repeat(Math.ceil((img.outBytes * 4) / 3))}`;
  } as never);
  // Image() path: fire load asynchronously with the stubbed natural size.
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => img.w });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => img.h });
  Object.defineProperty(HTMLImageElement.prototype, 'width', { configurable: true, get() { return (this as any)._w ?? img.w; }, set(v) { (this as any)._w = v; } });
  Object.defineProperty(HTMLImageElement.prototype, 'height', { configurable: true, get() { return (this as any)._h ?? img.h; }, set(v) { (this as any)._h = v; } });
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return (this as any)._src ?? ''; },
    set(v: string) { (this as any)._src = v; this.setAttribute('src', v); setTimeout(() => this.dispatchEvent(new Event('load')), 0); },
  });
  (URL as any).createObjectURL = vi.fn(() => 'blob:synthetic');
  (URL as any).revokeObjectURL = vi.fn();
}

export const picture = (name = 'sign.png', type = 'image/png', size = 2000) => new File([new Uint8Array(size).fill(0x89)], name, { type });

/** Snapshots of every iframe body while the test runs (PrintFrame prints a hidden iframe, then removes it). */
export function frameSpy() {
  const seen: string[] = [];
  const t = setInterval(() => {
    for (const f of Array.from(document.querySelectorAll('iframe'))) { const h = f.contentDocument?.body?.innerHTML; if (h) seen.push(h); }
  }, 1);
  return { seen, stop: () => clearInterval(t), last: () => seen[seen.length - 1] ?? '' };
}
