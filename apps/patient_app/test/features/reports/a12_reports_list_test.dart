// T-P3 — A12 reports list (04-UI-UX A12; 03-APP-FLOW §11 A12 states; US-EN-08.1, 08.2). Synthetic data only.
// Rows: comma-joined panel names, kind label, released date/time, "Smart summary" chip; toggle "Show older versions" (-> include_superseded); superseded rows "Replaced by a newer version".
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/reports_fakes.dart';
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late Host h;

  setUp(() async {
    rig = await Rig.create();
    h = Host(rig);
    h.api.onList = (_, includeSuperseded) => page([
          reportRow(id: reportId, version: 2, kind: 'amended', supersedes: 1, panels: ['Synthetic Lipid Profile', 'Synthetic Glucose'], smart: true),
          reportRow(id: reportId2, kind: 'partial', panels: ['Synthetic CBC'], releasedAt: '2026-02-20T04:15:00.000Z'),
          if (includeSuperseded) reportRow(id: reportId, version: 1, status: 'superseded', kind: 'final', panels: ['Synthetic Lipid Profile'], releasedAt: '2026-02-01T04:15:00.000Z'),
        ]);
  });
  tearDown(() => rig.dispose());

  testWidgets('opening A12 fetches E22 once with include_superseded=false and lists one row per report with its panel names comma-joined', (tester) async {
    await openList(tester, h);
    expect(h.api.listCalls, hasLength(1));
    expect(h.api.listCalls.single.includeSuperseded, isFalse);
    expect(h.api.listCalls.single.cursor, isNull);
    expect(find.textContaining('Synthetic Lipid Profile, Synthetic Glucose'), findsOneWidget);
    expect(find.textContaining('Synthetic CBC'), findsOneWidget);
    expect(find.text('Replaced by a newer version'), findsNothing);
  });

  testWidgets('kind labels: Final / Partial / Preliminary / Amended / Addendum; any other value "Report"; each as a LimsStatusChip (tone + word)', (tester) async {
    h.api.onList = (_, _) => page([
          reportRow(id: reportId, kind: 'final'),
          reportRow(id: reportId2, kind: 'partial'),
          reportRow(id: '01950c16-0000-7000-8000-000000000c03', kind: 'preliminary'),
          reportRow(id: '01950c16-0000-7000-8000-000000000c04', kind: 'amended', version: 2),
          reportRow(id: '01950c16-0000-7000-8000-000000000c05', kind: 'addendum'),
          reportRow(id: '01950c16-0000-7000-8000-000000000c06', kind: 'corrected_copy'),
        ]);
    await openList(tester, h);
    for (final k in ['Final', 'Partial', 'Preliminary', 'Amended', 'Addendum', 'Report']) {
      expect(find.text(k), findsOneWidget, reason: k);
    }
    expect(find.byType(LimsStatusChip), findsAtLeastNWidgets(6));
    expect(find.textContaining('corrected_copy'), findsNothing, reason: 'raw codes are never shown');
  });

  testWidgets('a "Smart summary" chip only on the report with smart_summary_available', (tester) async {
    await openList(tester, h);
    expect(find.text('Smart summary'), findsOneWidget);
  });

  testWidgets('the screen is a LimsSecureScreen (PHI) and shows no report / order / profile ids', (tester) async {
    await openList(tester, h);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    for (final id in [reportId, reportId2, orderId, profileId]) {
      expect(find.textContaining(id), findsNothing);
    }
  });

  testWidgets('"Show older versions" refetches with include_superseded=true; superseded rows read "Replaced by a newer version"; turning it off refetches without', (tester) async {
    await openList(tester, h);
    await tester.tap(find.text('Show older versions'));
    await settle(tester);
    expect(h.api.listCalls.last.includeSuperseded, isTrue);
    expect(find.text('Replaced by a newer version'), findsOneWidget);
    await tester.tap(find.text('Show older versions'));
    await settle(tester);
    expect(h.api.listCalls.last.includeSuperseded, isFalse);
    expect(find.text('Replaced by a newer version'), findsNothing);
  });

  testWidgets('empty list: "No reports yet. You\'ll see them here when the lab releases them."', (tester) async {
    h.api.onList = (_, _) => page([]);
    await openList(tester, h);
    expect(find.textContaining("No reports yet. You'll see them here when the lab releases them."), findsOneWidget);
    expect(find.byType(LimsStatusChip), findsNothing);
  });

  testWidgets('error: retry control, no server detail; retry refetches and shows the rows', (tester) async {
    final ok = h.api.onList;
    h.api.onList = (call, s) => call == 1 ? throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2') : ok(call, s);
    await openList(tester, h);
    expect(find.textContaining('hunter2'), findsNothing);
    expect(find.byType(LimsErrorState), findsOneWidget);
    await tester.tap(find.textContaining(RegExp('retry|try again', caseSensitive: false)));
    await settle(tester);
    expect(h.api.listCalls, hasLength(2));
    expect(find.textContaining('Synthetic CBC'), findsOneWidget);
  });

  testWidgets('tapping a row opens A13 for THAT report version (E23 with its report_id and version_no) and, once closed, no file is left', (tester) async {
    await openList(tester, h);
    await tester.tap(find.textContaining('Synthetic CBC'));
    await tester.pump(const Duration(milliseconds: 10));
    await settle(tester);
    expect(h.api.downloadCalls, [(reportId: reportId2, versionNo: 1)]);
    expect(find.text('PDF VIEWER STUB'), findsOneWidget);
    expect(h.tempFiles(), hasLength(1));
    await tester.tap(find.text('Close viewer'));
    await settle(tester);
    expect(h.tempFiles(), isEmpty);
    expect(find.textContaining('Synthetic CBC'), findsOneWidget, reason: 'back on the list');
  });

  testWidgets('opening the list downloads nothing and writes no file', (tester) async {
    await openList(tester, h);
    expect(h.api.downloadCalls, isEmpty);
    expect(h.tempFiles(), isEmpty);
  });

  testWidgets('A12 does not poll: five minutes in the foreground cause no further E22 request', (tester) async {
    await openList(tester, h);
    for (var i = 0; i < 300; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(h.api.listCalls, hasLength(1));
  });
}
