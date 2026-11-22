// Auto-verification overview (C9 04-UI-UX §2.7, route staff.quality.autoverify). The page renders inside the (staff) PageShell; its PageHeader (helpKey) lives in the view.
// quality.autoverify.read is checked in `gated` before any API call; a missing rule set (404, contract: "404 when none yet") is the empty state.
// T0D-BUILD-5 (LD-455 rule 3): every other failure is shown inside the page (kit ErrorState with the reference), never thrown to error.tsx. LD-140: kit components only.
import { LoadError } from '@/core/shell/LoadError';
import { OverviewView } from './_components/OverviewView';
import { PageNotice } from './_components/shared';
import { MANAGE, gated, getRuleSet, getSettings } from './_lib/server';

const TITLE = 'Auto-verification';

export default async function AutoverifyPage() {
  let r: Awaited<ReturnType<typeof load>>;
  try {
    r = await load();
  } catch (e) {
    const ref = (e as { problem?: { request_id?: unknown } } | null)?.problem?.request_id;
    return <LoadError title={TITLE} {...(typeof ref === 'string' && ref ? { requestId: ref } : {})} />;
  }
  if ('gate' in r) return <PageNotice kind={r.gate} title={TITLE} helpKey="quality.autoverify" />;
  return <OverviewView ruleSet={r.data.ruleSet} settings={r.data.settings} canManage={r.perms.includes(MANAGE)} />;
}

const load = () => gated(async () => {
  const [ruleSet, settings] = await Promise.all([getRuleSet(), getSettings()]);
  return { ruleSet, settings };
});
