import 'server-only';
// T0D-BUILD-5 (LD-455): the (staff) layout reads the Quality nav badge through this route-level file, so the shell sources and the layout
// keep importing no feature module (r04 REQ-ARCH-076 guard); pages under app/ import their features the same way.
export { getTatAlertBadge } from '@/features/quality/server/tat-badge';
