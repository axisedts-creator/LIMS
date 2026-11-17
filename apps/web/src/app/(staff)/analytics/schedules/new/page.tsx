// S6 new schedule (C8 04-UI-UX §8). Permission analytics.schedule.manage is checked in scheduleEditorPage before any API call.
import { scheduleEditorPage } from '@/features/analytics/server/schedules-page';

export default async function NewSchedulePage() {
  return scheduleEditorPage();
}
