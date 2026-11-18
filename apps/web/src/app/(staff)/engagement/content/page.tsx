// T0D-CONTENT-1 Portal content (route staff.engagement.content, LD-313): News, Banners, Offers, Contact Us and Profile Images as tabs of ONE page.
// Without engagement.content.read the screen shows its permission state and no API call is made. Page title = the menu label (LD-340).
import { t } from '@/core/i18n/messages';
import { PortalContentScreen } from '@/features/engagement/components/content/PortalContentScreen';
import { listPortalContent, listProfileImages, PERM, sessionPermissions } from '@/features/engagement/server/content.server';
import { searchProfilesAction } from '@/features/engagement/server/content-actions';

export const metadata = { title: t('engagement.content.page.title') };

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date()); // tenant local date [CONV]

export default async function PortalContentPage() {
  const permissions = await sessionPermissions();
  const canRead = permissions.includes(PERM.read);
  const [items, profileImages] = canRead ? await Promise.all([listPortalContent(), listProfileImages()]) : [[], []];
  return <PortalContentScreen items={items} profileImages={profileImages} permissions={permissions} today={today()} searchProfiles={searchProfilesAction} />;
}
