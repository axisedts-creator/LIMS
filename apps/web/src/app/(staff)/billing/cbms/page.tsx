// 04-UI-UX §8.9 CBMS. No API exposes the client mode yet and only the stub client exists (CR .orchestra/cr/BL-T20.md), so the mode is 'stub'.
import { getShellSession } from '@/core/session/server';
import { CbmsList } from '@/features/billing/components/CbmsList';
import { listCbmsDocuments } from '@/features/billing/server/read.server';

export default async function CbmsPage() {
  const [session, { data }] = await Promise.all([getShellSession(), listCbmsDocuments({ limit: 100 })]);
  return <CbmsList documents={data} mode="stub" permissions={session?.actor.permissions ?? []} />;
}
