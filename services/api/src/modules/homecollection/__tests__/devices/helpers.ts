// HC-T10 harness: A1 registerPhleboDevice (POST /v1/homecollection/devices) and A5 signOffPhleboDevice (POST /v1/homecollection/devices/{device_id}/sign-off).
// Same convention as ../visits/helpers.ts (HC-T08), which is reused as is: the handler under test is taken from the module manifest and driven with a request-shaped object + a HandlerContext over a REAL
// PG17 tx (lims_api, RLS on; `bypassRls` = superuser tx so only the repo's own explicit tenant_id filter can keep tenants apart). The core pipeline (schema validation, auth, x-permission, Idempotency-Key
// replay) is NOT re-tested; the headers the pipeline hands over are passed lower-cased (`x-lims-device-id`, `x-lims-app-version`, 02-TRD §5 preamble).
// ASSUMED ctx: as ../visits/helpers.ts (IdentityPort.assertRole, core.memberships.list for display_name, tx, now(), actor{type,id,membershipId}). Synthetic data only.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T10.pg.sh.
import { NOW, NOBODY, P, PHLEBO, PHLEBO2, DISPATCHER, MEMBER, MEMBER2, TENANT_A, TENANT_B, SYS_ACTOR, T, as, op, opOf, ownerRows, req, rejection, responseErrors, schemaErrors, spec, staffName, superTx, uid,
  type OpOpts, type Who } from '../visits/helpers.js';
import { hc, seed } from '../../repository/__tests__/helpers.js';

export { NOW, NOBODY, P, PHLEBO, PHLEBO2, DISPATCHER, MEMBER, MEMBER2, TENANT_A, TENANT_B, SYS_ACTOR, T, as, opOf, ownerRows, rejection, responseErrors, schemaErrors, spec, staffName, superTx, uid, hc, seed };
export type { Who };

/** A UUIDv7-shaped id (version nibble 7, variant 8): the contract type of device_id. */
export const v7 = (): string => { const h = uid().replace(/-/g, ''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export const APP = '1.0.0';
export const hdr = (deviceId: string, appVersion: string = APP) => ({ 'x-lims-device-id': deviceId, 'x-lims-app-version': appVersion });
/** A valid A1 body (02-TRD §5.2 A1). */
export const regBody = (deviceId: string, o: Record<string, unknown> = {}) => ({ device_id: deviceId, platform: 'android', os_version: '14', app_version: APP, model: 'Synthetic Phone A', ...o });

type CallOpts = OpOpts & { headers?: object };
export const register = (body: unknown, who: Who = PHLEBO, o: CallOpts = {}) => {
  const b: any = body;
  return op('registerPhleboDevice', req({ body, headers: o.headers ?? hdr(b?.device_id ?? v7(), b?.app_version ?? APP) }), who, o);
};
export const registerFails = (body: unknown, who: Who = PHLEBO, o: CallOpts = {}) => rejection(register(body, who, o));
export const signOff = (deviceId: string, body: unknown, who: Who = PHLEBO, o: CallOpts = {}) =>
  op('signOffPhleboDevice', req({ params: { device_id: deviceId }, body, headers: o.headers ?? hdr(deviceId) }), who, o);
export const signOffFails = (deviceId: string, body: unknown, who: Who = PHLEBO, o: CallOpts = {}) => rejection(signOff(deviceId, body, who, o));

export const deviceRows = (id: string) => ownerRows('homecollection.devices', 'id = $1', [id]);
export const deviceRow = async (id: string) => (await deviceRows(id))[0];
/** Seed a committed device row of tenant `s` (default: active, bound to MEMBER[s], max_device_seq_received 0). */
export async function seedDevice(s: 'a' | 'b', o: Record<string, unknown> = {}): Promise<any> {
  const d = hc.device(s, { id: v7(), ...o });
  await seed('homecollection.devices', d);
  return d;
}
/** The fields a refused sign-off / failed register must leave alone. */
export const frozen = (r: any) => ({ status: r.status, version: r.version, max_device_seq_received: r.max_device_seq_received, signed_off_at: r.signed_off_at, wipe_requested_at: r.wipe_requested_at,
  wiped_at: r.wiped_at, membership_id: r.membership_id, app_version: r.app_version, os_version: r.os_version });
export const setMinAppVersion = (tenant: string, v: string) =>
  superTx(async (tx) => { await tx.query('UPDATE homecollection.settings SET min_app_version = $2 WHERE tenant_id = $1', [tenant, v]); }, tenant);
