// /lab/settings (04-UI-UX §1 nav row lab.config.manage, CR-C5-004; §3.13). A session without lab.config.manage gets notFound() (S-15: the nav hides the entry, a direct URL renders nothing).
// The page reads no lab data itself — the client component does — so a failing API never crashes the route.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { LabSettingsPage } from '@/features/lab/components/settings/LabSettingsPage';

export const metadata = { title: 'Lab settings' };

export default async function Page() {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('lab.config.manage')) notFound();
  return <LabSettingsPage permissions={permissions} />;
}
