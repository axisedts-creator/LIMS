// 04-UI-UX §3 — server component; data through the BFF server functions only (02-CONVENTIONS §2.4).
import { getShellSession } from '@/core/session/server';
import { RegistrationForm } from '@/features/frontdesk/components/RegistrationForm';
import { listCentres } from '@/features/frontdesk/server/read.server';
import { getFrontdeskSettings } from '@/features/frontdesk/settings/server';

export default async function NewRegistrationPage() {
  const session = await getShellSession();
  // Centres in scope come from identity; if the read is refused the form shows "no centre available" instead of failing the page.
  const [centres, settings] = await Promise.all([
    listCentres().catch(() => []),
    getFrontdeskSettings().catch(() => undefined),
  ]);
  return (
    <RegistrationForm
      centres={centres}
      permissions={session?.actor.permissions ?? []}
      defaultCentreId={centres[0]?.id}
      consentTextVersion={settings?.consent_text_version}
    />
  );
}

