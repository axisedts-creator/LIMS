import 'server-only';
// C9 T-24 page composer (server component): permission -> whitelisted query -> API -> plain-JSON props for the client view.
// LD-140: no markup of its own; the view uses @lims/ui only. helpKey of the screen is quality.tat_alerts (help/tat_alerts.md).
import { QualityNotice } from '../components/Shared';
import { gated } from '../server/quality.server';
import { TatView } from './TatView';
import { TAT_ACK, TAT_READ, getTatAlerts, tatQuery } from './tat.server';

export async function tatAlertsPage(sp: Record<string, string | string[] | undefined>) {
  const q = tatQuery(sp);
  const r = await gated(() => getTatAlerts(q), TAT_READ);
  if ('gate' in r) return <QualityNotice kind={r.gate} title="TAT alerts" helpKey="quality.tat_alerts" />;
  const clean = Object.fromEntries([...q].filter(([k]) => k !== 'limit' && k !== 'sort'));
  return <TatView key={JSON.stringify(clean)} page={r.data} generatedAt={new Date().toISOString()} sp={clean} canAck={r.perms.includes(TAT_ACK)} />;
}
