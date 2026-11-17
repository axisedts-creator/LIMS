// W6 Queue console (C16 04-UI-UX W6). Permission engagement.queue.operate is checked in consolePage before any API call.
import { consolePage } from '@/features/engagement/server/queue-pages';

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return consolePage(searchParams);
}
