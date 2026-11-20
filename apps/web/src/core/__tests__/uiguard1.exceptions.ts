// T0D-UIGUARD-1 exceptions registry (tester-owned). A page that CANNOT follow a rule is listed here by route with the reason (LD-353).
// Every entry must also be written in notes/T0D-UIGUARD-1-exceptions.md as one line holding the route and "rule N" (checked by uiguard1.guard.test.ts).
// A feature may add its own entries in apps/web/src/features/<feature>/__tests__/uiguard1.exceptions.ts (export const EXCEPTIONS: GuardException[]).
// An entry whose page no longer breaks the rule is stale and fails the guard: delete it. Reasons must name a real obstacle (see the REAL list in the guard test).
import type { GuardException } from './uiguard1.helpers';

export const EXCEPTIONS: GuardException[] = [
  // Pinned by rs-c2.static: the admin screens draw their heading through features/admin/server/page-kit Frame (a bare h1), which may not be edited.
  { route: '/admin/*', rule: 1, reason: 'pinned: heading comes from features/admin/server/page-kit Frame (rs-c2.static pins features/admin); only shared kit fixes apply' },
  // The registration entry form (template 6) keeps its bold totals and its line table that swaps for a hint; its CSS is shared with the order view.
  { route: '/frontdesk/registrations/new', rule: 3, reason: 'registration entry form: frontdesk.css bold totals and registration number (template 6)' },
  { route: '/frontdesk/registrations/new', rule: 5, reason: 'registration entry form: the test line grid is an entry grid, not a list (template 6)' },
  { route: '/frontdesk/orders/[order_id]', rule: 3, reason: 'registration entry form: shares frontdesk.css with the registration entry form' },
  // The printed label sheet is a physical sticker layout, not a screen.
  { route: '/anatomic/cases/[case_id]/labels', rule: 3, reason: 'label sheet: print layout of a physical label (label-sheet.css) needs a bold first line' },
  // The placeholder served for a menu entry whose module has not shipped a page; it is not a screen and no nav entry resolves to it (guarded above).
  { route: '/[...slug]', rule: 1, reason: 'catch-all placeholder for module routes without a page; not a screen (CR T0D-14)' },
];
