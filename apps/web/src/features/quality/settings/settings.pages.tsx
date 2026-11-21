import 'server-only';
// C9 T-24 page composer (server component): permission -> API (#51 settings, #53 both coded sets) -> plain-JSON props for the client view.
// Reading needs quality.qc_run.read; the write buttons need quality.config.manage (the API decides). LD-140: no markup of its own. helpKey: quality.settings.
import { serverFetch } from '@/core/api/server-fetch';
import { loadOr } from '@/core/shell/NotAvailable';
import { QualityNotice } from '../components/Shared';
import { gated } from '../server/quality.server';
import type { QualityCode, QualitySettings } from '../types';
import { SettingsView } from './SettingsView';
import { CODED_SETS, MANAGE_CONFIG, type CodedSetName } from './validate';

const codes = async (set: CodedSetName) => {
  const r = await serverFetch<{ data?: QualityCode[] }>(`/v1/quality/coded-sets/${set}`);
  return Array.isArray(r?.data) ? r.data : [];
};

// T0D-UISETTINGS-1 (LD-353 rule 6): 501 operation_pending → NotAvailable, 5xx → ErrorState in the page (title, reference, Retry).
export function settingsPage() {
  return loadOr('Quality settings', undefined, async () => {
    const r = await gated(async () => {
      const [settings, corrective_actions, exclusion_reasons] = await Promise.all([serverFetch<QualitySettings>('/v1/quality/settings'), codes(CODED_SETS[0].id), codes(CODED_SETS[1].id)]);
      return { settings, sets: { corrective_actions, exclusion_reasons } };
    });
    if ('gate' in r) return <QualityNotice kind={r.gate} title="Quality settings" helpKey="quality.settings" />;
    // the version in the key: after a save (router.refresh) the form restarts from the stored values
    return <SettingsView key={r.data.settings.version} settings={r.data.settings} sets={r.data.sets} canManage={r.perms.includes(MANAGE_CONFIG)} />;
  });
}
