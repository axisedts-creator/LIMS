// @vitest-environment jsdom
// T0D-PRINTCFG-1 done_when (2) + (6): Signatories list on /reporting/settings (page default export; no component name pinned). ASSUMED contract (dispute if wrong):
//   region aria-label "Signatories" with a table whose column headers are Name, Title, Registration number, Signature, Active (always rendered, also when empty, with an empty line).
//   Rows = one per staff user whose role holds lab.result.approve (listUsers + listRoles permission_codes), joined to listSignatoryProfiles on user_id === membership_id
//   (gap: UserSummary has no user_id, see notes). Name = profile display_name when a profile exists, else the user display name. Signature cell: an <img> with an alt naming the
//   signature and a src that contains the asset id (served through the existing BFF proxy route; no new route), or the text "No signature". Active cell: Yes / No.
//   Text "Only pathologist sign-offs print as signatures" is on screen. Row button "Edit <name>" opens a dialog with Name, Title, Registration number, Active, a file input for the
//   signature image, "Remove signature" (when there is an image) and Save. The image is shrunk in the browser to fit 600 x 200 (never upscaled, aspect kept), must be at most 300 KB
//   after shrinking, PNG or JPEG only, and goes through uploadBrandingAsset (multipart file + kind, Idempotency-Key). Save is upsertSignatoryProfile (PUT) with
//   signature_asset_id = the uploaded asset id; remove = PUT without signature_asset_id. Server errors show role=alert inside the dialog and keep it open.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API, ASSET, ASSET_OLD, U_PATHO, U_PATHO2, U_TECH, allowedSignatoryKeys, api, img, openReportingSettings, picture, sigPuts, signatory, stubImaging, uploads, userRow, PATHO_ROLE, TECH_ROLE,
} from './printcfg1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); stubImaging(); API.signatories = [signatory(U_PATHO, 'Dr Synthetic Patho')]; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const user = () => userEvent.setup({ applyAccept: false });
const sec = async () => screen.findByRole('region', { name: /signatories/i });
const rowOf = (s: HTMLElement, name: RegExp) => within(s).getByText(name).closest('tr')!;
const lastPut = () => sigPuts().at(-1)!;
const dialog = () => screen.findByRole('dialog');
const fileInput = (d: HTMLElement) => d.querySelector('input[type="file"]') as HTMLInputElement;
const SAVE = /^save/i;

async function openEditor(u: ReturnType<typeof user>, name: RegExp) {
  await openReportingSettings();
  const s = await sec();
  await within(s).findByText(name);
  await u.click(within(s).getByRole('button', { name: new RegExp(`edit .*${name.source}`, 'i') }));
  return dialog();
}
/** Pick a file, give an eager upload time to finish, then Save (works whether the upload runs on pick or on Save). */
async function pickAndSave(u: ReturnType<typeof user>, d: HTMLElement, file: File) {
  await u.upload(fileInput(d), file);
  await new Promise((r) => setTimeout(r, 400));
  await u.click(within(d).getByRole('button', { name: SAVE }));
}

describe('list (done_when 2)', () => {
  it('column names are visible, one row per approve holder (technologists are not listed), image or "No signature", Active Yes/No, and the pathologist-only note', async () => {
    API.users.push(userRow(ID_NEW, 'Dr Inactive Patho', PATHO_ROLE));
    API.signatories.push(signatory(ID_NEW, 'Dr Inactive Patho', { signature_asset_id: undefined, is_active: false, title: undefined, registration_no: undefined }));
    await openReportingSettings();
    const s = await sec();
    await within(s).findByText('Dr Synthetic Patho');
    expect(within(s).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Name', 'Title', 'Registration number', 'Signature', 'Active']));
    expect(within(s).queryByText('Tina Technologist')).toBeNull();
    expect(within(s).getByText('Dr Second Patho')).toBeTruthy(); // approve holder without a profile yet
    expect(within(s).getByText(/only pathologist sign-offs print as signatures/i)).toBeTruthy();
    const a = rowOf(s, /^Dr Synthetic Patho$/);
    expect(within(a).getByText('Consultant Pathologist (SYNTHETIC)')).toBeTruthy();
    expect(within(a).getByText('SYN-REG-0001')).toBeTruthy();
    expect(within(a).getByRole('img', { name: /signature/i }).getAttribute('src')).toContain(ASSET_OLD);
    expect(within(a).getByText(/^yes$/i)).toBeTruthy();
    expect(within(rowOf(s, /^Dr Second Patho$/)).getByText(/no signature/i)).toBeTruthy();
    expect(within(rowOf(s, /^Dr Inactive Patho$/)).getByText(/^no$/i)).toBeTruthy();
  });

  it('empty: no approve holders still shows every column header and an empty line', async () => {
    API.users = [userRow(U_TECH, 'Tina Technologist', TECH_ROLE)];
    API.signatories = [];
    await openReportingSettings();
    const s = await sec();
    await waitFor(() => expect(within(s).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(5));
    expect(within(s).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Name', 'Title', 'Registration number', 'Signature', 'Active']));
    expect(within(s).getByText(/no (signatories|signers|pathologists|staff|one)/i)).toBeTruthy();
  });

  it('staff reads that fail (no identity permission) keep the section and its headers; the page does not crash', async () => {
    API.usersFail = true;
    await openReportingSettings();
    const s = await sec();
    expect(within(s).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole('region', { name: /reporting settings/i })).toBeTruthy();
  });

  it('a name from the server with markup is shown as text, never parsed', async () => {
    const nasty = '<img src=x onerror=alert(1)>';
    API.signatories = [signatory(U_PATHO, nasty)];
    await openReportingSettings();
    const s = await sec();
    expect(await within(s).findByText(nasty)).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
const ID_NEW = '01a1a98a-ac40-7000-8000-0000000f0150';

describe('row editor (done_when 2)', () => {
  it('edit a user without a profile: fields start from the user name; Save PUTs the contract fields only', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Second Patho/);
    expect((within(d).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Dr Second Patho');
    await u.type(within(d).getByLabelText(/^title/i), 'Consultant (SYNTHETIC)');
    await u.type(within(d).getByLabelText(/registration number/i), 'SYN-REG-0002');
    await u.click(within(d).getByRole('button', { name: SAVE }));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(lastPut().path).toBe(`/v1/reporting/signatory-profiles/${U_PATHO2}`);
    const body = lastPut().json;
    expect(Object.keys(body).every((k) => allowedSignatoryKeys.includes(k))).toBe(true);
    expect(body).toMatchObject({ display_name: 'Dr Second Patho', title: 'Consultant (SYNTHETIC)', registration_no: 'SYN-REG-0002', is_active: true });
    expect(body.signature_asset_id).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Active can be turned off', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Synthetic Patho/);
    await u.click(within(d).getByRole('switch', { name: /^active/i }));
    await u.click(within(d).getByRole('button', { name: SAVE }));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(lastPut().json.is_active).toBe(false);
  });

  it('typed text is plain text: markup in the name is refused, & and apostrophes go out verbatim', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Second Patho/);
    const name = within(d).getByLabelText(/^name/i);
    await u.clear(name); await u.click(name); await u.paste('Dr <b>X</b>');
    await u.click(within(d).getByRole('button', { name: SAVE }));
    expect(sigPuts().length).toBe(0);
    expect(within(d).getByText(/plain text|markup|< or >/i)).toBeTruthy();
    await u.clear(name); await u.click(name); await u.paste("Dr O'Neil & Co");
    await u.click(within(d).getByRole('button', { name: SAVE }));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(lastPut().json.display_name).toBe("Dr O'Neil & Co");
  });

  it('an empty name is refused in the browser', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Second Patho/);
    await u.clear(within(d).getByLabelText(/^name/i));
    await u.click(within(d).getByRole('button', { name: SAVE }));
    expect(sigPuts().length).toBe(0);
  });

  for (const [status, code] of [[404, 'common.not_found'], [400, 'common.validation_failed']] as const) {
    it(`a ${status} on save shows an alert in the dialog and keeps it open with the typed values`, async () => {
      const u = user();
      API.sigPutFail = { status, code };
      const d = await openEditor(u, /Dr Second Patho/);
      await u.type(within(d).getByLabelText(/^title/i), 'Keep me');
      await u.click(within(d).getByRole('button', { name: SAVE }));
      expect((await within(d).findByRole('alert')).textContent?.trim().length).toBeGreaterThan(5);
      expect((within(d).getByLabelText(/^title/i) as HTMLInputElement).value).toBe('Keep me');
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
  }
});

describe('signature image (done_when 2)', () => {
  it('uploads a PNG shrunk to fit 600 x 200 through the existing upload route, then saves the asset id', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Second Patho/);
    await pickAndSave(u, d, picture('sign.png', 'image/png', 4000));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(uploads().length).toBe(1);
    const up = uploads()[0]!;
    expect(up.headers.get('idempotency-key')?.length).toBeGreaterThan(8);
    expect(['logo', 'letterhead_header', 'letterhead_footer']).toContain(up.form!.get('kind')); // BrandingAssetUpload.kind enum (gap: no signature kind, see notes)
    const f = up.form!.get('file') as { name: string; text: string };
    expect(f.name).toMatch(/\.(png|jpe?g)$/i);
    expect(up.raw).toMatch(/content-type:\s*image\/(png|jpeg)/i);
    expect(f.text.length).toBeLessThanOrEqual(300 * 1024);
    expect(img.exported.length).toBeGreaterThan(0);
    for (const e of img.exported) { expect(e.w).toBeLessThanOrEqual(600); expect(e.h).toBeLessThanOrEqual(200); }
    expect(img.exported.at(-1)).toMatchObject({ w: 600, h: 200 }); // 1800 x 600 keeps its 3:1 ratio
    expect(lastPut().json.signature_asset_id).toBe(ASSET);
  });

  it('keeps the aspect ratio of a square picture (fits 200 x 200) and never upscales a small one', async () => {
    const u = user();
    img.w = 1000; img.h = 1000;
    let d = await openEditor(u, /Dr Second Patho/);
    await u.upload(fileInput(d), picture());
    await waitFor(() => expect(img.exported.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(img.exported.at(-1)).toMatchObject({ w: 200, h: 200 });
    cleanup(); API.reset(); img.exported.length = 0;
    img.w = 300; img.h = 100;
    d = await openEditor(u, /Dr Second Patho/);
    await u.upload(fileInput(d), picture());
    await waitFor(() => expect(img.exported.length).toBeGreaterThan(0), { timeout: 4000 });
    expect(img.exported.at(-1)).toMatchObject({ w: 300, h: 100 });
  });

  it('a result still above 300 KB after shrinking is refused with a message and nothing is uploaded or saved', async () => {
    const u = user();
    img.outBytes = 400_000;
    const d = await openEditor(u, /Dr Second Patho/);
    await pickAndSave(u, d, picture());
    expect(await within(d).findByText(/300 ?KB/i)).toBeTruthy();
    expect(uploads().length).toBe(0);
    expect(sigPuts().length).toBe(0);
  });

  for (const [name, type] of [['sign.gif', 'image/gif'], ['sign.pdf', 'application/pdf'], ['sign.svg', 'image/svg+xml']] as const) {
    it(`${type} is refused (PNG or JPEG only): message, no upload`, async () => {
      const u = user();
      const d = await openEditor(u, /Dr Second Patho/);
      await u.upload(fileInput(d), picture(name, type));
      await new Promise((r) => setTimeout(r, 300));
      expect(within(d).getByText(/png or jpe?g|not an allowed|file type|not supported/i)).toBeTruthy();
      expect(uploads().length).toBe(0);
    });
  }

  it('an upload the server refuses (413 / 422 quarantine) shows an alert and the profile is not saved with an image', async () => {
    const u = user();
    API.uploadFail = { status: 422, code: 'common.upload_quarantined' };
    const d = await openEditor(u, /Dr Second Patho/);
    await pickAndSave(u, d, picture());
    expect(await within(d).findByText(/could not|failed|refused|quarantin|not accepted/i)).toBeTruthy();
    for (const p of sigPuts()) expect(p.json.signature_asset_id).toBeUndefined();
  });

  it('replace: an existing image is shown, a new pick uploads and the PUT carries the new id', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Synthetic Patho/);
    expect(within(d).getByRole('img', { name: /signature/i }).getAttribute('src')).toContain(ASSET_OLD);
    await pickAndSave(u, d, picture('new.jpg', 'image/jpeg'));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(uploads().length).toBe(1);
    expect(lastPut().json.signature_asset_id).toBe(ASSET);
    expect(ASSET).not.toBe(ASSET_OLD);
  });

  it('remove: the image disappears and the PUT has no signature_asset_id', async () => {
    const u = user();
    const d = await openEditor(u, /Dr Synthetic Patho/);
    await u.click(within(d).getByRole('button', { name: /remove signature/i }));
    expect(within(d).queryByRole('img', { name: /signature/i })).toBeNull();
    await u.click(within(d).getByRole('button', { name: SAVE }));
    await waitFor(() => expect(sigPuts().length).toBe(1));
    expect(lastPut().json.signature_asset_id).toBeUndefined();
    expect(uploads().length).toBe(0);
  });
});
