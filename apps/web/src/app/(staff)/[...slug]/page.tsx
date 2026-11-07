// Placeholder for staff routes whose owning module has not shipped its page yet (CR: .orchestra/cr/T0D-14.md).
// Module route segments (app/(staff)/<module>/…) take precedence over this catch-all.
import { notFound } from 'next/navigation';
import { navEntries } from '@/core/nav/generated';
import { getRequestPathname } from '@/core/session/server';
import { t } from '@/core/i18n/messages';

export default async function PendingModulePage() {
  const pathname = await getRequestPathname();
  const entry = navEntries.find((e) => e.path === pathname);
  if (!entry) notFound();
  return (
    <section data-testid="module-pending">
      <h1>{t(entry.label)}</h1>
    </section>
  );
}
