// W7 Queue setup (C16 04-UI-UX W7). Permission engagement.queue.manage is checked in setupPage before any API call.
import { setupPage } from '@/features/engagement/server/queue-pages';

export default async function QueueSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return setupPage(searchParams);
}
