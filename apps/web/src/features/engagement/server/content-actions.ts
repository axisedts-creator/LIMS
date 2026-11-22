'use server';
// T0D-CONTENT-1 server actions behind /engagement/content (LD-313; contracts/openapi/engagement.yaml portal content and profile images,
// identity.yaml uploadBrandingAsset). Server actions are public endpoints: ids, kinds and every body field are re-checked here and only the
// contract fields are forwarded. The API enforces engagement.content.manage / identity.settings.manage on every call (admin actions precedent);
// these actions add no authority of their own. Portal content is never deleted: "off" is deactivatePortalContent (history is kept).
import 'server-only';
import { randomUUID } from 'node:crypto';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import {
  CONTENT_KINDS, DATE_RE, IMAGE_MAX_BYTES, IMAGE_TYPES, PROFILE_KINDS, UUID_RE, bodyError, linkError, titleError,
  type ActionResult, type ContentFields, type ContentKind, type PortalContent, type ProfileHit, type ProfileImage, type ProfileKind,
} from '../components/content/content-model';

const E = '/v1/engagement';
const PC = `${E}/portal-content`;
const BRANDING = '/v1/identity/settings/branding-assets';

const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const kindOk = (v: unknown): v is ContentKind => CONTENT_KINDS.includes(v as ContentKind);
const profileKindOk = (v: unknown): v is ProfileKind => PROFILE_KINDS.includes(v as ProfileKind);
const versionOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

async function run<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string>; raw?: { body: Uint8Array<ArrayBuffer>; type: string } }): Promise<ActionResult<T>> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.raw) { headers['content-type'] = init.raw.type; body = init.raw.body; }
  else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
  try {
    return { ok: true, data: await serverFetch<T>(path, { method: init.method, headers, ...(body !== undefined ? { body } : {}) }) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    return { ok: false, status: 503, code: 'common.dependency_unavailable' };
  }
}

/** Whitelists and re-checks the PortalContentCreate / PortalContentUpdate fields; undefined when any field is refused. */
function clean(f: unknown, create: boolean): ContentFields | undefined {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return undefined;
  const o = f as Record<string, unknown>;
  const out: ContentFields = {};
  if (o['kind'] !== undefined) { if (!kindOk(o['kind'])) return undefined; out.kind = o['kind']; }
  if (o['title'] !== undefined) { if (typeof o['title'] !== 'string' || titleError(o['title'])) return undefined; out.title = o['title']; }
  if (o['body'] !== undefined) { if (typeof o['body'] !== 'string' || bodyError(o['body'])) return undefined; out.body = o['body']; }
  if (o['link_url'] !== undefined) { if (typeof o['link_url'] !== 'string' || !o['link_url'] || linkError(o['link_url'])) return undefined; out.link_url = o['link_url']; }
  if (o['image_attachment_id'] !== undefined) { if (!uuid(o['image_attachment_id'])) return undefined; out.image_attachment_id = o['image_attachment_id']; }
  for (const k of ['starts_on', 'ends_on'] as const) if (o[k] !== undefined) { if (typeof o[k] !== 'string' || !DATE_RE.test(o[k] as string)) return undefined; out[k] = o[k] as string; }
  if (out.starts_on && out.ends_on && out.ends_on < out.starts_on) return undefined;
  if (o['is_active'] !== undefined) { if (create || typeof o['is_active'] !== 'boolean') return undefined; out.is_active = o['is_active']; }
  if (create && (!out.kind || out.title === undefined)) return undefined;
  if (!create && Object.keys(out).length === 0) return undefined;
  return out;
}

/** createPortalContent (x-idempotency required). */
export async function createContentAction(fields: unknown) {
  const b = clean(fields, true);
  return b ? run<PortalContent>(PC, { method: 'POST', body: b, headers: { 'idempotency-key': randomUUID() } }) : bad();
}

/** updatePortalContent with If-Match = the version the screen holds (is_active true reactivates). */
export async function updateContentAction(id: string, version: number, fields: unknown) {
  const b = clean(fields, false);
  if (!uuid(id) || !versionOk(version) || !b) return bad();
  return run<PortalContent>(`${PC}/${encodeURIComponent(id)}`, { method: 'PATCH', body: b, headers: { 'if-match': `"${version}"` } });
}

/** deactivatePortalContent: the row stays, the patient app stops showing it. */
export async function deactivateContentAction(id: string, version: number) {
  if (!uuid(id) || !versionOk(version)) return bad();
  return run<PortalContent>(`${PC}/${encodeURIComponent(id)}/deactivate`, { method: 'POST', headers: { 'if-match': `"${version}"` } });
}

/** reorderPortalContent: every id of the kind, in the new order. */
export async function reorderContentAction(kind: unknown, ids: unknown) {
  if (!kindOk(kind) || !Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every(uuid) || new Set(ids).size !== ids.length) return bad();
  return run<{ data?: PortalContent[] }>(`${PC}/reorder`, { method: 'POST', body: { kind, ids } });
}

/** multipart/form-data from bytes (one "file" part + "kind"), same builder as the admin branding upload. */
async function multipart(file: Blob, filename: string, fields: Record<string, string>) {
  const boundary = `----lims${randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();
  const safe = (s: string) => s.replace(/["\r\n\\]/g, '_');
  const head = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${safe(k)}"\r\n\r\n${v}\r\n`).join('');
  const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe(filename)}"\r\nContent-Type: ${safe(file.type)}\r\n\r\n`;
  const parts = [enc.encode(head + fileHead), new Uint8Array(await file.arrayBuffer()), enc.encode(`\r\n--${boundary}--\r\n`)];
  const body = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/** uploadBrandingAsset (LD-313 d: the existing branding path, no new upload route). The server re-encodes, checks magic bytes and scans. */
export async function uploadContentImageAction(form: FormData) {
  const f = form instanceof FormData ? form.get('file') : null;
  if (!f || typeof f === 'string' || typeof (f as Blob).arrayBuffer !== 'function') return bad();
  const file = f as File;
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type) || file.size === 0 || file.size > IMAGE_MAX_BYTES) return bad();
  // [CONV] branding kinds are logo / letterhead_*; portal images are stored as kind logo (the contract offers no portal kind).
  const raw = await multipart(file, file.name || 'image', { kind: 'logo' });
  return run<{ asset_id: string; scan_state?: string }>(BRANDING, { method: 'POST', raw, headers: { 'idempotency-key': randomUUID() } });
}

/** setProfileImage (upsert, one image per profile). */
export async function setProfileImageAction(kind: unknown, profileId: unknown, assetId: unknown) {
  if (!profileKindOk(kind) || !uuid(profileId) || !uuid(assetId)) return bad();
  return run<ProfileImage>(`${E}/profile-images/${kind}/${encodeURIComponent(profileId)}`, { method: 'PUT', body: { image_attachment_id: assetId } });
}

/** clearProfileImage: the row is deactivated, not deleted. */
export async function clearProfileImageAction(kind: unknown, profileId: unknown) {
  if (!profileKindOk(kind) || !uuid(profileId)) return bad();
  return run<ProfileImage>(`${E}/profile-images/${kind}/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
}

/** Profile search: other modules own the profiles (C3 doctors, C2 centres and staff); the caller's own read permissions apply there. */
export async function searchProfilesAction(kind: unknown, q: unknown): Promise<ProfileHit[]> {
  if (!profileKindOk(kind) || typeof q !== 'string') return [];
  const text = q.trim().slice(0, 64);
  if (!text) return [];
  const json = { 'content-type': 'application/json' };
  try {
    if (kind === 'doctor') {
      const r = await serverFetch<{ data?: { id: string; display_name: string }[] }>('/v1/catalog/doctors/search', { method: 'POST', headers: json, body: JSON.stringify({ q: text, limit: 20 }) });
      return (r?.data ?? []).map((d) => ({ id: d.id, name: d.display_name }));
    }
    if (kind === 'staff') {
      if (text.length < 2) return [];
      const r = await serverFetch<{ data?: { membership_id: string; display_name: string }[] }>('/v1/identity/users/search', { method: 'POST', headers: json, body: JSON.stringify({ query: text }) });
      return (r?.data ?? []).slice(0, 20).map((u) => ({ id: u.membership_id, name: u.display_name }));
    }
    // ponytail: centres are few (one list call, filtered here); a server side filter when a tenant has hundreds
    const r = await serverFetch<{ data?: { centre_id?: string; id?: string; name: string }[] }>('/v1/identity/centres' /* LD-446: no limit */);
    const needle = text.toLowerCase();
    return (r?.data ?? []).filter((c) => c.name.toLowerCase().includes(needle)).slice(0, 20).map((c) => ({ id: (c.centre_id ?? c.id)!, name: c.name }));
  } catch {
    return [];
  }
}
