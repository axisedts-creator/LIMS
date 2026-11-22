// @vitest-environment jsdom
// T0D-FIX-9 (LD-455) previewPrintProfile (screen reporting settings, "Print and stationery" Preview area): the live call answered 500 common.internal and the screen
// said only "Could not prepare the preview" with no reference. RULE (task): a failed call is shown inside its section as a kit inline error WITH the reference
// ("Reference: <request id>"). The failure of the api side itself is tested in the api suite (fix9.preview-500.test.ts: no centre in the real request context).
// Uses the printcfg1 harness (read only). The preview route is overridden here with a problem body that carries a request id, as the real api does.
// ASSUMED (dispute if wrong): the reference is rendered inside role=alert of region "Preview" as `Reference: <first 8+ chars of the request id>`; editing keeps working.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { API, MANAGE_BOTH, ORIGIN, api, openReportingSettings, profile } from './printcfg1.harness';

const REQ = '01a20344-ed18-71c0-a027-d9a883db286d';
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); API.profiles = [profile()]; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const failWith = (status: number, code: string) =>
  api.use(http.post(`${ORIGIN}/v1/reporting/print-profiles/preview`, () => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: REQ }, { status, headers: { 'content-type': 'application/problem+json' } })));
const previewAlert = async () => {
  const s = await screen.findByRole('region', { name: /print and stationery/i });
  const region = within(s).getByRole('region', { name: /preview/i });
  return within(region).findByRole('alert', {}, { timeout: 6000 });
};

describe('previewPrintProfile failure is shown with its reference', () => {
  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('a mocked %i (%s): the Preview area shows an alert with "Reference: <request id>" and does not look like an empty preview', async (status, code) => {
    failWith(status, code);
    await openReportingSettings(MANAGE_BOTH);
    const alert = await previewAlert();
    expect(alert.textContent).toMatch(new RegExp(`Reference:\\s*${REQ.slice(0, 8)}`));
  });
  it('a healthy preview shows no alert and no reference (guard)', async () => {
    await openReportingSettings(MANAGE_BOTH);
    const s = await screen.findByRole('region', { name: /print and stationery/i });
    await waitFor(() => expect(within(within(s).getByRole('region', { name: /preview/i })).getByTitle(/A4 preview/i)).toBeTruthy(), { timeout: 6000 });
    expect(within(s).queryByText(/Reference:/)).toBeNull();
  });
});
