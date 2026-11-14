// C13.T19 partner shell for every (app) screen (04-UI-UX §1.1; 03-APP-FLOW §6). Reads GET /v1/partners/me (A1) once per request.
// Suspended partner / inactive user (403 partners.partner_inactive) -> full-page ErrorState: no nav, no children. Upstream detail is never shown.
// LD-140 (2026-11-13): kit components only.
import type { ReactNode } from 'react';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { partnerApi } from '@/core/api';
import { PartnerShell } from '@/features/shell/PartnerShell';
import type { Me } from '@/features/common/types';
import './partner.css';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const r = await partnerApi<Me>('/v1/partners/me'); // session problems redirect inside partnerApi
  if (!r.ok || !r.data || !Array.isArray(r.data.permissions)) {
    const suspended = !r.ok && r.status === 403 && r.problem.code === 'partners.partner_inactive';
    return (
      <ErrorState
        title={suspended ? 'Your access to the portal is paused.' : 'Could not load your account.'}
        body={suspended ? 'Contact the lab to restore it.' : 'Try again in a moment.'}
      />
    );
  }
  return <PartnerShell me={r.data}>{children}</PartnerShell>;
}
