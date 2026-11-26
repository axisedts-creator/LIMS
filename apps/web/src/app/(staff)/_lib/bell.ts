import 'server-only';
// PHLEBO-UI-FULL-1: the (staff) layout reads the bell items through this route-level file, so the shell sources and the layout
// keep importing no feature module (r04 REQ-ARCH-076 guard); same pattern as quality/_lib/nav-badge.ts.
export { bellNotices } from '@/features/homecollection/server/bell.server';
