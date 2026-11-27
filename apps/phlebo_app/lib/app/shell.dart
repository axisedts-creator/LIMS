// PHLEBO-UI-FULL-1: connects the screens to AppController. PhaseGate covers the app while signed out, locked or the
// phone cannot be used; HomeShell is the floating tab bar; VisitHost runs one visit.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_ui/lims_ui.dart';

import '../features/handover/ui/handover_receipt_screen.dart';
import '../features/handover/ui/handover_screen.dart';
import '../features/help/ui/help_screens.dart';
import '../features/login/ui/gate_screens.dart';
import '../features/outbox/ui/outbox_screen.dart';
import '../features/profile/ui/profile_screens.dart';
import '../features/route/data/day_reader.dart';
import '../features/route/ui/route_screen.dart';
import '../features/route/ui/today_screen.dart';
import '../features/settings/ui/settings_screen.dart';
import '../features/visit/data/mutation_sink.dart';
import '../features/visit/ui/visit_flow_screen.dart';
import 'controller.dart';
import 'routes.dart';

class PhaseGate extends StatefulWidget {
  const PhaseGate({super.key, required this.controller, required this.versionLabel, required this.onSignedOut, required this.child});

  final AppController controller;
  final String versionLabel;

  /// Drops any open page once nobody is signed in.
  final VoidCallback onSignedOut;
  final Widget child;

  @override
  State<PhaseGate> createState() => _PhaseGateState();
}

class _PhaseGateState extends State<PhaseGate> with WidgetsBindingObserver {
  late AppPhase _last = widget.controller.phase;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _changed() {
    final now = widget.controller.phase;
    if (now == _last) return;
    _last = now;
    if (now == AppPhase.signedOut || now == AppPhase.sessionEnded || now == AppPhase.wiped) widget.onSignedOut();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) unawaited(widget.controller.paused());
    if (state == AppLifecycleState.resumed) unawaited(widget.controller.resumed());
  }

  Widget? _cover() {
    final c = widget.controller;
    return switch (c.phase) {
      AppPhase.booting => const SplashScreen(),
      AppPhase.signedOut => SignInScreen(onSignIn: c.signIn, versionLabel: widget.versionLabel, notice: c.signInNotice),
      AppPhase.locked => LockScreen(attemptsLeft: c.unlockAttemptsLeft, maxAttempts: maxUnlockAttempts, onUnlock: c.unlock),
      AppPhase.sessionEnded => SessionEndedScreen(onSignIn: c.signInAgain),
      AppPhase.noScreenLock => DeviceStateScreen.noScreenLock(onRetry: c.signInAgain),
      AppPhase.updateRequired => const DeviceStateScreen.updateRequired(),
      AppPhase.blocked => const DeviceStateScreen.blocked(),
      AppPhase.wiped => DeviceStateScreen.wiped(onSignIn: c.signInAgain),
      AppPhase.misconfigured => const DeviceStateScreen.misconfigured(),
      AppPhase.ready => c.wipePending && c.sync.waiting > 0
          ? DeviceStateScreen.wipePending(waiting: c.sync.waiting, onUpload: () => unawaited(c.syncNow()))
          : null,
    };
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) {
          final cover = _cover();
          return Stack(children: [
            // Kept alive under the gate so a visit in progress is still there after unlocking; invisible, untouchable and
            // hidden from accessibility meanwhile (REQ-SEC-110).
            // ExcludeFocus: a keyboard-wedge barcode scanner must not type into the hidden screen.
            ExcludeFocus(
              excluding: cover != null,
              child: Visibility(
                visible: cover == null,
                maintainState: true,
                maintainAnimation: true,
                maintainSize: true,
                child: widget.child,
              ),
            ),
            if (cover != null) Positioned.fill(child: Overlay.wrap(child: cover)),
          ]);
        },
      );
}

class _RecordingSink implements MutationSink {
  _RecordingSink(this.inner);

  final MutationSink inner;
  Map<String, Object?>? last;

  @override
  Future<SavedMutation> enqueue({required String type, String? visitId, String? visitLabel, required Map<String, Object?> payload}) async {
    final saved = await inner.enqueue(type: type, visitId: visitId, visitLabel: visitLabel, payload: payload);
    last = payload;
    return saved;
  }
}

/// Navigation shared by Today, the full list and Profile.
class AppNav {
  AppNav(this.c, this.context);

  final AppController c;
  final BuildContext context;

  Future<void> _push(WidgetBuilder page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: page));

  Widget _live(Widget Function(BuildContext) build) => ListenableBuilder(listenable: c, builder: (context, _) => build(context));

  void visit(String id) {
    final v = c.day.visit(id);
    if (v == null || v.view == null) {
      LimsSnackbar.show(context, 'This visit is closed.');
      return;
    }
    context.push(phleboVisitLocation(id));
  }

  void outbox() => _push((_) => _live((_) => OutboxScreen(
        rows: c.outboxRows,
        sync: c.sync,
        onUploadNow: () async {
          await c.syncNow();
          if (c.offline || c.syncMessage != null) throw StateError('upload failed');
        },
      )));

  void handover() {
    final tubes = c.day.handoverTubes; // the list as it is now; the screen removes nothing under the user's finger
    final centres = c.day.centres;
    final sink = _RecordingSink(c);
    _push((page) => HandoverScreen(
          centres: centres,
          tubes: tubes,
          itemResults: const {},
          sink: sink,
          newId: c.newId,
          onDone: (_) {
            final sent = sink.last!;
            final ids = (sent['specimen_ids']! as List).cast<String>().toSet();
            final centre = centres.where((x) => x.centreId == sent['to_centre_id']).firstOrNull;
            final at = c.wallNow().toLocal();
            Navigator.of(page).pushReplacement(MaterialPageRoute<void>(
              builder: (receipt) => HandoverReceiptScreen(
                centreName: centre?.name ?? '',
                at: at,
                tubes: [for (final t in tubes) if (ids.contains(t.specimenId)) t],
                onDone: () => Navigator.of(receipt).pop(),
              ),
            ));
          },
        ));
  }

  void settings() => _push((page) => _live((_) => SettingsScreen(
        deviceId: c.deviceId,
        appVersion: c.appVersion,
        userDisplayName: c.userName,
        lastDownload: c.day.dataAsOf,
        lastUpload: c.sync.lastUpload,
        pendingCount: c.sync.waiting,
        signOut: c.signOut,
        onSignedOut: () => unawaited(c.finishSignOut()),
      )));

  void help() => _push((page) => HelpScreen(
        onFaqs: () => Navigator.of(page).push(MaterialPageRoute<void>(builder: (_) => const FaqScreen())),
        onContact: () => Navigator.of(page).push(MaterialPageRoute<void>(builder: (_) => contactDispatchPage)),
        onReport: () => Navigator.of(page).push(MaterialPageRoute<void>(builder: (_) => reportProblemPage)),
      ));

  void idCard() => _push((_) => IdCardScreen(name: c.userName));

  Future<void> location() async {
    final allowed = await c.phone.locationAllowed();
    if (!context.mounted) return;
    await _push((_) => LocationScreen(
        captureOn: c.day.captureGps, allowed: allowed, onOpenSettings: () => unawaited(c.phone.openLocationSettings())));
  }

  void fullList() => _push((page) => _live((_) {
        final nav = AppNav(c, page);
        return RouteScreen(
          routeDate: c.day.routeDate ?? c.wallNow(),
          visits: [for (final v in c.day.visits) v.row],
          purged: c.purged && c.day.routeDate == null,
          offline: c.offline,
          dataAsOf: c.day.dataAsOf,
          loading: c.syncing && c.day.routeDate == null,
          sync: c.sync,
          onRefresh: c.syncNow,
          onOpenVisit: nav.visit,
          onOpenHandover: nav.handover,
          onOpenOutbox: nav.outbox,
          onOpenSettings: nav.settings,
          onHelp: nav.help,
        );
      }));
}

/// H01: Today, History, Alerts, Profile on a floating bar. Each tab keeps its state.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.controller});

  final AppController controller;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final nav = AppNav(c, context);
        return Scaffold(
          body: IndexedStack(index: _tab, children: [
            TodayScreen(
              day: c.day,
              today: c.wallNow(),
              sync: c.sync,
              offline: c.offline,
              purged: c.purged,
              syncing: c.syncing,
              message: c.syncMessage,
              onRefresh: c.syncNow,
              onOpenVisit: nav.visit,
              onOpenHandover: nav.handover,
              onOpenOutbox: nav.outbox,
              onOpenFullList: nav.fullList,
              onHelp: nav.help,
            ),
            historyPage,
            alertsPage,
            ProfileScreen(
              name: c.userName,
              sync: c.sync,
              syncing: c.syncing,
              onSync: () => unawaited(c.syncNow()),
              onIdCard: nav.idCard,
              onHandover: nav.handover,
              onOutbox: nav.outbox,
              onLocation: () => unawaited(nav.location()),
              onHelp: nav.help,
              onSettings: nav.settings,
            ),
          ]),
          bottomNavigationBar: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(LimsTokens.space3, 0, LimsTokens.space3, LimsTokens.space2),
              child: ClipRRect(
                borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusXl)),
                child: LimsBottomNav(
                  index: _tab,
                  onTap: (i) => setState(() => _tab = i),
                  items: const [
                    (icon: Icons.route_outlined, label: 'Today', badge: null),
                    (icon: Icons.history, label: 'History', badge: null),
                    (icon: Icons.notifications_none, label: 'Alerts', badge: null),
                    (icon: Icons.person_outline, label: 'Profile', badge: null),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// One visit. The visit and its log are taken once when the page opens, so a background download cannot change the tubes
/// under the phlebotomist; a cancellation from the centre does take over the page.
class VisitHost extends StatefulWidget {
  const VisitHost({super.key, required this.controller, required this.visitId});

  final AppController controller;
  final String visitId;

  @override
  State<VisitHost> createState() => _VisitHostState();
}

class _VisitHostState extends State<VisitHost> {
  late final DayVisit? _visit = widget.controller.day.visit(widget.visitId);
  late final Set<String> _otherBarcodes = widget.controller.day.otherBarcodes(widget.visitId);
  late final _config = widget.controller.day.config;

  void _leave() => context.canPop() ? context.pop() : context.go('/');

  Widget _message(String title) => LimsScaffold(
        title: 'Visit',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsEmptyState(title: title, icon: Icons.block),
          LimsButton(label: 'Back to Today', onPressed: _leave),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final visit = _visit;
    final view = visit?.view;
    final config = _config;
    if (view == null || config == null) return _message('This visit is not on your list.');
    return ListenableBuilder(
      listenable: c,
      builder: (context, flow) =>
          c.day.visit(widget.visitId)?.row.status == 'cancelled' ? _message('This visit was cancelled by the centre.') : flow!,
      child: VisitFlowScreen(
        visit: view,
        config: config,
        otherVisitBarcodes: _otherBarcodes,
        sink: c,
        readGps: c.readGps,
        now: () => c.wallNow().toLocal(),
        launchUri: c.phone.openUri,
        initialLog: visit!.log,
        onExit: (_) => _leave(),
      ),
    );
  }
}
