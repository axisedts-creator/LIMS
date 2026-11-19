# T0D-UNSLOP-1 error routes and causes (writer)
UI fix for every 501 route: `pendingOr` / `isPending` / `NotAvailable` in apps/web/src/core/shell/NotAvailable.tsx (LD-353 rule 6). Only 501 `operation_pending` is calm; every other failure still throws to error.tsx (guard tests).

| Route | Cause found in code | UI fix |
|---|---|---|
| /inventory | alerts / unresolved facts / settings reads in one `guarded(Promise.all)`; a 501 threw past `guarded` (403 only) | page wrapped in pendingOr (title Inventory) |
| /inventory/alerts | `listAlerts` 501 threw. T0B-SWEEP-2 saw 500 common.internal on live: a real API fault, still error.tsx (API side, not UI) | pendingOr + header row |
| /catalog/tests | `listAllTests` 501 threw through `orForbidden` (403 only) | pendingOr around every view, header row |
| /catalog/comment-codes | `listCommentCodes` 501 threw through `orForbidden` | pendingOr + header row |
| /frontdesk/settings | `getFrontdeskSettings` 501 rethrown (only 403 handled). T0B-SWEEP-2 saw 500 common.internal: real API fault, stays error.tsx | 501 branch -> NotAvailable |
| /smartreport/summaries | `listSummaries` failure rethrown | 501 -> NotAvailable + header row |
| /instruments/agents | `listAgents` unguarded | pendingOr + header row |
| /instruments/instruments | `listInstruments` unguarded | pendingOr + header row |
| /instruments/settings | `getInstrumentSettings` unguarded; page had NO h1 | PageHeader "Settings" added; pendingOr |
| /engagement/queue | queue/counter/token reads unguarded; a pending centres read became "No centre is available" | `resolveCentre` rethrows 501; consolePage/setupPage wrapped |
| /engagement/bookings | bookings read unguarded (only 403 feature_disabled handled) | bookingsPage, bookingNewPage, slotsPage wrapped |
| /inventory/bench | page checks `inventory.bench.record`; contracts/permissions.yaml:210 grants it to lab_technologist, lab_manager only, so a tenant admin gets PermissionDenied. ADMIN PACK BUG, not changed here (no permission widening) | none (notes only) |
| /admin/me | "Could not load your account": rs-c2 pinned admin screen, not edited | none (notes only, rs-c2) |

Admin screens (rs-c2, features/admin): not edited and not walked in a browser by this writer; their alignment findings stay with the lead's LD-344 walk.
