'use client';
// 04-UI-UX §5 states of the referral report: MFA required (warning banner + "Verify now") and flag off (full-page EmptyState, no further detail).
import { Banner } from '@lims/ui/components/Banner';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';

export function ReferralState({ kind }: { kind: 'mfa' | 'disabled' }) {
  return (
    <>
      <PageHeader title="Referral business report" helpKey="analytics.reports.referral-incentive" />
      {kind === 'mfa' ? (
        // ponytail: no C2 step-up route is known (same as ExportDialog); reload lets the session guard redirect to it
        <Banner tone="warning" title="Verify with your authenticator app to open this report." action={{ label: 'Verify now', onPress: () => window.location.reload() }} />
      ) : (
        <EmptyState title="This report is not enabled for your lab." />
      )}
    </>
  );
}
