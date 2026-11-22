import 'server-only';
// T0D-CONTENT-1 reads for /engagement/content (listPortalContent, listProfileImages; LD-313). The bearer token is added by serverFetch.
import { serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import type { PortalContent, ProfileImage } from '../components/content/content-model';

export const PERM = { read: 'engagement.content.read', manage: 'engagement.content.manage', upload: 'identity.settings.manage' } as const;

type Page<T> = { data?: T[]; page?: { next_cursor?: string; has_more?: boolean } };

/** Every page of a cursor list (ponytail: capped at 20 pages of 200; portal content is a few dozen rows per tenant). */
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await serverFetch<Page<T>>(`${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(Array.isArray(r?.data) ? r.data : []));
    cursor = r?.page?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export async function sessionPermissions(): Promise<string[]> {
  return [...((await getShellSession())?.actor.permissions ?? [])];
}

export const listPortalContent = () => all<PortalContent>('/v1/engagement/portal-content');

/** Profile images with a display name where one is cheap to get (centres: one list call). Doctor and staff names need one call each, so they
 * are left out and the screen shows the profile type instead [CONV]. */
export async function listProfileImages(): Promise<ProfileImage[]> {
  const [images, centres] = await Promise.all([
    all<ProfileImage>('/v1/engagement/profile-images'),
    serverFetch<{ data?: { centre_id?: string; id?: string; name: string }[] }>('/v1/identity/centres' /* LD-446: no limit */).then((r) => r?.data ?? [], () => []),
  ]);
  const names = new Map(centres.map((c) => [c.centre_id ?? c.id, c.name]));
  return images.map((i) => (i.profile_kind === 'centre' && names.has(i.profile_id) ? { ...i, profile_name: names.get(i.profile_id)! } : i));
}
