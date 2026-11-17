// T-P4 — A14 Smart summary (04-UI-UX A14; 03-APP-FLOW §11 A14 states "tab hidden when none | skeleton | error | content + disclaimer | app lock", §5 "smart summary of v1 hidden";
// US-EN-09.2 shown exactly as returned, 09.3 hidden when none, 09.4 superseded; REQ-SEC-109 LimsSecureScreen; LD-140 lims_ui only). Synthetic data only.
// The server (E24) decides what exists; the app shows it without recomputing numbers or inventing wording. Mapping texts are quoted from 04-UI-UX A14.
// US-EN-09.4 vs 03-APP-FLOW §5 ("smart summary of v1 hidden") are not identical: the screen marks an older version as "Replaced by a newer version" when given `superseded: true`; whether the A13 tab is offered for an older version is the entry's caller's choice (not pinned).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/reports/smart/smart_summary_screen.dart';

import '../../support/rig.dart';
import '../../support/smart_fakes.dart';

double topOf(WidgetTester t, Finder f) => t.getTopLeft(f.first).dy;

void main() {
  late Rig rig;
  late SmartHost h;

  setUp(() async {
    rig = await Rig.create();
    h = SmartHost(rig);
  });
  tearDown(() => rig.dispose());

  group('fetch and states', () {
    testWidgets('opening A14 calls E24 ONCE for that report version; PHI screen (LimsSecureScreen); no id is shown', (tester) async {
      await openSummary(tester, h, version: 2);
      expect(h.api.calls, [(reportId: smartReportId, versionNo: 2)]);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.textContaining(smartReportId), findsNothing);
    });

    testWidgets('while E24 is in flight: a progress state and none of the content (no half summary, no error)', (tester) async {
      final gate = Completer<void>();
      h.api.hold = (_) => gate.future;
      await openSummary(tester, h, waitForIt: false);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      expect(find.text(lipidText), findsNothing);
      expect(find.byType(LimsErrorState), findsNothing);
      gate.complete();
      await settleSmart(tester);
      expect(find.text(lipidText), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('no polling: a minute later there is still exactly one E24 call', (tester) async {
      await openSummary(tester, h);
      await tester.pump(const Duration(seconds: 60));
      expect(h.api.calls, hasLength(1));
    });

    testWidgets('common.not_found (nothing approved / feature off): no content, no error box, no retry, no server text', (tester) async {
      h.api.onGet = (_) => throw LimsException(LimsErrorCodes.commonNotFound);
      await openSummary(tester, h);
      expect(find.text(lipidText), findsNothing);
      expect(find.byType(LimsErrorState), findsNothing, reason: 'a missing summary is not a failure');
      expect(find.byType(LimsEmptyState), findsOneWidget);
      expect(find.textContaining('common.'), findsNothing);
      expect(h.api.calls, hasLength(1));
    });

    testWidgets('a failure shows an error state with a retry; retry calls E24 again and shows the content; the error code / server text never appears', (tester) async {
      h.api.onGet = (n) => n == 1 ? throw LimsException(LimsErrorCodes.commonDependencyUnavailable) : summaryBody();
      await openSummary(tester, h);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.textContaining('common.'), findsNothing);
      expect(find.text(lipidText), findsNothing);
      await tester.tap(find.byWidgetPredicate((w) => w is Text && RegExp(r'retry|try again', caseSensitive: false).hasMatch(w.data ?? '')).first);
      await settleSmart(tester);
      expect(h.api.calls, hasLength(2));
      expect(find.text(lipidText), findsOneWidget);
      expect(find.byType(LimsErrorState), findsNothing);
    });

    testWidgets('an unexpected exception (not a LimsException) is the same generic error state, never its message', (tester) async {
      h.api.onGet = (_) => throw StateError('boom synthetic-secret-detail');
      await openSummary(tester, h);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.textContaining('synthetic-secret-detail'), findsNothing);
    });

    testWidgets('a malformed body (not a map, or sections of the wrong type) is the error state, not a crash', (tester) async {
      for (final bad in <Object?>[null, 'x', 5, <Object?>[], {'panels': 'nope'}]) {
        final host = SmartHost(rig)..api.onGet = (_) => bad;
        await openSummary(tester, host);
        expect(tester.takeException(), isNull, reason: 'body: $bad');
        expect(find.byType(LimsErrorState).evaluate().isNotEmpty || find.byType(LimsEmptyState).evaluate().isNotEmpty, isTrue, reason: 'body: $bad');
        await tester.pumpWidget(const SizedBox());
      }
    });
  });

  group('content exactly as returned (US-EN-09.2)', () {
    testWidgets('health score value and band label; the three band labels', (tester) async {
      await openSummary(tester, h);
      expect(find.textContaining('82'), findsWidgets);
      expect(find.text('Good'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      for (final (band, label) in [('fair', 'Fair'), ('needs_attention', 'Needs attention')]) {
        final host = SmartHost(rig)..api.onGet = (_) => summaryBody(healthScore: {'value': 41, 'band': band});
        await openSummary(tester, host);
        expect(find.text(label), findsWidgets, reason: band);
        await tester.pumpWidget(const SizedBox());
      }
    });

    testWidgets('no health score in the answer -> no score card is invented', (tester) async {
      h.api.onGet = (_) => summaryBody(healthScore: null);
      await openSummary(tester, h);
      expect(find.text('Health score'), findsNothing);
      expect(find.text('Good'), findsNothing);
      expect(find.text(lipidText), findsOneWidget);
    });

    testWidgets('panels: display name when given else the panel code; status words In range / Borderline / Out of range / Critical — contact your doctor, each as a LimsStatusChip (tone + icon + word)', (tester) async {
      h.api.onGet = (_) => summaryBody(panels: [
            {'panel_code': 'SYN_LIPID', 'display_name': 'Synthetic Lipid Profile', 'status': 'borderline'},
            {'panel_code': 'SYN_CBC', 'status': 'in_range'},
            {'panel_code': 'SYN_LFT', 'display_name': 'Synthetic Liver', 'status': 'out_of_range'},
            {'panel_code': 'SYN_TROP', 'display_name': 'Synthetic Cardiac', 'status': 'critical'},
          ]);
      await openSummary(tester, h);
      expect(find.text('Synthetic Lipid Profile'), findsOneWidget);
      expect(find.text('SYN_LIPID'), findsNothing, reason: 'the display name replaces the code');
      expect(find.text('SYN_CBC'), findsOneWidget, reason: 'no display name -> the code');
      for (final w in ['Borderline', 'In range', 'Out of range', 'Critical — contact your doctor']) {
        expect(find.text(w), findsOneWidget, reason: w);
      }
      expect(find.byType(LimsStatusChip), findsAtLeastNWidgets(4));
    });

    testWidgets('"Results that need attention", "Advice" and "Suggested follow-up" show every text verbatim; follow-up reads "In {interval_days} days: {text}"', (tester) async {
      h.api.onGet = (_) => summaryBody(
            deranged: [
              {'direction': 'high', 'severity': 'borderline', 'text': lipidText},
              {'direction': 'low', 'severity': 'critical', 'text': 'Synthetic: second finding <b>as is</b> & 100%.'},
            ],
            advice: [
              {'text': adviceText},
              {'text': 'Synthetic: drink water.'}
            ],
            followUps: [
              {'interval_days': 90, 'text': followUpText},
              {'interval_days': 30, 'text': 'Synthetic: recheck.'}
            ],
          );
      await openSummary(tester, h);
      expect(find.text('Results that need attention'), findsOneWidget);
      expect(find.text('Advice'), findsOneWidget);
      expect(find.text('Suggested follow-up'), findsOneWidget);
      for (final t in [lipidText, 'Synthetic: second finding <b>as is</b> & 100%.', adviceText, 'Synthetic: drink water.']) {
        expect(find.text(t), findsOneWidget, reason: t);
      }
      expect(find.text('In 90 days: $followUpText'), findsOneWidget);
      expect(find.text('In 30 days: Synthetic: recheck.'), findsOneWidget);
    });

    testWidgets('no reminder button in v1 (reminders are created by staff or the system), and no test code / ids anywhere', (tester) async {
      await openSummary(tester, h);
      expect(find.byWidgetPredicate((w) => w is Text && RegExp(r'remind', caseSensitive: false).hasMatch(w.data ?? '')), findsNothing);
      expect(find.byType(LimsButton), findsNothing, reason: 'read-only screen');
      expect(find.textContaining('SYN_HBA1C'), findsNothing);
    });

    testWidgets('trends are chips only: Improved / Worse / Stable', (tester) async {
      h.api.onGet = (_) => summaryBody(trends: [
            {'direction': 'improved'},
            {'direction': 'worsened'},
            {'direction': 'stable'},
          ]);
      await openSummary(tester, h);
      for (final w in ['Improved', 'Worse', 'Stable']) {
        expect(find.text(w), findsOneWidget, reason: w);
      }
      expect(find.text('Trends'), findsOneWidget);
    });

    testWidgets('an unknown trend / band / panel status word is not shown raw and does not crash', (tester) async {
      h.api.onGet = (_) => summaryBody(
            healthScore: {'value': 50, 'band': 'brand_new_band'},
            panels: [
              {'panel_code': 'SYN_X', 'status': 'brand_new_status'}
            ],
            trends: [
              {'direction': 'brand_new_direction'}
            ],
          );
      await openSummary(tester, h);
      expect(tester.takeException(), isNull);
      expect(find.text('brand_new_band'), findsNothing);
      expect(find.text('brand_new_status'), findsNothing);
      expect(find.text('brand_new_direction'), findsNothing);
    });

    testWidgets('disclaimer: the returned disclaimer_text; the 04-UI-UX default sentence when the answer has none', (tester) async {
      await openSummary(tester, h);
      expect(find.text(disclaimer), findsOneWidget);
      expect(find.text(defaultDisclaimer), findsNothing);
      await tester.pumpWidget(const SizedBox());
      final host = SmartHost(rig)..api.onGet = (_) => summaryBody(disclaimerText: null);
      await openSummary(tester, host);
      expect(find.text(defaultDisclaimer), findsOneWidget);
    });

    testWidgets('section order: Health score, Panels, Results that need attention, Advice, Suggested follow-up, Trends, Disclaimer', (tester) async {
      await openSummary(tester, h);
      final ys = [
        topOf(tester, find.text('Health score')),
        topOf(tester, find.text('Synthetic Lipid Profile')),
        topOf(tester, find.text('Results that need attention')),
        topOf(tester, find.text('Advice')),
        topOf(tester, find.text('Suggested follow-up')),
        topOf(tester, find.text('Trends')),
        topOf(tester, find.text(disclaimer)),
      ];
      expect(ys, orderedEquals([...ys]..sort()));
      expect(ys.toSet(), hasLength(ys.length));
    });
  });

  group('older version (US-EN-09.4)', () {
    testWidgets('superseded: true -> "Replaced by a newer version" is shown with the content; default -> not shown', (tester) async {
      await openSummary(tester, h, superseded: true);
      expect(find.text('Replaced by a newer version'), findsOneWidget);
      expect(find.text(lipidText), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      final host = SmartHost(rig);
      await openSummary(tester, host);
      expect(find.text('Replaced by a newer version'), findsNothing);
    });
  });

  group('A13 hook SmartSummaryEntry (tab hidden when none)', () {
    testWidgets('smartSummaryAvailable = false -> nothing is rendered and E24 is never called (hidden)', (tester) async {
      await openEntry(tester, h, available: false);
      expect(find.text('Smart summary'), findsNothing);
      expect(find.byType(InkWell), findsNothing);
      expect(h.api.calls, isEmpty);
    });

    testWidgets('smartSummaryAvailable = true -> a "Smart summary" control; no E24 call until it is tapped; tapping opens A14 with the content', (tester) async {
      await openEntry(tester, h, available: true);
      expect(find.text('Smart summary'), findsOneWidget);
      expect(h.api.calls, isEmpty, reason: 'the content is fetched when A14 opens');
      await tester.tap(find.text('Smart summary'));
      await tester.pump(const Duration(milliseconds: 10));
      await settleSmart(tester);
      expect(h.api.calls, [(reportId: smartReportId, versionNo: 1)]);
      expect(find.byType(SmartSummaryScreen), findsOneWidget);
      expect(find.text(lipidText), findsOneWidget);
    });

    testWidgets('the superseded flag is handed on to the screen', (tester) async {
      await openEntry(tester, h, available: true, superseded: true);
      await tester.tap(find.text('Smart summary'));
      await tester.pump(const Duration(milliseconds: 10));
      await settleSmart(tester);
      expect(find.text('Replaced by a newer version'), findsOneWidget);
    });

    testWidgets('a hidden entry that becomes available later (list refreshed) shows the control without a restart', (tester) async {
      await openEntry(tester, h, available: false);
      expect(find.text('Smart summary'), findsNothing);
      await openEntry(tester, h, available: true);
      expect(find.text('Smart summary'), findsOneWidget);
    });
  });
}
