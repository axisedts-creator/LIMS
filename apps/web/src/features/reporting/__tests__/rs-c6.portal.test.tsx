// @vitest-environment jsdom
// RS-C6 (LD-140; 10-DESIGN-SYSTEM s5 portal rules, s6, s8) public portal pages (apps/portal): server-render each page (the page functions are async server
// components, called directly with params), put the markup in jsdom and check structure + axe. Behaviour must not change: same forms, same targets,
// the app-fallback pages make no API call. Mobile-first / 44 px / token-only CSS is in rs-c6.static.test.ts (jsdom has no layout).
// The portal has no vitest of its own, so these run through apps/web (vitest.rs-c6.config.ts maps `@/` per importer). Synthetic data only.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Landing from '../../../../../portal/src/app/r/[token]/page';
import Report from '../../../../../portal/src/app/r/[token]/report/page';
import AppFallback from '../../../../../portal/src/app/app/[...slug]/page';
import AppReport from '../../../../../portal/src/app/app/reports/[report_id]/page';
import PhleboFallback from '../../../../../portal/src/app/phlebo/[...slug]/page';
import Home from '../../../../../portal/src/app/page';
import { getSession } from '../../../../../portal/src/server/session';

(globalThis as { React?: typeof React }).React = React; // portal tsconfig is jsx:preserve; give the transform the global it may expect

const callApi = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('../../../../../portal/src/features/portal/actions', () => ({ sendCode: vi.fn(), verifyCode: vi.fn() }));
vi.mock('../../../../../portal/src/server/session', () => ({ getSession: vi.fn(async () => 'synthetic-session') }));
vi.mock('../../../../../portal/src/server/api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), callApi }));

afterEach(() => { callApi.mockReset(); document.body.innerHTML = ''; });

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 url-safe chars
const show = (el: React.ReactElement) => {
  document.documentElement.lang = 'en';
  document.title = 'Portal page';
  document.body.innerHTML = `<main>${renderToStaticMarkup(el)}</main>`;
};
const noSeriousAxe = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const outline = () =>
  [...document.body.querySelectorAll('h1,h2,h3,button,a[href],form,[role="alert"],[role="status"],input[type="hidden"]')]
    .map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''} ${e.getAttribute('action') ?? e.getAttribute('href') ?? e.getAttribute('name') ?? ''} ${(e.tagName === 'INPUT' ? '' : e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`)
    .join('\n');
const h1s = () => document.querySelectorAll('h1');

const landing = async (q: Record<string, string> = {}) => {
  return Landing({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(q) });
};
const report = async (body: unknown, pay?: string) => {
  callApi.mockResolvedValue({ status: 200, body });
  return Report({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(pay ? { pay } : {}) });
};
const REPORT_BODY = (extra: Record<string, unknown> = {}) => ({
  lab_name: 'Synthetic Lab', patient_display: 'सिन्थेटिक रोगी', download: { report_version_id: 'v-1' },
  report: { report_kind: 'final', status_label: 'Final', issued_at: '2026-11-05T05:00:00.000Z', version_no: 2, panel_names: ['Complete blood count', 'रगत जाँच'] }, ...extra,
});

describe('RS-C6 portal: link landing (r/[token])', () => {
  it('default: one h1, "Send me a code" submits a form (no API call while rendering), axe clean', async () => {
    show(await landing());
    expect(h1s().length).toBe(1);
    expect(document.querySelector('form button[type="submit"]')?.textContent).toMatch(/send me a code/i);
    expect(callApi).not.toHaveBeenCalled(); // link-preview bots must not trigger an OTP
    await noSeriousAxe();
  });
  it('invalid link: alert + POST form to the reissue route, axe clean', async () => {
    show(await landing({ e: 'invalid' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/not valid/i);
    const f = document.querySelector('form')!;
    expect(f.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(f.getAttribute('action')).toBe(`/r/${TOKEN}/reissue`);
    await noSeriousAxe();
  });
  it('rate limit and generic error keep their alerts', async () => {
    show(await landing({ e: 'rate', m: '5' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/try again in 5 minutes/i);
    show(await landing({ e: 'error', ref: '01a1a98a-ac40-7000-8000-000000000001' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/something went wrong/i);
    expect(document.body.textContent).toMatch(/Reference: 01a1a98a-ac40-7000-8000-000000000001/);
  });
  it('re-issued: status message, axe clean', async () => {
    show(await landing({ r: '1' }));
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/new one will arrive/i);
    await noSeriousAxe();
  });
});

describe('RS-C6 portal: report page (r/[token]/report)', () => {
  it('shows lab, Devanagari patient and panel names verbatim; Download PDF and Sign out keep their targets; axe clean', async () => {
    show(await report(REPORT_BODY()));
    expect(h1s().length).toBe(1);
    expect(document.body.textContent).toContain('सिन्थेटिक रोगी');
    expect(document.body.textContent).toContain('रगत जाँच');
    expect(document.querySelector(`a[href="/r/${TOKEN}/download"]`)?.textContent).toMatch(/download pdf/i);
    const out = document.querySelector(`form[action="/r/${TOKEN}/signout"]`)!;
    expect(out.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(out.querySelector('button')?.textContent).toMatch(/sign out/i);
    await noSeriousAxe();
  });
  it('dues: one POST form per gateway with hidden gateway + nonce; "in progress" link; axe clean', async () => {
    show(await report(REPORT_BODY({ dues: { balance_due_paisa: 125000, online_gateways: ['esewa', 'khalti'] } })));
    const forms = [...document.querySelectorAll(`form[action="/r/${TOKEN}/pay"]`)];
    expect(forms.length).toBe(2);
    expect(forms.map((f) => (f.querySelector('input[name="gateway"]') as HTMLInputElement).value)).toEqual(['esewa', 'khalti']);
    for (const f of forms) expect((f.querySelector('input[name="nonce"]') as HTMLInputElement).value.length).toBeGreaterThan(10);
    expect(document.body.textContent).toMatch(/NPR 1250\.00/);
    await noSeriousAxe();
    show(await report(REPORT_BODY({ dues: { balance_due_paisa: 1000, online_gateways: ['esewa'], open_request: { id: 'pr-1', status: 'ready' } } })));
    expect(document.querySelector(`a[href="/r/${TOKEN}/payments/pr-1"]`)).toBeTruthy();
    expect(document.querySelector(`form[action="/r/${TOKEN}/pay"]`)).toBeNull();
  });
  it('updated notice keeps its text and a visually hidden tone word (not colour only)', async () => {
    show(await report(REPORT_BODY({ report: { ...REPORT_BODY().report, updated_notice: { previous_version_no: 1, updated_at: '2026-11-06T05:00:00.000Z' } } })));
    const n = document.querySelector('.lims-banner');
    expect(n?.textContent).toMatch(/Information: .*updated on/);
  });
  it('no session: redirects to the link page (no content without a session, AC-11.12)', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(Report({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) })).rejects.toThrow(`NEXT_REDIRECT /r/${TOKEN}`);
  });
});

describe('RS-C6 portal: app fallback pages (no data, no PHI, no API call)', () => {
  const pages: Array<[string, (p: unknown) => unknown, Record<string, string>]> = [
    ['app/[...slug]', AppFallback as never, { slug: 'x' }],
    ['app/reports/[report_id]', AppReport as never, { report_id: 'r1' }],
    ['phlebo/[...slug]', PhleboFallback as never, { slug: 'x' }],
  ];
  it.each(pages)('%s: one h1, a sentence of instruction, no API call, axe clean', async (_n, Page, params) => {
    show((await Page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(h1s().length).toBe(1);
    expect((document.querySelector('p')?.textContent ?? '').length).toBeGreaterThan(10);
    expect(callApi).not.toHaveBeenCalled();
    await noSeriousAxe();
  });
  it('the portal home is data-free too', async () => {
    show(Home());
    expect(h1s().length).toBe(1);
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('RS-C6 portal key-screen outline snapshots (recorded once by the writer, LD-170; a baseline, not proof the look is right)', () => {
  it('link landing', async () => { show(await landing()); expect(outline()).toMatchSnapshot(); });
  it('report page with dues', async () => {
    show(await report(REPORT_BODY({ dues: { balance_due_paisa: 125000, online_gateways: ['esewa'] } })));
    expect(outline()).toMatchSnapshot();
  });
  it('app fallback', async () => {
    show((await (AppFallback as never as () => unknown)()) as React.ReactElement);
    expect(outline()).toMatchSnapshot();
  });
});
