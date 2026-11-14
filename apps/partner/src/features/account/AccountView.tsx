'use client';
// C13.T19 PX-1 Account (04-UI-UX PX-1). Name, e-mail, role, organisation; two-step sign-in state; Sign out. No token, session id or cookie value is ever rendered.
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import Link from 'next/link';
import { Button } from '@lims/ui/components/Button';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { logoutAction } from '@/app/(auth)/auth/actions';
import type { Me } from '../common/types';

export function AccountView({ me }: { me: Me }) {
  const admin = me.user.partner_role === 'partner_admin';
  return (
    <>
      <PageHeader title="Account" helpKey="partners.account" />
      <Stack gap={4}>
        <DescriptionList
          items={[
            { term: 'Name', value: me.user.display_name },
            { term: 'Email', value: '—' }, // [CONV] PartnerContext carries no e-mail (spec gap, see impl note)
            { term: 'Role', value: admin ? 'Admin' : 'Member' },
            { term: 'Organisation', value: me.partner.name },
          ]}
        />
        <section aria-label="Two-step sign-in">
          <h2>Two-step sign-in</h2>
          {me.user.mfa_enrolled ? (
            <>
              <p>On</p>
              <Button isDisabled>Remove two-step sign-in</Button>
            </>
          ) : (
            <>
              <p>Off</p>
              <Link className="lims-btn lims-btn-secondary lims-btn-md" href="/auth/mfa/enrol">Set up two-step sign-in</Link>
            </>
          )}
        </section>
        <div className="partner-card-actions">
          <Button onPress={() => void logoutAction()}>Sign out</Button>
          <Button isDisabled>Sign out of all devices</Button>
        </div>
      </Stack>
    </>
  );
}
