// 04-UI-UX §3.2 (route /lab/collect). The screen's data comes from scans, so the page makes no API call.
import { getShellSession } from '@/core/session/server';
import { CollectDispatch } from '@/features/lab/components/CollectDispatch';

export const metadata = { title: 'Collect & dispatch' };

export default async function CollectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session] = await Promise.all([getShellSession(), searchParams]);
  return <CollectDispatch permissions={session?.actor.permissions ?? []} />;
}
