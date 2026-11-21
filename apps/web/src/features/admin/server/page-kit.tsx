// Server helpers shared by the admin pages: gate, load-or-error, page frame.
import 'server-only';
import type { ReactNode } from 'react';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import type { Fail } from './api';
import { permissions } from './api';

/** Returns the actor's permissions when `perm` is held, otherwise null (render <Denied/>, make no API call). */
export async function gate(perm: string): Promise<Set<string> | null> {
  const p = await permissions();
  return p.has(perm) ? p : null;
}
export const Denied = PermissionDenied;

export function LoadError({ fail, what }: { fail: Fail; what: string }) {
  return (
    <ErrorState title={`Could not load ${what}`} body="Try again; if it keeps failing, contact support with the reference." {...(fail.requestId ? { requestId: fail.requestId } : {})} />
  );
}

/** T0D-UIGUARD-1-ADMIN (LD-436 R16): a failed read of a screen that draws its own header still keeps the page title row. */
export function FailedPage({ title, helpKey, fail, what }: { title: string; helpKey: string; fail: Fail; what: string }) {
  return <Frame title={title} helpKey={helpKey}><LoadError fail={fail} what={what} /></Frame>;
}

/** T0D-UIGUARD-1-ADMIN (LD-436 title row, LD-439): the heading is the kit PageHeader (title, one caption line, actions, help). */
export function Frame({ title, caption, actions, helpKey, children }: { title: string; caption?: string; actions?: ReactNode; helpKey: string; children: ReactNode }) {
  return (
    <main className="lims-page">
      <PageHeader title={title} helpKey={helpKey} {...(caption ? { caption } : {})} {...(actions ? { actions } : {})} />
      {children}
    </main>
  );
}
