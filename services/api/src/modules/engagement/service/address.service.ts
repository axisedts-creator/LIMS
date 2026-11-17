// E37 listMyAddresses, E38 createMyAddress, E39 updateMyAddress, E40 deactivateMyAddress (patient actor; A19 addresses for home collection; 02-TRD §5; 05-SCHEMA addresses; 01-PRD US-EN-13.1; 07-SECURITY AB-6, REQ-SEC-024 / 098).
// The row's account_id = the caller's account (signed membership claim), patient_id = the profile's patient (the ACTIVE link named by profile_id), never from input. Foreign / staff-entered / other-tenant / deactivated ids are 404 BEFORE
// the version is compared (AB-6). Error details are fixed text and never echo a submitted value; address text, landmark and phone never reach a log, URL or event (REQ-SEC-098).
// [CONV] At most 10 ACTIVE addresses per account (TRD §5 E38): the 11th is 409 engagement.link_limit_reached. [CONV] latitude / longitude are staff-entered only in v1 (05-SCHEMA addresses): a patient body that carries them is an unknown field.
// [CONV] E39 is a full replacement of the text fields; the profile cannot be moved to another patient (patient_id is immutable, enforce_mutable_columns): another profile of the account -> 400 /profile_id, a profile that is not the caller's active link -> 404.
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as repo from '../repository/address.repo.js';
import type { AddressValues, Row } from '../repository/address.repo.js';
import * as myRepo from '../repository/mybooking.repo.js';
import { invalid, isUuid, parseIfMatch, patientScope, type SlotCtx } from './slot.service.js';

export type AddressCtx = SlotCtx & { readonly claims?: { readonly membership_id?: unknown } };
type Out = { status: number; body?: Record<string, unknown> };

const MAX_ACTIVE = 10;
const FIELDS = ['profile_id', 'label', 'address_text', 'landmark', 'municipality', 'ward_no', 'district', 'contact_phone_e164'];
const LABELS = ['home', 'work', 'other'];
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  if (code === '23514') return invalid('/', 'common.field_invalid', 'Field invalid');
  throw new LimsError('common.internal');
}

/** AddressInput (strict: unknown keys incl. account_id / patient_id / id / version / is_active are refused with a fixed path). */
function parseInput(body: unknown): { profileId: string; v: AddressValues } {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw new LimsError('common.validation_failed', undefined, [{ path: '/', code: 'common.unknown_field', message: 'Unknown field' } satisfies FieldError]);
  for (const k of ['profile_id', 'label', 'address_text']) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  const text = (k: string, max: number, min = 0): string | null => {
    const x = body[k];
    if (x === undefined) return null;
    if (typeof x !== 'string' || x.length < min || x.length > max) invalid(`/${k}`);
    return x as string;
  };
  if (!isUuid(body['profile_id'])) invalid('/profile_id');
  if (typeof body['label'] !== 'string' || !LABELS.includes(body['label'])) invalid('/label');
  const ward = body['ward_no'];
  if (ward !== undefined && (typeof ward !== 'number' || !Number.isInteger(ward) || ward < 1 || ward > 99)) invalid('/ward_no');
  const phone = body['contact_phone_e164'];
  if (phone !== undefined && (typeof phone !== 'string' || !PHONE.test(phone))) invalid('/contact_phone_e164');
  return {
    profileId: body['profile_id'] as string,
    v: { label: body['label'] as string, addressText: text('address_text', 300, 1)!, landmark: text('landmark', 120), municipality: text('municipality', 80), wardNo: (ward as number | undefined) ?? null, district: text('district', 60), phone: (phone as string | undefined) ?? null },
  };
}

export function createAddressService() {
  const mine = async (tx: any, tenantId: string, membershipId: string, lock = false): Promise<Row> => {
    const acc = await myRepo.account(tx, { tenantId, membershipId, lock });
    if (!acc) throw new LimsError('common.not_found');
    return acc;
  };
  /** Address -> Address schema: contract fields only, NULL columns omitted, profile_id = the link id (patient_id / account_id never leave). */
  const body = (r: Row, profileId: string): Record<string, unknown> => ({
    id: r['id'], profile_id: profileId, label: r['label'], address_text: r['address_text'],
    ...(r['landmark'] == null ? {} : { landmark: r['landmark'] }), ...(r['municipality'] == null ? {} : { municipality: r['municipality'] }), ...(r['ward_no'] == null ? {} : { ward_no: Number(r['ward_no']) }),
    ...(r['district'] == null ? {} : { district: r['district'] }), ...(r['contact_phone_e164'] == null ? {} : { contact_phone_e164: r['contact_phone_e164'] }), version: r['version'],
  });

  return {
    /** E37: the caller's active addresses, optionally of one profile; a foreign / unknown profile_id matches nothing. */
    async list(ctx: AddressCtx, input: { query: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = patientScope(ctx);
      const q = isObj(input.query) ? input.query : {};
      if (q['profile_id'] !== undefined && !isUuid(q['profile_id'])) invalid('/profile_id');
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const links = (await myRepo.activeLinks(tx, { tenantId, accountId: acc['id'] })).filter((l) => q['profile_id'] === undefined || l.id === q['profile_id']);
        const linkOf = new Map(links.map((l) => [l.patientId, l.id]));
        const rows = (await repo.listMine(tx, { tenantId, accountId: acc['id'] })).filter((r) => linkOf.has(r['patient_id']));
        return { status: 200, body: { data: rows.map((r) => body(r, linkOf.get(r['patient_id'])!)) } };
      } catch (e) { return mapDbError(e); }
    },

    /** E38: body (400) -> profile = caller's ACTIVE link (404) -> cap (409) -> INSERT. */
    async create(ctx: AddressCtx, input: { body: unknown }): Promise<Out> {
      const { tx, tenantId, userId, membershipId } = patientScope(ctx);
      const p = parseInput(input.body);
      try {
        const acc = await mine(tx, tenantId, membershipId, true); // locked: concurrent creates cannot overshoot the cap
        const link = (await myRepo.activeLinks(tx, { tenantId, accountId: acc['id'] })).find((l) => l.id === p.profileId);
        if (!link) throw new LimsError('common.not_found');
        if ((await repo.countActive(tx, { tenantId, accountId: acc['id'] })) >= MAX_ACTIVE) throw new LimsError('engagement.link_limit_reached');
        return { status: 201, body: body(await repo.insert(tx, { tenantId, userId, accountId: acc['id'], patientId: link.patientId, v: p.v }), link.id) };
      } catch (e) { return mapDbError(e); }
    },

    /** E39: If-Match (428 / 400) -> id (400) -> body (400) -> own active row (404) -> version (409) -> profile (404 / 400) -> UPDATE. */
    async update(ctx: AddressCtx, input: { id: unknown; headers: unknown; body: unknown }): Promise<Out> {
      const { tx, tenantId, userId, membershipId } = patientScope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/address_id');
      const p = parseInput(input.body);
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const cur = await repo.getMine(tx, { tenantId, accountId: acc['id'], id: input.id });
        if (!cur || !cur['is_active']) throw new LimsError('common.not_found'); // a deactivated address is gone; an update never reactivates
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const link = (await myRepo.activeLinks(tx, { tenantId, accountId: acc['id'] })).find((l) => l.id === p.profileId);
        if (!link) throw new LimsError('common.not_found');
        if (link.patientId !== cur['patient_id']) return invalid('/profile_id', 'common.field_invalid', 'Profile cannot be changed');
        const row = await repo.update(tx, { tenantId, userId, accountId: acc['id'], id: input.id, expectedVersion: expected, v: p.v });
        if (!row) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
        return { status: 200, body: body(row, link.id) };
      } catch (e) { return mapDbError(e); }
    },

    /** E40: If-Match (428 / 400) -> id (400) -> own active row (404) -> version (409) -> is_active = false (204, no body). The address row stays: a booking that used it keeps its home_address_id. */
    async deactivate(ctx: AddressCtx, input: { id: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, userId, membershipId } = patientScope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/address_id');
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const cur = await repo.getMine(tx, { tenantId, accountId: acc['id'], id: input.id });
        if (!cur || !cur['is_active']) throw new LimsError('common.not_found');
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        if (!(await repo.deactivate(tx, { tenantId, userId, accountId: acc['id'], id: input.id, expectedVersion: expected }))) throw new LimsError('common.version_conflict');
        return { status: 204 };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type AddressService = ReturnType<typeof createAddressService>;
