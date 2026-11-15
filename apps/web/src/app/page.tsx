// GET / (LD-224, audit RS-08): redirect only, no copy, no styling. Resolves the session the way the shell does.
// platform -> /platform; tenant staff -> first nav entry (nav order) whose permission the actor holds; otherwise sign-in.
import { redirect } from 'next/navigation';
import { navEntries } from '@/core/nav/generated';
import { hasPermission } from '@/core/permissions/routes';
import { getShellSession } from '@/core/session/server';

export const dynamic = 'force-dynamic';

export default async function RootPage(): Promise<never> {
  const s = await getShellSession();
  if (s?.kind === 'platform') redirect('/platform');
  if (s?.kind === 'tenant_staff') {
    const first = navEntries.find((e) => hasPermission(s.actor.permissions, e.permission));
    if (first) redirect(first.path);
  }
  redirect('/auth/login');
}
