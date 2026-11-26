import 'server-only';
// PHLEBO-UI-FULL-1: what the staff bell shows. Today the only source is phlebotomist applications waiting for review.
// Undefined = this person has no notification source (the bell then stays inert). A failed read gives an empty bell,
// never an error page.
import { listApplications } from './applications.server';

export type BellNotice = { id: string; title: string; detail?: string; href: string };

export async function bellNotices(permissions: readonly string[]): Promise<BellNotice[] | undefined> {
  if (!permissions.includes('homecollection.application.manage')) return undefined;
  try {
    const { rows } = await listApplications('submitted');
    return rows.slice(0, 20).map((a) => ({
      id: a.id,
      title: 'New phlebotomist application',
      detail: `${a.full_name} · ${a.area}`,
      href: '/homecollection/applications?status=submitted',
    }));
  } catch {
    return [];
  }
}
