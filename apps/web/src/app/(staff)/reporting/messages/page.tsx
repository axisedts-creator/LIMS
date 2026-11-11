// 04-UI-UX §2.7 Messages & channels (staff.reporting.messages). Channel accounts hold a secret REFERENCE only.
import { MessagesChannels } from '@/features/reporting/components/MessagesChannels';
import { gate } from '@/features/reporting/server/gate.server';
import { listChannelAccounts, listMessageTemplates } from '@/features/reporting/server/read.server';

export default async function MessagesPage() {
  return gate('reporting.message_template.manage', async (permissions) => {
    const [templates, accounts] = await Promise.all([listMessageTemplates(), listChannelAccounts()]);
    return <MessagesChannels templates={templates.data} accounts={accounts.data} permissions={permissions} productionMode={process.env.NODE_ENV === 'production'} />;
  });
}
