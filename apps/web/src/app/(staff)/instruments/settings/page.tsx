// SCR-11 Instrument settings — server component. 403 propagates to error.tsx; never rendered as a form.
// T0D-UNSLOP-1 (LD-353 rule 6): 501 operation_pending shows NotAvailable with the menu title (the form itself now carries the h1).
// T0D-UILIST-1 (LD-353 rule 6): a 500 keeps the title and shows ErrorState with reference and Retry (loadOr).
import { t } from '@/core/i18n/messages';
import { getShellSession } from '@/core/session/server';
import { loadOr } from '@/core/shell/NotAvailable';
import { InstrumentSettingsForm } from '@/features/instruments/components/InstrumentSettingsForm';
import { getInstrumentSettings } from '@/features/instruments/server/getInstrumentSettings.server';

export default async function InstrumentSettingsPage() {
  return loadOr(t('instruments.nav.settings'), undefined, async () => {
    const [session, settings] = await Promise.all([getShellSession(), getInstrumentSettings()]);
    return <InstrumentSettingsForm settings={settings} permissions={session?.actor.permissions ?? []} />;
  });
}
