// @vitest-environment jsdom
// C11.T-20 — Case workspace "Images" tab + BFF image-content route (04-UI-UX §4.2.5, §6, §8; 03-APP-FLOW §4.x image upload; AC-12.6 / 12.7 / 12.8 (UI side);
//   07-SECURITY REQ-SEC-083/085/088/098, AB-1, AB-6, D-66, D-67). LD-140 (2026-11-13): kit components only; every status shows tone + icon + word.
// ASSUMED (t20.harness.tsx header): the tab is reached through CaseWorkspace by its tab name "Images". Thumbnails are same-origin `<img src="/anatomic/images/{id}/content">` served by the BFF route
//   app/(staff)/anatomic/images/[image_id]/content/route.ts (GET). Upload = kit FileUpload labelled "Upload images" -> one multipart POST per file with its own Idempotency-Key.
//   Per-image edit = Kind (Select) / Part (Select) / Caption (TextField) + [Save] -> PUT /images/{id} If-Match "<version>"; [Remove from case] -> ConfirmDialog -> POST /images/{id}/deactivate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_READ, PERM_WORK, api, hit, hits, image, problem, resetHits, router, state, t20Defaults, workedCase } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); state.token = 'jwt-synthetic'; state.permissions = PERM_WORK; api.use(...t20Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const withImages = (images: unknown[], over: Record<string, unknown> = {}) => workedCase({ images, ...over });
const mount = async (d: Record<string, unknown>, permissions = PERM_WORK) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  const r = render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={[]} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^images$/i }));
  return r;
};
const PNG = (name = 'synthetic.png', type = 'image/png', size = 64) => new File([new Uint8Array(size).fill(1)], name, { type });
const text = () => document.body.textContent ?? '';
const itemOf = (alt: string) => screen.getByAltText(alt).closest('li, tr, [role=row], article, [role=listitem]') as HTMLElement;
const uploadInput = () => screen.getByLabelText(/upload images/i, { selector: 'input' }) as HTMLInputElement;
const uploads = () => hit('POST', /^\/v1\/anatomic\/cases\/[^/]+\/images$/);
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('gallery', () => {
  it('ready images show a same-origin BFF thumbnail (no signed URL, no API origin) with alt = caption; fallback alt "Image {n}, {kind}, part {letter}" (no patient data)', async () => {
    await mount(withImages([image(1), image(2, { caption: undefined, kind: 'microscopy' })]));
    const imgs = Array.from(document.querySelectorAll('img'));
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute('src')).toBe(`/anatomic/images/${ID(501)}/content`);
    expect(imgs[1]!.getAttribute('src')).toBe(`/anatomic/images/${ID(502)}/content`);
    expect(imgs[0]!.getAttribute('alt')).toBe('Synthetic caption 1');
    expect(imgs[1]!.getAttribute('alt')).toMatch(/^Image 2, microscopy, part A$/i);
    for (const i of imgs) expect(i.getAttribute('src')).not.toMatch(/^https?:|api\.test|token|signature/i);
  });

  it('non-ready images are never requested: processing -> "Processing…" chip, quarantined -> danger chip "Blocked by security scan", no <img>', async () => {
    await mount(withImages([image(1, { state: 'processing' }), image(2, { state: 'quarantined' }), image(3)]));
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(text()).toMatch(/Processing…|Checking the file for viruses/);
    expect(text()).toMatch(/Blocked by security scan|could not be used/);
    const blocked = Array.from(document.querySelectorAll('[data-tone="danger"]')).find((e) => /Blocked by security scan|could not be used/.test(e.textContent ?? ''));
    expect(blocked, 'danger-tone chip with a word').toBeTruthy();
    for (const n of [501, 502]) expect(document.body.innerHTML, `image ${n} (processing / quarantined)`).not.toContain(`/anatomic/images/${ID(n)}/`); // only the ready image (503) has a src
  });

  it('only active images are shown (deactivated ones leave the working gallery, AC-12.7)', async () => {
    await mount(withImages([image(1), image(2, { is_active: false, caption: 'Synthetic hidden' })]));
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(text()).not.toContain('Synthetic hidden');
  });

  it('empty: "No images. Upload gross or microscopy photos."', async () => {
    await mount(withImages([]));
    expect(text()).toContain('No images. Upload gross or microscopy photos.');
  });

  it('captions are text, never HTML (REQ-SEC-088)', async () => {
    await mount(withImages([image(1, { caption: '<script>alert(1)</script>' })]));
    expect(document.querySelector('script')).toBeNull();
  });

  it('a processing image is polled: router.refresh() within ~3 s (03-APP-FLOW: every 3 s, max 2 min)', async () => {
    await mount(withImages([image(1, { state: 'processing' })]));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled(), { timeout: 5000 });
  }, 10000);

  it('no polling when nothing is processing', async () => {
    await mount(withImages([image(1)]));
    await new Promise((r) => setTimeout(r, 3400));
    expect(router.refresh).not.toHaveBeenCalled();
  }, 10000);
});

describe('metadata edit and remove', () => {
  it('Caption has maxlength 200 and the hint "Do not type patient names in captions."', async () => {
    await mount(withImages([image(1)]));
    expect(within(itemOf('Synthetic caption 1')).getByLabelText(/caption/i).getAttribute('maxlength')).toBe('200');
    expect(text()).toContain('Do not type patient names in captions.');
  });

  it('Kind / Part / Caption -> [Save]: PUT /images/{id} with If-Match "<version>" and {kind, part_id, caption}', async () => {
    await mount(withImages([image(1, { version: 4 })]));
    const it1 = itemOf('Synthetic caption 1');
    await choose(it1, /kind$/i, /^microscopy$/i);
    const cap = within(it1).getByLabelText(/caption/i);
    await userEvent.clear(cap);
    await userEvent.type(cap, 'Synthetic new caption');
    await userEvent.click(within(it1).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('PUT', /\/images\/[^/]+$/)).toHaveLength(1));
    const p = hit('PUT', /\/images\/[^/]+$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/images/${ID(501)}`);
    expect(p.headers.get('if-match')).toBe('"4"');
    expect(p.json).toEqual({ kind: 'microscopy', part_id: ID(101), caption: 'Synthetic new caption' });
  });

  it('409 anatomic.signout_locked (image in a signed version) -> "This case is signed out. Use Revise/Amend or add an addendum."', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/images/:id`, () => problem('anatomic.signout_locked', 409)));
    await mount(withImages([image(1)]));
    await userEvent.click(within(itemOf('Synthetic caption 1')).getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText('This case is signed out. Use Revise/Amend or add an addendum.')).toBeTruthy();
  });

  it('[Remove from case] asks "Remove this image from the case? Signed reports that include it keep it."; Cancel sends nothing; Confirm POSTs /deactivate with If-Match + Idempotency-Key', async () => {
    await mount(withImages([image(1, { version: 2 })]));
    await userEvent.click(within(itemOf('Synthetic caption 1')).getByRole('button', { name: /remove from case|remove/i }));
    const d = await screen.findByRole('dialog'); // kit ConfirmDialog = kit Dialog (role dialog); ruling T-20
    expect(d.textContent).toContain('Remove this image from the case? Signed reports that include it keep it.');
    await userEvent.click(within(d).getByRole('button', { name: /cancel|keep/i }));
    expect(hit('POST', /deactivate$/)).toHaveLength(0);
    await userEvent.click(within(itemOf('Synthetic caption 1')).getByRole('button', { name: /remove from case|remove/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(hit('POST', /deactivate$/)).toHaveLength(1));
    const p = hit('POST', /deactivate$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/images/${ID(501)}/deactivate`);
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a user without anatomic.case.work sees the images read-only: no upload, no edit fields, no Remove', async () => {
    await mount(withImages([image(1)]), PERM_READ);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(screen.queryByLabelText(/upload images/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });
});

describe('upload (FileUpload: png/jpeg, 15 MB, multiple, max 10)', () => {
  it('the input accepts only image/png and image/jpeg, is multiple, and says 15 MB', async () => {
    await mount(withImages([]));
    const input = uploadInput();
    expect(input.multiple).toBe(true);
    expect(input.accept.split(',').map((s) => s.trim()).sort()).toEqual(['image/jpeg', 'image/png']);
  });

  it('one multipart POST per file, each with its own Idempotency-Key; the part form carries kind (default gross) and no patient data', async () => {
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG('a.png'), PNG('b.jpg', 'image/jpeg')]);
    await waitFor(() => expect(uploads()).toHaveLength(2));
    const keys = uploads().map((u) => u.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k).toMatch(IDEM_RE);
    for (const u of uploads()) {
      expect(u.path).toBe(`/v1/anatomic/cases/${ID(1)}/images`);
      expect(u.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      expect(u.body).toMatch(/name="file"/);
      expect(u.body).toMatch(/name="kind"[\s\S]*?\r\n\r\n(gross|microscopy|other)\r\n/);
    }
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('wrong declared type (image/svg+xml), empty file, > 15 MB, and > 10 files are rejected in the browser: no request', async () => {
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG('x.svg', 'image/svg+xml')]);
    await userEvent.upload(uploadInput(), [new File([], 'empty.png', { type: 'image/png' })]);
    await userEvent.upload(uploadInput(), [PNG('big.png', 'image/png', 15 * 1024 * 1024 + 1)]);
    await userEvent.upload(uploadInput(), Array.from({ length: 11 }, (_, i) => PNG(`m${i}.png`)));
    expect(uploads()).toHaveLength(0);
  });

  it('413 -> "This file is larger than 15 MB."; 415 -> "Only PNG and JPEG images can be uploaded."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/images`, () => problem('common.payload_too_large', 413)));
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG()]);
    expect(await screen.findByText('This file is larger than 15 MB.')).toBeTruthy();
    cleanup();
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/images`, () => problem('common.unsupported_media_type', 415)));
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG()]);
    expect(await screen.findByText('Only PNG and JPEG images can be uploaded.')).toBeTruthy();
  });

  it('422 anatomic.image_limit_reached -> "This case already has the maximum number of images"', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/images`, () => problem('anatomic.image_limit_reached', 422)));
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG()]);
    expect(await screen.findByText(/This case already has the maximum number of images|Image limit reached/)).toBeTruthy();
  });

  it('upload stays available on a signed_out case (AC-12.8, D-66 (a))', async () => {
    await mount(withImages([], { status: 'signed_out', allowed_actions: [] }));
    expect(uploadInput().disabled).toBe(false);
    await userEvent.upload(uploadInput(), [PNG()]);
    await waitFor(() => expect(uploads()).toHaveLength(1));
  });

  it('the original file name never reaches the page text or a URL (REQ-SEC-098)', async () => {
    await mount(withImages([]));
    await userEvent.upload(uploadInput(), [PNG('Patient-Jane-Doe-0042.png')]);
    await waitFor(() => expect(uploads()).toHaveLength(1));
    for (const h of hits) expect(h.path + h.search).not.toContain('Jane');
  });
});

describe('a11y and LD-140', () => {
  it('axe: gallery with ready / processing / quarantined images has no violations', async () => {
    await mount(withImages([image(1), image(2, { state: 'processing' }), image(3, { state: 'quarantined' })]));
    const v = (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    expect(v.map((x) => `${x.id}: ${x.help}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------- BFF route (D-67: the single inline-image exception to P-2)
describe('GET /anatomic/images/{image_id}/content (BFF stream)', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upstream = (over: { status?: number; type?: string; extra?: Record<string, string> } = {}) =>
    api.use(http.get(`${ORIGIN}/v1/anatomic/images/:id/content`, () => new HttpResponse(bytes, { status: over.status ?? 200, headers: { 'content-type': over.type ?? 'image/png', 'set-cookie': 'sid=leak', ...(over.extra ?? {}) } })));
  const call = async (image_id: string) => {
    const mod = await import('../../../app/(staff)/anatomic/images/[image_id]/content/route');
    return mod.GET(new Request(`http://localhost/anatomic/images/${image_id}/content`) as never, { params: Promise.resolve({ image_id }) } as never);
  };

  it('ready image: 200 with the stored mime, inline, nosniff, CSP default-src none + sandbox, no-store; bytes are passed through unchanged', async () => {
    upstream();
    const r = await call(ID(501));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-disposition')).toMatch(/^inline(;|$)/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  });

  it('forwards the staff session as a bearer token to GET /v1/anatomic/images/{id}/content, once, and relays no cookies', async () => {
    upstream();
    const r = await call(ID(501));
    const [h, ...rest] = hit('GET', /\/images\/[^/]+\/content$/);
    expect(rest).toHaveLength(0);
    expect(h!.path).toBe(`/v1/anatomic/images/${ID(501)}/content`);
    expect(h!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('jpeg is served as image/jpeg', async () => {
    upstream({ type: 'image/jpeg' });
    expect((await call(ID(501))).headers.get('content-type')).toBe('image/jpeg');
  });

  it.each([['text/html'], ['image/svg+xml'], ['application/octet-stream'], ['']])('upstream content-type %j is never streamed inline (>= 400, not that type, no bytes)', async (type) => {
    upstream({ type });
    const r = await call(ID(501));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers.get('content-type') ?? '').not.toContain(type || 'never');
    expect(new Uint8Array(await r.arrayBuffer())).not.toEqual(bytes);
  });

  it('422 common.upload_quarantined (processing / blocked) -> 422, no image bytes', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/images/:id/content`, () => problem('common.upload_quarantined', 422)));
    const r = await call(ID(501));
    expect(r.status).toBe(422);
    expect(r.headers.get('content-type') ?? '').not.toMatch(/^image\//);
  });

  it.each([[404], [403], [500]])('upstream %i is relayed as the same status with no body detail', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/images/:id/content`, () => problem(status === 404 ? 'common.not_found' : status === 403 ? 'auth.forbidden' : 'common.internal', status, { detail: 'secret-internal' })));
    const r = await call(ID(501));
    if (status === 500) expect(r.status).toBeGreaterThanOrEqual(500); // an upstream 5xx may surface as 500 or 502, never as a 2xx
    else expect(r.status).toBe(status);
    expect(await r.text()).not.toContain('secret-internal');
  });

  it('a non-UUID image_id is a 404 and never reaches the API (REQ-SEC-026/027, path traversal)', async () => {
    for (const bad of ['../../etc/passwd', '%2e%2e', 'abc', `${ID(501)}/../${ID(502)}`]) {
      const r = await call(bad);
      expect(r.status, bad).toBe(404);
    }
    expect(hits).toHaveLength(0);
  });

  it('no session -> 401 and no upstream call', async () => {
    state.token = undefined;
    const r = await call(ID(501));
    expect(r.status).toBe(401);
    expect(hits).toHaveLength(0);
  });

  it('only GET is exported (no state change through this route)', async () => {
    const mod = (await import('../../../app/(staff)/anatomic/images/[image_id]/content/route')) as Record<string, unknown>;
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mod[m], m).toBeUndefined();
  });
});
