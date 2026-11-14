// SCR-11 Instrument settings — server component. E40 failures (403/500) propagate to error.tsx; never rendered as a form.
import { getShellSession } from '@/core/session/server';
import { InstrumentSettingsForm } from '@/features/instruments/components/InstrumentSettingsForm';
import { getInstrumentSettings } from '@/features/instruments/server/getInstrumentSettings.server';

export default async function InstrumentSettingsPage() {
  const [session, settings] = await Promise.all([getShellSession(), getInstrumentSettings()]);
  return <InstrumentSettingsForm settings={settings} permissions={session?.actor.permissions ?? []} />;
}
