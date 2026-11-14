// Levey-Jennings chart (C9 04-UI-UX §2.4). Permission quality.qc_run.read is checked in ljPage before any API call.
import { ljPage } from '@/features/quality/server/pages';

export default async function QcLjPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return ljPage(await searchParams);
}
