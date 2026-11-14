'use client';
// C16.T-L1 client host: binds W8 to the server actions. Nothing here holds a token; every call goes through the BFF.
import { useMemo, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { ToastProvider } from '@lims/ui/components/Toast';
import * as act from '../server/link-actions';
import { AppAccess, type AppAccessActions } from './AppAccess';

function unwrap<T>(r: act.ActionResult<T>): T {
  if (r.ok) return r.data;
  throw Object.assign(new Error(r.code), { problem: { code: r.code } });
}

export function AppAccessHost(props: Omit<ComponentProps<typeof AppAccess>, 'actions'>) {
  const router = useRouter();
  const actions = useMemo<AppAccessActions>(() => ({
    issue: async (body) => unwrap(await act.issueLinkCodeAction(body)),
    // ponytail: AppLink carries no version yet (open point / CR); "1" until L3 exposes it.
    revokeLink: async (l, body) => unwrap(await act.revokeAppLinkAction(l.link_id, l.version ?? 1, body)),
    revokeCode: async (c) => unwrap(await act.revokeLinkCodeAction(c.link_code_id)),
    refresh: async () => { router.refresh(); },
  }), [router]);
  return <ToastProvider><AppAccess {...props} actions={actions} /></ToastProvider>;
}
