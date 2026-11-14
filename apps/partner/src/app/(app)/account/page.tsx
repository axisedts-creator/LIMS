// C13.T19 PX-1 Account — /account (04-UI-UX PX-1). A1 getPartnerContext only; a suspended partner (403 partners.partner_inactive) fails the read and gets the error state with no data.
import { getMe } from '@/features/common/api';
import { AccountView } from '@/features/account/AccountView';

export default async function AccountPage() {
  return <AccountView me={await getMe()} />;
}
