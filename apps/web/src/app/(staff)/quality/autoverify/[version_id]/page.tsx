// Version editor (C9 04-UI-UX §2.8, route staff.quality.autoverify_version). Permission and the id shape are checked before any API call; a version of another lab answers 404 -> notFound().
// The simulation report is read only for simulating / stopped versions (opening it writes the access-log entry on the API side); #51 is read only when the activation minimums are needed.
import { notFound } from 'next/navigation';
import { PageNotice } from '../_components/shared';
import { VersionView } from '../_components/VersionView';
import { MANAGE, gated, getReport, getSettings, getVersion, isNotFound } from '../_lib/server';
import { UUID } from '../_lib/format';

export default async function VersionPage({ params }: { params: Promise<{ version_id?: string }> }) {
  const id = (await params).version_id ?? '';
  const r = await gated(async (perms) => {
    if (!UUID.test(id)) notFound(); // malformed id: no API call
    const version = await getVersion(id).catch((e: unknown) => (isNotFound(e) ? notFound() : Promise.reject(e)));
    const withReport = version.status === 'simulating' || version.status === 'stopped';
    const [report, settings] = await Promise.all([withReport ? getReport(id) : undefined, version.status === 'simulating' ? getSettings() : undefined]);
    return { version, report, settings, canManage: perms.includes(MANAGE) };
  });
  if ('gate' in r) return <PageNotice kind={r.gate} title="Auto-verification version" helpKey="quality.autoverify_version" />;
  return <VersionView {...r.data} />;
}
