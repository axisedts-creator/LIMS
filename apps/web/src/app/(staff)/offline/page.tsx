// T0D-OFFLINE-2 (LD-322; route staff.offline, permission sync.use): the Offline panel and the conflict inbox. Everything it shows lives
// on this device (encrypted IndexedDB), so the page is a client screen fed by the OfflineProvider of the staff layout.
import { t } from '@/core/i18n/messages';
import { OfflinePanel } from '@/core/offline/ui/OfflinePanel';

export const metadata = { title: t('offline.title') };

export default function OfflinePage() {
  return <OfflinePanel />;
}
