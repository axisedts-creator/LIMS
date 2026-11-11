// PG-T19 shared test helpers (tester-owned; not a test file). No vi.mock here: every test file declares its own mocks (they are hoisted per file).
import { expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status, headers });

export const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
export const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

export interface Call { method: string; url: URL; headers: Headers; body?: any }
/** Records a request (JSON body for non-GET) into `calls`. */
export const recorder = (calls: Call[]) => async (r: Request) => {
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) });
};

/** Opens the "Reason" select inside `scope` and picks the option. */
export const pick = async (scope: HTMLElement, option: RegExp | string, label: RegExp = /reason/i) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
export const isEnabled = (el: HTMLElement | null | undefined) => !!el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
/** Text a user/AT gets for a control: aria-describedby targets + title + aria-label. */
export const describedText = (el: HTMLElement) => {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return [...ids.map((i) => document.getElementById(i)?.textContent ?? ''), el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? ''].join(' ');
};
/** The kit Card whose h2 title is `name`. */
export const card = (name: string | RegExp) => screen.getByRole('heading', { name }).closest('.lims-card') as HTMLElement;
/** No problem+json code or kit/internal identifier is ever shown to a user. */
export const noRawCodes = () => expect(document.body.textContent).not.toMatch(/\b(payments|common|auth|billing)\.[a-z_]+\b|urn:lims|Bearer |jwt-synthetic/);
