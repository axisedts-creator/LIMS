// FD-T12 names (DB-free, so the static test can import them without LIMS_TEST_* env): event types, consumer file / export names (02-TRD §3.3) and the literal-specifier loaders.
// Literal specifiers only: vite cannot resolve a variable dynamic import. An import failure here = the task is not implemented yet.
export const TYPES = {
  rejected: 'lab.specimen.rejected.v1', changed: 'lab.specimen.status_changed.v1', catalog: 'catalog.changed.v1',
  confirmed: 'engagement.booking.confirmed.v1', cancelled: 'engagement.booking.cancelled.v1',
} as const;
const LOADERS = {
  rejected: () => import('../../../../../../worker/src/jobs/frontdesk/consumers/lab.specimen.rejected.v1.js'),
  changed: () => import('../../../../../../worker/src/jobs/frontdesk/consumers/lab.specimen.status_changed.v1.js'),
  catalog: () => import('../../../../../../worker/src/jobs/frontdesk/consumers/catalog.changed.v1.js'),
  confirmed: () => import('../../../../../../worker/src/jobs/frontdesk/consumers/engagement.booking.confirmed.v1.js'),
  cancelled: () => import('../../../../../../worker/src/jobs/frontdesk/consumers/engagement.booking.cancelled.v1.js'),
} as const;
export type Kind = keyof typeof LOADERS;
export const FILE_OF: Record<Kind, string> = { rejected: 'lab.specimen.rejected.v1', changed: 'lab.specimen.status_changed.v1', catalog: 'catalog.changed.v1', confirmed: 'engagement.booking.confirmed.v1', cancelled: 'engagement.booking.cancelled.v1' };
export const EXPORT_OF: Record<Kind, string> = { rejected: 'onSpecimenRejected', changed: 'onSpecimenStatusChanged', catalog: 'onCatalogChanged', confirmed: 'onBookingConfirmed', cancelled: 'onBookingCancelled' };

/** The production handler for `kind`, imported from its file. */
export async function handlerOf(kind: Kind): Promise<(env: unknown, ctx: unknown) => Promise<void>> {
  const mod: any = await LOADERS[kind]();
  if (typeof mod[EXPORT_OF[kind]] !== 'function') throw new Error(`${FILE_OF[kind]}.ts must export ${EXPORT_OF[kind]}`);
  return mod[EXPORT_OF[kind]];
}
