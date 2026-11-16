// T0A-M5-PHLEBO-2 test harness (LD-258): mounts M7 payment, M8 complete, M9 fail visit, M10 handover, M11 outbox and M12 settings on a
// 360 dp phone at a given text scale, with or without reduced motion, inside the real LimsTheme. Synthetic data only.
// Restyle only: no screen API changes. Reuses mount/pumpFor/contrast of the PHLEBO-1 harness and the hc27 / visit fixtures (nothing edited).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/handover/ui/handover_screen.dart';
import 'package:phlebo_app/features/outbox/domain/outbox_row.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/outbox/ui/outbox_screen.dart';
import 'package:phlebo_app/features/outcome/ui/complete_screen.dart';
import 'package:phlebo_app/features/outcome/ui/fail_visit_screen.dart';
import 'package:phlebo_app/features/payment/ui/payment_screen.dart';
import 'package:phlebo_app/features/settings/domain/sign_out.dart';
import 'package:phlebo_app/features/settings/ui/settings_screen.dart';

import 'hc27_fixture.dart';
import 'm5_harness.dart';

export 'm5_harness.dart' show mount, pumpFor, contrast;

typedef OpenB = Future<void> Function(WidgetTester t, {double scale, bool reduceMotion, bool settle});

/// 360 dp wide as the phone is, but tall: a lazy ListView builds every row, so the checks see all of them (width and text scale are what overflow depends on).
Future<void> mountTall(WidgetTester t, Widget screen, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) =>
    mount(t, screen, scale: scale, reduceMotion: reduceMotion, settle: settle, height: 3000);

Future<void> openPayment(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) => mountTall(
      t,
      PaymentScreen(visit: sampleVisit(), config: sampleConfig(), sink: RecordingSink(), onRecorded: () {}, onSkipped: () {}),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

Future<void> openComplete(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, bool noPayment = false}) => mountTall(
      t,
      CompleteScreen(
        visit: sampleVisit(),
        collectedCount: 1,
        notCollectedCount: 1,
        payment: noPayment ? null : const PaymentSummary(methodDisplay: 'Cash', amountPaisa: 180000),
        sink: RecordingSink(),
        onFinished: () {},
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

Future<void> openFail(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, String? preselected}) => mountTall(
      t,
      FailVisitScreen(
        visit: sampleVisit(),
        config: sampleConfig(),
        sink: RecordingSink(),
        readGps: readGpsOff,
        onFailed: () {},
        preselectedReasonCode: preselected,
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

/// Item results as the push answer gives them: one of each.
const handoverResults = {specA: 'included', specB: 'skipped_not_collected', specC: 'skipped_already_handed_over'};

Future<void> openHandover(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, bool empty = false}) => mountTall(
      t,
      HandoverScreen(
        centres: centres,
        tubes: empty ? const [] : threeTubes(),
        itemResults: empty ? const {} : handoverResults,
        sink: RecordingSink(),
        newId: () => handoverId,
        onDone: (_) {},
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

/// All six mutation states, newest first: pending and failed items both present.
List<OutboxRow> allStates() => [
      outboxRow('m1', 'visit.arrived', 'pending'),
      outboxRow('m2', 'visit.identity_checked', 'sending'),
      outboxRow('m3', 'visit.consent_recorded', 'applied'),
      outboxRow('m4', 'specimen.collected', 'duplicate'),
      outboxRow('m5', 'payment.captured', 'held', code: 'homecollection.visit_cancelled'),
      outboxRow('m6', 'visit.completed', 'rejected', code: 'homecollection.specimen_not_found'),
    ];

Future<void> openOutbox(
  WidgetTester t, {
  double scale = 1.0,
  bool reduceMotion = false,
  bool settle = true,
  List<OutboxRow>? rows,
  SyncSummary? sync,
  Future<void> Function()? onUploadNow,
}) {
  final r = rows ?? allStates();
  return mountTall(
    t,
    OutboxScreen(
      rows: r,
      sync: sync ?? SyncSummary(waiting: r.where((x) => x.state == 'pending').length, lastUpload: DateTime(2026, 11, 14, 9, 15)),
      onUploadNow: onUploadNow ?? () async {},
    ),
    scale: scale,
    reduceMotion: reduceMotion,
    settle: settle,
  );
}

Future<void> openSettings(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, int pending = 0}) => mountTall(
      t,
      SettingsScreen(
        deviceId: deviceIdLong,
        appVersion: '1.0.0+1',
        userDisplayName: displayName,
        lastDownload: DateTime(2026, 11, 14, 7, 5),
        lastUpload: DateTime(2026, 11, 14, 9, 15),
        pendingCount: pending,
        signOut: () async => SignOutResult.done,
        onSignedOut: () {},
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

/// The screens of the task. Every one must put its content on white 24 radius cards.
final screensB = <({String id, OpenB open})>[
  (id: 'M7 payment', open: openPayment),
  (id: 'M8 complete', open: openComplete),
  (id: 'M9 fail visit', open: openFail),
  (id: 'M10 handover', open: openHandover),
  (id: 'M11 outbox', open: openOutbox),
  (id: 'M12 settings', open: openSettings),
];
