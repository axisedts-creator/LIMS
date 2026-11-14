// SM-1 Partner manifests inbox (04-UI-UX §4). Default view = waiting for receipt, newest first. No centre filter is forced: the API scopes by receiving centre (US-06.2).
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { listManifests } from '@/features/partners/server/read.server';
import { ManifestInbox, WAITING } from '@/features/partners/components/ManifestInbox';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Partner manifests' };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const KEYS = ['partner_id', 'receiving_centre_id', 'submitted_at_from', 'submitted_at_to', 'has_failed_lines', 'has_missing_samples'] as const;

export default async function ManifestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  if (!(session?.actor.permissions ?? []).includes('partners.manifest.receive')) return <PermissionNotice />;
  const filters = { state: one(sp['state']) ?? WAITING, ...Object.fromEntries(KEYS.map((k) => [k, one(sp[k])])) } as Record<string, string | undefined>;
  const list = await listManifests({ ...filters, sort: '-submitted_at' }).catch((e: unknown) => { if (e instanceof ApiError) return null; throw e; });
  return <ManifestInbox rows={list?.data ?? []} failed={list === null} filters={filters} />;
}
