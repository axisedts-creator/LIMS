// W9 Reminders (04-UI-UX §3 W9). R1 listReminders with a validated range (always due_from + due_to, ≤ 92 days). R4 follow-up suggestions panel: not built (T-P4 missing).
import 'server-only';
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { searchPatientsAction } from './actions';
import { listReminders, remindersQuery } from './reminders.server';
import { RemindersView, type ReasonOption } from './RemindersView';

type SP = Record<string, string | string[] | undefined>;

// engagement.g_cs_reminder_reasons seed (05-SCHEMA §seed) [CONV]: no coded-set read route exists in the C16 API yet.
const REASONS: readonly ReasonOption[] = [
  { code: 'follow_up_test', display: 'Follow-up test', isActive: true },
  { code: 'repeat_test', display: 'Repeat test', isActive: true },
  { code: 'booking', display: 'Appointment', isActive: true },
  { code: 'other', display: 'Other', isActive: true },
];

export default async function RemindersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('engagement.reminder.read')) notFound();
  const q = remindersQuery(await searchParams);
  const res = await listReminders(q);
  const reminders = (Array.isArray(res?.data) ? res.data : []).slice(0, 50).map((r) => ({ ...r, patient_display: r.patient_display ?? `Patient …${r.patient_id.slice(-6)}` }));
  const next = res?.page?.next_cursor;
  return (
    <RemindersView
      reminders={reminders} permissions={permissions} reasons={REASONS} searchPatients={searchPatientsAction}
      hasPrevious={q.has('cursor')} {...(next ? { nextCursor: next } : {})}
    />
  );
}
