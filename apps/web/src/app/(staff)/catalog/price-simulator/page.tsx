// SCR-15 Price simulator — no data to load; the component hides itself without catalog.price_list.read.
import { getShellSession } from '@/core/session/server';
import { PriceSimulator } from '@/features/catalog/components/PriceSimulator';

export default async function PriceSimulatorPage() {
  const session = await getShellSession();
  return <PriceSimulator permissions={session?.actor.permissions ?? []} />;
}
