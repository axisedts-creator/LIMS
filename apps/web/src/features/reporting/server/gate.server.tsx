import 'server-only';
// Page-level guard (defence in depth): the staff layout only gates routes that have a routes.yaml row, so every reporting page also checks its
// own permission BEFORE any API call. API 403 → PermissionDenied; API 404/400 (unknown or malformed id) → notFound(); anything else rethrows to error.tsx.
import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';

export async function gate(permission: string, render: (permissions: readonly string[]) => Promise<ReactElement>): Promise<ReactElement> {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes(permission)) return <PermissionDenied />;
  try {
    return await render(permissions);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 403) return <PermissionDenied />;
      if (e.status === 404 || e.status === 400) notFound();
    }
    throw e;
  }
}

/** First value of a Next searchParams entry. */
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
