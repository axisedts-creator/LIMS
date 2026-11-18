'use client';
// T0D-CONTENT-1 Portal content (LD-313 portal content in the engagement module; LD-310 blanket authority; LD-353 template 1 LIST, compact):
// tabs News, Banners, Offers, Contact Us, Profile Images on ONE route. Reads need engagement.content.read (else a permission state and no
// API call), writes engagement.content.manage, image upload identity.settings.manage (the branding route). Text from the message catalogue.
import { useEffect, useState } from 'react';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { t } from '@/core/i18n/messages';
import { ContactForm } from './ContactForm';
import { ContentList, byOrder, type ListKind } from './ContentList';
import { ProfileImages, type SearchProfiles } from './ProfileImages';
import type { PortalContent, ProfileImage } from './content-model';

export interface PortalContentScreenProps {
  items: readonly PortalContent[];
  profileImages: readonly ProfileImage[];
  permissions: readonly string[];
  /** Tenant local date, YYYY-MM-DD. */
  today: string;
  searchProfiles: SearchProfiles;
}

type TabId = ListKind | 'contact' | 'profile';
const TABS: readonly TabId[] = ['news', 'banner', 'offer', 'contact', 'profile'];
const LISTS: readonly TabId[] = ['news', 'banner', 'offer'];

export function PortalContentScreen({ items: initial, profileImages, permissions, today, searchProfiles }: PortalContentScreenProps) {
  const canRead = permissions.includes('engagement.content.read');
  const canManage = canRead && permissions.includes('engagement.content.manage');
  const canUpload = canManage && permissions.includes('identity.settings.manage');
  const [items, setItems] = useState<PortalContent[]>(() => [...initial]);
  useEffect(() => setItems([...initial]), [initial]); // fresh rows (new versions) after router.refresh()
  const [tab, setTab] = useState<TabId>('news');
  const header = <PageHeader title={t('engagement.content.page.title')} helpKey="engagement.content" />;

  if (!canRead) {
    return (
      <div className="lims-stack">
        {header}
        <div className="lims-state" data-testid="permission-denied" role="status">
          <p className="lims-state-title">{t('engagement.content.state.denied')}</p>
        </div>
      </div>
    );
  }

  const contact = items.filter((i) => i.kind === 'contact').sort(byOrder)[0];
  const put = (p: PortalContent) => setItems((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]));
  return (
    <section className="lims-stack" aria-label={t('engagement.content.page.title')}>
      {header}
      {!canManage ? <p className="lims-description">{t('engagement.content.state.read_only')}</p> : null}
      <Tabs aria-label={t('engagement.content.page.title')} items={TABS.map((id) => ({ id, label: t(`engagement.content.tab.${id}`) }))} selectedId={tab} onChange={(id) => setTab(id as TabId)}>
        {LISTS.includes(tab) ? (
          <ContentList key={tab} kind={tab as ListKind} items={items} canManage={canManage} canUpload={canUpload} today={today} setItems={setItems} />
        ) : tab === 'contact' ? (
          <ContactForm item={contact} canManage={canManage} onSaved={put} />
        ) : (
          <ProfileImages images={profileImages} canManage={canManage} canUpload={canUpload} searchProfiles={searchProfiles} />
        )}
      </Tabs>
    </section>
  );
}
