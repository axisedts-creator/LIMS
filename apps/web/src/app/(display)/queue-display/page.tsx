// Queue display page (CR-C16-001): no staff shell, no session. States: Not paired / Connecting / Live / Stale (03-APP-FLOW §7.2).
import { readDisplayToken } from './pairing';
import { QueueDisplay } from './QueueDisplay';

export const dynamic = 'force-dynamic';

export default async function QueueDisplayPage() {
  const paired = (await readDisplayToken()) !== undefined;
  return <QueueDisplay initial={paired ? 'connecting' : 'unpaired'} />;
}
