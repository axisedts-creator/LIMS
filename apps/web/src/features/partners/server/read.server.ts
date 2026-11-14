import 'server-only';
// BFF reads for the staff partner screens (TRD §5.3 SA1/SA3/SA8, SI1/SI2, SP1, SR1, SS1). The API enforces permissions and the receiving-centre scope (US-06.2);
// callers only skip reads the session cannot make. Filter values are checked here so nothing but known shapes reaches the query string.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getAccessToken } from '@/core/session/server';
import { problem } from '@/core/session/types';
import { UUID_RE, type Manifest, type ManifestSummary, type Page, type Partner, type PartnerSummary, type PartnerUser, type Pickup, type Referrer, type Settings } from './types';

const A = '/v1/partners/admin';
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};

type Filters = Record<string, string | undefined>;
const SHAPES: Record<string, RegExp> = {
  status: /^[a-z_,]{1,80}$/, state: /^[a-z_,]{1,80}$/, mapping_state: /^[a-z_]{1,20}$/, sort: /^-?[a-z_]{1,30}$/,
  partner_id: UUID_RE, receiving_centre_id: UUID_RE, has_failed_lines: /^true$/, has_missing_samples: /^true$/,
  submitted_at_from: /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, submitted_at_to: /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/,
};
/** Query string from known filter keys; a value of the wrong shape is dropped, never forwarded. `q` is capped at 64 characters. */
const qs = (f: Filters, limit: number) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (!v) continue;
    if (k === 'q') p.set(k, v.slice(0, 64));
    else if (SHAPES[k]?.test(v)) p.set(k, v);
  }
  p.set('limit', String(limit));
  return `?${p}`;
};

export const listPartners = (f: Filters) => serverFetch<Page<PartnerSummary>>(`${A}/partners${qs(f, 50)}`);
export const getPartner = (partnerId: string) => serverFetch<Partner>(`${A}/partners/${id(partnerId)}`);
export const listPartnerUsers = (partnerId: string) => serverFetch<Page<PartnerUser>>(`${A}/partners/${id(partnerId)}/users?limit=100`);
export const listManifests = (f: Filters) => serverFetch<Page<ManifestSummary>>(`${A}/manifests${qs(f, 50)}`);
export const getManifest = (manifestId: string) => serverFetch<Manifest>(`${A}/manifests/${id(manifestId)}`);
export const listPickups = (f: Filters) => serverFetch<Page<Pickup>>(`${A}/pickup-requests${qs(f, 50)}`);
export const listReferrers = (f: Filters) => serverFetch<Page<Referrer>>(`${A}/referrers${qs(f, 50)}`);

/** SS1: the settings have no `version` field, so the response ETag (`"<n>"`) is the If-Match for the PUT. serverFetch drops headers, hence the direct call. */
export async function getSettings(): Promise<{ settings: Settings; etag: string }> {
  const origin = process.env.LIMS_ORIGIN_API;
  if (!origin) throw new Error('LIMS_ORIGIN_API is not set');
  const token = await getAccessToken();
  const res = await fetch(new URL(`${A}/settings`, origin), { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, cache: 'no-store', redirect: 'error' });
  const body = (await res.json().catch(() => undefined)) as (Settings & { code?: string }) | undefined;
  if (!res.ok) throw new ApiError(res.status, body?.code ? (body as never) : problem('common.internal', 'Internal error', res.status));
  const etag = (res.headers.get('etag') ?? '').replace(/^W\//, '');
  return { settings: body as Settings, etag: /^"\d+"$/.test(etag) ? etag : '' };
}
