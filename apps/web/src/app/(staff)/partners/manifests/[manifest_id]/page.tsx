// SM-2 Receive manifest (04-UI-UX §4). Unknown id, another receiving centre and another tenant all answer 404 -> not-found; 5xx propagates to error.tsx.
// Without partners.manifest.receive the API is not asked at all.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { getManifest } from '@/features/partners/server/read.server';
import { UUID_RE } from '@/features/partners/server/types';
import { ManifestReceive } from '@/features/partners/components/ManifestReceive';
import { PermissionNotice } from '@/features/partners/components/common';

export const metadata = { title: 'Receive manifest' };

export default async function ManifestPage({ params }: { params: Promise<{ manifest_id: string }> }) {
  const [{ manifest_id }, session] = await Promise.all([params, getShellSession()]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('partners.manifest.receive')) return <PermissionNotice />;
  if (!UUID_RE.test(manifest_id)) notFound();
  const manifest = await getManifest(manifest_id).catch((e: unknown) => {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  });
  return <ManifestReceive manifest={manifest} permissions={perms} />;
}
