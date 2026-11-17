// S6 edit schedule + run log (C8 04-UI-UX §8). Permission first, then the id format (a malformed id is a 404 with no API call), then the API read.
import { scheduleEditorPage } from '@/features/analytics/server/schedules-page';

export default async function EditSchedulePage({ params }: { params: Promise<{ schedule_id: string }> }) {
  const { schedule_id } = await params;
  return scheduleEditorPage(schedule_id);
}
