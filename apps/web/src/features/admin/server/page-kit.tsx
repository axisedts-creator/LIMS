// Server helpers shared by the admin pages: gate, load-or-error, page frame.
import 'server-only';
import type { ReactNode } from 'react';
import { ErrorState } from '@lims/ui/components/ErrorState';
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

export function Frame({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="lims-page">
      <header className="lims-page-header">
        <h1>{title}</h1>
        {actions ? <div className="lims-page-actions">{actions}</div> : null}
      </header>
      {children}
    </main>
  );
}
