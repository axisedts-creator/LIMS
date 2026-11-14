# HC-T27 impl (writer)
Files (apps/phlebo_app/lib/features/): route/{domain/route_models,ui/route_screen}, handover/{domain/handover_models,ui/handover_screen}, settings/{domain/sign_out,ui/settings_screen}, outbox/{domain/outbox_row,sync_summary,time_labels; ui/outbox_screen,status_pill}; outbox/data/outbox_repository.dart gains listRows() + pendingCount().
Results: 73/74 HC-T27 tests pass; whole `__tests__` 458 pass, 1 fail = the disputed pull-to-refresh test (see HC-T27-dispute.md). `flutter analyze lib` clean.
[CONV] LD-140: every screen = LimsSecureScreen + LimsScaffold, lims_ui widgets and tokens only; status = tone + icon + word via StatusPill; one primary button per screen.
[CONV] Handover: ONE `handover.recorded` per tap via MutationSink, visit_id null, ids only; handover_id is created once per screen so a retry after a failed save reuses it; more than 50 ticked tubes disables the button.
[CONV] Cancelled visit tap shows an InlineNotice (not a snackbar); sign-out stays disabled after success until the shell navigates away.
Open: routes/shell wiring (router.dart, providers feeding listRows/pendingCount, the real signOut) is outside HC-T27's owned paths. Help text screen is only the `onHelp` callback.
