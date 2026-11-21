// S18 Settings — server component (04-UI-UX §3 S18). Anyone with inventory.item.read sees the values; only inventory.master.manage gets the form.
// The store list is optional (soft): without it the default store shows as "—". LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { loadOr } from '@/core/shell/NotAvailable';
import { SettingsForm } from '@/features/inventory/components/SettingsForm';
import { FORBIDDEN, getSettings, guarded, listStores, soft } from '@/features/inventory/server/read.server';
import type { Page, Store } from '@/features/inventory/server/types';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await searchParams; // no query params on S18; awaited so Next treats the page as dynamic
  const session = await getShellSession();
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;
  // T0D-UILIST-3 / T0D-UISETTINGS-1, LD-353 rule 6: 501 -> NotAvailable, 5xx -> ErrorState in the page; both keep the title, never error.tsx.
  return loadOr('Settings', undefined, () => settingsPage(perms));
}

async function settingsPage(perms: readonly string[]) {
  const settings = await guarded(getSettings);
  if (settings === FORBIDDEN) return <PermissionDenied />;
  const stores = await soft(listStores, { data: [], page: { limit: 1 } } as Page<Store>);

  return (
    <SettingsForm
      key={settings.version}
      settings={settings}
      stores={stores.data.filter((x) => x.is_active).map((x) => ({ value: x.id, label: `${x.store_code} — ${x.name}` }))}
      canManage={perms.includes('inventory.master.manage')}
    />
  );
}
