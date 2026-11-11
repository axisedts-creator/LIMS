// SCR worksheets list (04-UI-UX §1 nav row "Worksheets").
import { getShellSession } from '@/core/session/server';
import { WorksheetListPage } from '@/features/lab/components/worksheets/WorksheetListPage';

export default async function Page() {
  const session = await getShellSession();
  return <WorksheetListPage permissions={session?.actor.permissions ?? []} />;
}
