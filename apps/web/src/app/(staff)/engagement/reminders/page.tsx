// W9 Reminders (04-UI-UX §3 W9). R1 listReminders with a validated range (always due_from + due_to, ≤ 92 days). R4 follow-up suggestions panel: not built (T-P4 missing).
import 'server-only';
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { searchPatientsAction } from './actions';
import { kindFilter, listReminderReasons, listReminders, remindersQuery } from './reminders.server';
import { RemindersView } from './RemindersView';

type SP = Record<string, string | string[] | undefined>;

export default async function RemindersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('engagement.reminder.read')) notFound();
  const sp = await searchParams;
  const q = remindersQuery(sp);
  const kind = kindFilter(sp);
  const [res, reasons] = await Promise.all([listReminders(q), listReminderReasons()]);
  // [CONV] R1 has no `kind` param (CR .orchestra/cr/T-R2.md): filter the returned page by kind.
  const reminders = (Array.isArray(res?.data) ? res.data : []).slice(0, 50)
    .filter((r) => !kind || r.kind === kind)
    .map((r) => ({ ...r, patient_display: r.patient_display ?? `Patient …${r.patient_id.slice(-6)}` }));
  const next = res?.page?.next_cursor;
  return (
    <RemindersView
      reminders={reminders} permissions={permissions} reasons={reasons} searchPatients={searchPatientsAction}
      hasPrevious={q.has('cursor')} {...(next ? { nextCursor: next } : {})}
    />
  );
}
