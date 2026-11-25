// DEV-FLAVOUR ONLY. Wires every phlebotomist screen into one clickable app on top of PreviewStore (synthetic data):
// splash > sign in > [lock | wipe | update gates] > tab shell (Today, History, Alerts, Profile) > visit flow and sub-screens.
// The visit deep link is the contract route phlebo_app.visit; every other screen is pushed on the navigator (no deep link).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_ui/lims_ui.dart';

import '../app/router.dart' show PhleboScreens;
import '../app/routes.dart';
import '../features/alerts/ui/alerts_screen.dart';
import '../features/entry/ui/device_notice_screen.dart';
import '../features/entry/ui/lock_screen.dart';
import '../features/entry/ui/login_screen.dart';
import '../features/entry/ui/splash_screen.dart';
import '../features/handover/ui/handover_receipt_screen.dart';
import '../features/handover/ui/handover_screen.dart';
import '../features/history/ui/history_day_screen.dart';
import '../features/history/ui/history_screen.dart';
import '../features/outbox/ui/outbox_screen.dart';
import '../features/profile/ui/id_card_screen.dart';
import '../features/profile/ui/location_screen.dart';
import '../features/profile/ui/profile_screen.dart';
import '../features/route/ui/queue_screen.dart';
import '../features/route/ui/route_screen.dart';
import '../features/settings/domain/sign_out.dart';
import '../features/settings/ui/settings_screen.dart';
import '../features/shell/ui/phlebo_shell.dart';
import '../features/support/ui/contact_screen.dart';
import '../features/support/ui/faq_screen.dart';
import '../features/support/ui/help_screen.dart';
import '../features/support/ui/report_problem_screen.dart';
import '../features/visit/ui/visit_flow_screen.dart';
import '../ui/phlebo_kit.dart';
import 'preview_data.dart';
import 'preview_store.dart';

class PreviewScreens implements PhleboScreens {
  PreviewScreens(this.store, {this.splashFor = const Duration(milliseconds: 1400)});

  final PreviewStore store;
  final Duration splashFor;

  @override
  Widget route(BuildContext context, String routeDate) => PreviewRoot(store: store, splashFor: splashFor);

  @override
  Widget visit(BuildContext context, String visitId) => PreviewVisit(store: store, visitId: visitId);
}

enum _Phase { splash, login, app }

class PreviewRoot extends StatefulWidget {
  const PreviewRoot({super.key, required this.store, this.splashFor = const Duration(milliseconds: 1400), this.startSignedIn = false});

  final PreviewStore store;
  final Duration splashFor;
  final bool startSignedIn;

  @override
  State<PreviewRoot> createState() => _PreviewRootState();
}

class _PreviewRootState extends State<PreviewRoot> {
  late _Phase _phase = widget.startSignedIn ? _Phase.app : _Phase.splash;
  Timer? _timer;
  bool _wiped = false;
  int _lockFails = 0;

  PreviewStore get s => widget.store;

  @override
  void initState() {
    super.initState();
    if (_phase == _Phase.splash) {
      if (widget.splashFor == Duration.zero) {
        _phase = _Phase.login;
      } else {
        _timer = Timer(widget.splashFor, () => mounted ? setState(() => _phase = _Phase.login) : null);
      }
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  // ---- navigation helpers (screens that are pushed on the navigator) ----

  void _openVisit(String id) => context.push(phleboVisitLocation(id));

  void _push(WidgetBuilder b) => pushScreen<void>(context, (c) => ListenableBuilder(listenable: s, builder: (cc, _) => b(cc)));

  void _openHelp() => _push((c) => HelpScreen(
        onOpenFaqs: () => pushScreen<void>(c, (_) => const FaqScreen()),
        onOpenContact: () => pushScreen<void>(c, (_) => _contact()),
        onOpenReport: () => pushScreen<void>(c, (_) => _report()),
      ));

  Widget _contact() => ContactScreen(
        contact: PreviewData.dispatch,
        onCall: (p) => s.launched.add(Uri(scheme: 'tel', path: p)),
        onReport: () => pushScreen<void>(context, (_) => _report()),
      );

  Widget _report() => ReportProblemScreen(offline: s.offline, onSubmit: (cat, text) async => s.offline ? ReportResult.savedOnPhone : ReportResult.sent);

  void _openOutbox() => _push((c) => OutboxScreen(rows: List.of(s.outbox), sync: s.sync, onUploadNow: s.syncNow));

  void _openSettings() => _push((c) => SettingsScreen(
        deviceId: 'preview-device-00000001',
        appVersion: '0.0.0+1',
        userDisplayName: PreviewData.profile.displayName,
        lastDownload: s.lastDownload,
        lastUpload: s.lastUpload,
        pendingCount: s.pending,
        signOut: () async => s.pending > 0 ? SignOutResult.unsyncedChanges : SignOutResult.done,
        onSignedOut: () {
          Navigator.of(context).popUntil((r) => r.isFirst);
          setState(() => _phase = _Phase.login);
        },
      ));

  void _openHandover() => _push((c) => HandoverScreen(
        centres: PreviewData.centres,
        tubes: s.handoverPool,
        itemResults: s.handoverResults,
        sink: s,
        newId: () => 'preview-handover-${s.outbox.length}',
        onDone: (_) {
          Navigator.of(c).pop();
          if (s.lastReceipt != null) _openReceipt();
        },
      ));

  void _openReceipt() => _push((c) => HandoverReceiptScreen(
        receipt: s.lastReceipt!,
        onDone: () => Navigator.of(c).pop(),
        onContactDispatch: () => s.launched.add(Uri(scheme: 'tel', path: PreviewData.dispatch.phone!)),
      ));

  void _openAll() => _push((c) => RouteScreen(
        routeDate: s.now(),
        visits: s.routeVisits,
        purged: false,
        offline: s.offline,
        dataAsOf: s.lastDownload,
        sync: s.sync,
        onRefresh: _refresh,
        onOpenVisit: _openVisit,
        onOpenHandover: _openHandover,
        onOpenOutbox: _openOutbox,
        onOpenSettings: _openSettings,
        onHelp: _openHelp,
      ));

  Future<void> _refresh() async {
    try {
      await s.syncNow();
    } catch (_) {
      // offline: the banner already says so
    }
  }

  void _openLocation() => _push((c) => LocationScreen(permission: s.location, onOpenPhoneSettings: () => s.setLocation(LocationPermission.granted)));

  // ---- gates and shell ----

  Widget _login() => LoginScreen(
        appVersion: '0.0.0+1',
        environmentName: 'Preview · synthetic data',
        offline: s.offline,
        onUseFingerprint: () async => setState(() => _phase = _Phase.app),
        initialOutcome: _wiped ? LoginOutcome.rebind : null,
        onSignIn: (email, password) async {
          await Future<void>.delayed(const Duration(milliseconds: 400));
          if (password == 'wrong') return LoginOutcome.badCredentials;
          if (password == 'locked') return LoginOutcome.locked;
          if (mounted) setState(() => _phase = _Phase.app);
          return LoginOutcome.ok;
        },
      );

  Widget _shell() => PhleboShell(
        alertsBadge: s.unreadAlerts,
        pages: {
          PhleboTab.today: QueueScreen(
            routeDate: s.now(),
            visits: s.routeVisits,
            purged: false,
            offline: s.offline,
            dataAsOf: s.lastDownload,
            sync: s.sync,
            onRefresh: _refresh,
            onOpenVisit: _openVisit,
            onStartTravel: s.startTravel,
            onOpenAll: _openAll,
            onOpenOutbox: _openOutbox,
            onOpenHandover: _openHandover,
            handoverTubes: s.handoverPool.length,
            onHelp: _openHelp,
          ),
          PhleboTab.history: HistoryScreen(
            days: s.history,
            offline: s.offline,
            sync: s.sync,
            onOpenDay: (d) => pushScreen<void>(context, (_) => HistoryDayScreen(day: d, allSynced: s.pending == 0)),
          ),
          PhleboTab.alerts: AlertsScreen(
            alerts: s.alerts,
            now: s.now(),
            offline: s.offline,
            onMarkAllRead: s.markAllRead,
            onOpen: (a) {
              s.markRead(a.id);
              if (a.visitId != null) {
                _openVisit(a.visitId!);
              } else if (a.kind.name == 'handover') {
                _openHandover();
              }
            },
          ),
          PhleboTab.profile: ProfileScreen(
            profile: PreviewData.profile,
            sync: s.sync,
            syncing: s.syncing,
            offline: s.offline,
            onSyncNow: _refresh,
            onOpenIdCard: () => pushScreen<void>(context, (_) => IdCardScreen(profile: PreviewData.profile)),
            onOpenHandover: _openHandover,
            onOpenOutbox: _openOutbox,
            onOpenLocation: _openLocation,
            onOpenHelp: _openHelp,
            onOpenSettings: _openSettings,
          ),
        },
      );

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.splash:
        return const SplashScreen();
      case _Phase.login:
        return ListenableBuilder(listenable: s, builder: (_, __) => _login());
      case _Phase.app:
        return ListenableBuilder(
          listenable: s,
          builder: (context, _) {
            if (s.updateRequired) return DeviceNoticeScreen(kind: DeviceNotice.updateRequired, onPrimary: () => s.setUpdateRequired(false));
            if (s.wipeRequested) {
              return DeviceNoticeScreen(
                kind: DeviceNotice.wipeRequested,
                pendingChanges: s.pending,
                uploading: s.syncing,
                onPrimary: () async {
                  try {
                    await s.syncNow();
                    s.setWipeRequested(false);
                    _wiped = true;
                    if (mounted) setState(() => _phase = _Phase.login);
                  } catch (_) {
                    // offline: stays on this screen, the count shows what is still waiting
                  }
                },
              );
            }
            if (s.locked) {
              return LockScreen(
                attemptsLeft: _lockFails == 0 ? null : 5 - _lockFails,
                sessionEnded: _lockFails >= 5,
                onUnlock: () {
                  _lockFails = 0;
                  s.setLocked(false);
                },
                onSignInAgain: () {
                  _lockFails = 0;
                  s.setLocked(false);
                  setState(() => _phase = _Phase.login);
                },
              );
            }
            return Stack(children: [
              _shell(),
              Positioned(right: LimsTokens.space2, bottom: LimsTokens.space16 + LimsTokens.space10, child: _PreviewButton(store: s, onSignOut: () => setState(() => _phase = _Phase.login))),
            ]);
          },
        );
    }
  }
}

/// Reviewer controls: flips the phone into each state the real app can reach (offline, location off, lock, wipe, update).
class _PreviewButton extends StatelessWidget {
  const _PreviewButton({required this.store, required this.onSignOut});

  final PreviewStore store;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: 'Preview controls',
        child: FloatingActionButton.small(
          heroTag: 'preview-controls',
          backgroundColor: LimsTokens.colorNeutral900,
          foregroundColor: LimsTokens.colorAccentFg,
          onPressed: () => showPhleboSheet<void>(
            context,
            builder: (c) => ListenableBuilder(
              listenable: store,
              builder: (c, _) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Preview controls', style: Theme.of(c).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                const Text('Synthetic data. Flip the phone into a state to see its screen.'),
                SwitchListTile(title: const Text('Offline'), value: store.offline, onChanged: store.setOffline),
                SwitchListTile(
                  title: const Text('Location permission off'),
                  value: store.location != LocationPermission.granted,
                  onChanged: (v) => store.setLocation(v ? LocationPermission.denied : LocationPermission.granted),
                ),
                SwitchListTile(title: const Text('Centre asked for a wipe'), value: store.wipeRequested, onChanged: (v) {
                  Navigator.of(c).pop();
                  store.setWipeRequested(v);
                }),
                SwitchListTile(title: const Text('App update required'), value: store.updateRequired, onChanged: (v) {
                  Navigator.of(c).pop();
                  store.setUpdateRequired(v);
                }),
                ListTile(
                  leading: const Icon(Icons.lock_outline),
                  title: const Text('Lock the phone now'),
                  onTap: () {
                    Navigator.of(c).pop();
                    store.setLocked(true);
                  },
                ),
                ListTile(
                  leading: const Icon(Icons.logout),
                  title: const Text('Back to sign in'),
                  onTap: () {
                    Navigator.of(c).pop();
                    onSignOut();
                  },
                ),
              ]),
            ),
          ),
          child: const Icon(Icons.tune),
        ),
      );
}

/// Deep-link target phlebo_app.visit: the visit flow (arrive > identity > consent > collect > payment > finish | fail).
class PreviewVisit extends StatelessWidget {
  const PreviewVisit({super.key, required this.store, required this.visitId});

  final PreviewStore store;
  final String visitId;

  @override
  Widget build(BuildContext context) {
    final view = store.view(visitId);
    if (view == null) {
      return LimsSecureScreen(
        child: LimsScaffold(title: 'Visit', body: const LimsEmptyState(title: 'This visit is no longer on your list.', message: 'Pending changes will still upload.')),
      );
    }
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => VisitFlowScreen(
        key: ValueKey('flow-$visitId'),
        visit: view,
        config: PreviewData.config,
        otherVisitBarcodes: store.otherBarcodes(visitId),
        sink: store,
        readGps: () async => const {'status': 'off'},
        now: store.now,
        launchUri: (u) async => store.launched.add(u),
        initialLog: store.logOf(visitId),
        travel: store.travelOf(visitId),
        onStartTravel: () => store.startTravel(visitId),
        onOpenLocationSettings: () => store.setLocation(LocationPermission.granted),
        onExit: (_) => context.canPop() ? context.pop() : null,
      ),
    );
  }
}
