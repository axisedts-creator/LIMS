// @vitest-environment jsdom
// AUTH-MFA-QR-2 (LD-247, founder report 2026-11-16: the QR is still not visible). MfaEnrolment step 2:
//   - qr_svg_base64 present (up to the contract's 20000 characters) -> the <img> via DataUriImage (never inline SVG); the kit's own guard must not refuse a 20000-character base64;
//   - qr_svg_base64 absent (the API omits it when it cannot draw it) -> a VISIBLE notice ABOVE the setup key, exact copy below; the page keeps working (key shown, Continue enabled, step 3 reachable).
// Expected now: fail (no notice is rendered when the QR is absent).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MfaEnrolment } from '../MfaEnrolment';

afterEach(cleanup);
const NOTICE = 'We could not draw the QR code. In your authenticator app choose enter a setup key and type the key below.';
const KEY = 'JBSWY3DPEHPK3PXP';
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const okAction = () => vi.fn(async (_fd?: unknown) => ({ ok: true as const }));
const start = (qr?: string) => vi.fn(async (_fd?: unknown) => ({ ok: true as const, factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', otpauth_uri: `otpauth://totp/LIMS:u?secret=${KEY}`, ...(qr === undefined ? {} : { qr_svg_base64: qr }), secret_base32: KEY }));
const toStep2 = async (startAction: ReturnType<typeof start>) => {
  render(<MfaEnrolment startAction={startAction} completeAction={okAction()} />); const u = userEvent.setup();
  await u.click(screen.getByRole('button', { name: /^continue$/i })); await waitFor(() => expect(text()).toContain(KEY)); return u;
};
/** 20000 base64 characters (the contract maximum): a valid-alphabet string whose length is a multiple of 4 */
const MAX_B64 = (() => { const head = '<svg xmlns="http://www.w3.org/2000/svg"><!--', tail = '--></svg>'; return Buffer.from(head + 'a'.repeat(15000 - head.length - tail.length) + tail, 'utf8').toString('base64'); })();

describe('AU-3 MfaEnrolment: the QR image and the notice when it is absent (AUTH-MFA-QR-2)', () => {
  it('a 20000-character qr_svg_base64 is rendered as the QR image (DataUriImage <img>, whole value in src), and no notice', async () => {
    expect(MAX_B64.length).toBe(20000);
    await toStep2(start(MAX_B64));
    const img = screen.getByRole('img', { name: 'QR code for your authenticator app' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;base64,${MAX_B64}`); expect(img.getAttribute('src')!.length).toBe('data:image/svg+xml;base64,'.length + 20000);
    expect(document.querySelector('svg[role="img"], svg[aria-label*="QR"]')).toBeNull(); expect(text()).not.toContain('We could not draw the QR code'); expect(text()).toContain(KEY);
  });
  it('a compact path-svg QR of a few KB is rendered too', async () => {
    const small = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path d="M4 4h7v1H4z"/></svg>', 'utf8').toString('base64');
    await toStep2(start(small)); expect(screen.getByRole('img', { name: 'QR code for your authenticator app' }).getAttribute('src')).toBe(`data:image/svg+xml;base64,${small}`); expect(text()).not.toContain('We could not draw the QR code');
  });
  it('qr_svg_base64 absent -> NO image and the exact visible notice, with the setup key still shown', async () => {
    await toStep2(start());
    expect(screen.queryByRole('img', { name: 'QR code for your authenticator app' })).toBeNull(); expect(document.querySelector('img')).toBeNull();
    expect(text()).toContain(NOTICE); expect(screen.getByText(NOTICE)).toBeTruthy(); expect(text()).toContain(KEY);
  });
  it('the notice sits ABOVE the setup key in the page', async () => {
    await toStep2(start());
    const notice = screen.getByText(NOTICE); const keyEl = screen.getByText(KEY, { exact: false });
    expect(notice.compareDocumentPosition(keyEl) & Node.DOCUMENT_POSITION_FOLLOWING, 'the key comes after the notice').toBeTruthy();
  });
  it.each([['an empty string', '']])('qr_svg_base64 as %s counts as absent: the notice shows and no image renders', async (_n, v) => {
    await toStep2(start(v)); expect(document.querySelector('img')).toBeNull(); expect(text()).toContain(NOTICE);
  });
  it('never breaks the page when the QR is absent: Continue is enabled, step 3 opens, the code is sent with the factor id', async () => {
    const startAction = start(); const completeAction = okAction(); render(<MfaEnrolment startAction={startAction} completeAction={completeAction} />); const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^continue$/i })); await waitFor(() => expect(text()).toContain(KEY));
    const box = screen.queryByRole('checkbox'); if (box) await u.click(box);
    await u.click(screen.getByRole('button', { name: /^continue$/i })); await waitFor(() => expect(text()).toMatch(/Step 3 of 3/));
    await u.click(screen.getAllByRole('textbox')[0]!); await u.paste('654321'); await u.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(completeAction).toHaveBeenCalled()); await waitFor(() => expect(text()).toContain('Two-step verification is on.'));
  });
  it('no notice before the factor is created (step 1, and while step 2 is loading) and none when the start action FAILS', async () => {
    render(<MfaEnrolment startAction={start()} completeAction={okAction()} />); expect(text()).not.toContain('We could not draw the QR code'); cleanup();
    const failing = vi.fn(async (_fd?: unknown) => ({ ok: false as const, code: 'common.dependency_unavailable' })); render(<MfaEnrolment startAction={failing as any} completeAction={okAction()} />); const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /^continue$/i })); await waitFor(() => expect(failing).toHaveBeenCalled()); await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy()); expect(text()).not.toContain('We could not draw the QR code');
  });
  it('E1: the notice never contains the key; the otpauth URI is not rendered on the page', async () => {
    await toStep2(start()); expect(NOTICE).not.toContain(KEY); expect(text()).not.toContain('otpauth://');
  });
});
