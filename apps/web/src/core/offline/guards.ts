// T0D-OFFLINE-3 (LD-322; offline design operation catalogue; done_when 4): actions the design classes as online only.
// Offline they are disabled with a visible reason from the message catalogue. Pure; the hook lives in ui/OfflineProvider.tsx.
import { t } from '../i18n/messages';

export const ONLINE_ONLY_ACTIONS = ['order.cancel', 'order.refund', 'payment.online', 'message.sms', 'message.whatsapp', 'price_list.change', 'master.change'] as const;
export type OnlineOnlyAction = (typeof ONLINE_ONLY_ACTIONS)[number];

/** null when allowed (online), else the sentence shown next to the disabled control */
export const onlineOnlyReason = (action: OnlineOnlyAction, online: boolean): string | null => (online ? null : t(`offline.online_only.${action}`));
