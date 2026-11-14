// Auto-verification overview (C9 04-UI-UX §2.7, route staff.quality.autoverify). The page renders inside the (staff) PageShell; its PageHeader (helpKey) lives in the view.
// quality.autoverify.read is checked in `gated` before any API call; a missing rule set (404) is a normal state, anything else rejects to error.tsx. LD-140: kit components only.
import { OverviewView } from './_components/OverviewView';
import { PageNotice } from './_components/shared';
import { MANAGE, gated, getRuleSet, getSettings } from './_lib/server';

export default async function AutoverifyPage() {
  const r = await gated(async () => {
    const [ruleSet, settings] = await Promise.all([getRuleSet(), getSettings()]);
    return { ruleSet, settings };
  });
  if ('gate' in r) return <PageNotice kind={r.gate} title="Auto-verification" helpKey="quality.autoverify" />;
  return <OverviewView ruleSet={r.data.ruleSet} settings={r.data.settings} canManage={r.perms.includes(MANAGE)} />;
}
