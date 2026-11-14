import 'server-only';
// C16.T-L1 BFF calls for W8 (contracts/openapi/engagement.yaml L1–L4; C4 getPatient for the header; T1 settings for the consent text).
// The bearer token is added by serverFetch on the server. Ids are shape-checked before they reach a URL.
import { serverFetch } from '@/core/api/server-fetch';
import { UUID_RE } from './queue.server';
import type { AppLink, IssueBody, IssuedCode, LinkCodeRow } from '../components/AppAccess';

export const PERM = { read: 'engagement.link.read', issue: 'engagement.link.issue', revoke: 'engagement.link.revoke' } as const;

const id = (v: string) => { if (!UUID_RE.test(v)) throw new Error('invalid id'); return encodeURIComponent(v); };
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** C4 header data. phone_e164 is never passed on to the client; only the masked phone. */
export async function getPatient(patientId: string) {
  const p = await serverFetch<{ id: string; full_name: string; patient_code?: string; phone_masked?: string | null }>(`/v1/frontdesk/patients/${id(patientId)}`);
  return { id: p.id, display_name: p.full_name, patient_code: p.patient_code ?? '', phone_masked: p.phone_masked ?? null };
}

/** T1: app consent text + version (null when the tenant has none configured, or the actor cannot read settings). */
export async function getConsent(): Promise<{ version: string; text: string } | null> {
  const s = await serverFetch<{ app_consent_text?: string | null; app_consent_text_version?: string | null }>('/v1/engagement/settings').catch(() => undefined);
  return s?.app_consent_text && s.app_consent_text_version ? { text: s.app_consent_text, version: s.app_consent_text_version } : null;
}

/** L3 */
export async function listAppLinks(patientId: string): Promise<{ links: AppLink[]; codes: LinkCodeRow[] }> {
  const r = await serverFetch<{ data?: AppLink[]; codes?: LinkCodeRow[] }>(`/v1/engagement/patients/${id(patientId)}/app-links`);
  return { links: Array.isArray(r?.data) ? r.data : [], codes: Array.isArray(r?.codes) ? r.codes : [] };
}

/** L1: x-idempotency none — the 201 body holds the plaintext code, so it is never stored or cached (TRD §5.4). */
export const issueLinkCode = (body: IssueBody) => serverFetch<IssuedCode>('/v1/engagement/link-codes', { ...post(body), cache: 'no-store' });

/** L2: link_codes has no version column; the API's ETag is the constant "1" (T-L1-impl [CONV]). */
export const revokeLinkCode = (linkCodeId: string) => serverFetch<unknown>(`/v1/engagement/link-codes/${id(linkCodeId)}/revoke`, post(undefined, { 'If-Match': '"1"' }));

/** L4 */
export const revokeAppLink = (linkId: string, version: number, body: { reason_code: string }) =>
  serverFetch<unknown>(`/v1/engagement/app-links/${id(linkId)}/revoke`, post(body, { 'If-Match': `"${version}"` }));
