// Reminder state machine (03-APP-FLOW §4.4; 05-SCHEMA reminders__status__ck). Pure.

export const REMINDER_STATUSES = ['scheduled', 'sent', 'suppressed', 'failed', 'cancelled'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

const NEXT: Readonly<Record<ReminderStatus, readonly ReminderStatus[]>> = {
  scheduled: ['sent', 'suppressed', 'failed', 'cancelled'],
  sent: [],
  suppressed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ReminderStatus, to: ReminderStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: ReminderStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
