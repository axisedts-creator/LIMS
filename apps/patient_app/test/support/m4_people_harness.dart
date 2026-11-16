// T0C-M4-PATIENT-2 test harness: mounts A6..A15 (profiles, redeem/register, orders, order detail, reports, report viewer, smart summary, pay due)
// on a 360 dp wide phone, inside the real LimsTheme and the EXISTING fakes (no existing file is edited). Synthetic data only.
// Prefixes: prof = profiles_fakes, ord = orders_fakes, rep = reports_fakes, sm = smart_fakes, pay = payments_fakes (their top-level names clash).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/orders/order_detail_screen.dart';
import 'package:patient_app/features/orders/orders_list_screen.dart';
import 'package:patient_app/features/orders/orders_providers.dart';
import 'package:patient_app/features/payments/pay_due_screen.dart';
import 'package:patient_app/features/payments/payment_result_screen.dart';
import 'package:patient_app/features/payments/payments_providers.dart';
import 'package:patient_app/features/profiles/link_code_screen.dart';
import 'package:patient_app/features/profiles/profiles_screen.dart';
import 'package:patient_app/features/profiles/register_screen.dart';
import 'package:patient_app/features/profiles/report_link_screen.dart';
import 'package:patient_app/features/reports/report_viewer_screen.dart';
import 'package:patient_app/features/reports/reports_list_screen.dart';
import 'package:patient_app/features/reports/reports_providers.dart';
import 'package:patient_app/features/reports/smart/smart_summary_entry.dart';
import 'package:patient_app/features/reports/smart/smart_summary_providers.dart';
import 'package:patient_app/features/reports/smart/smart_summary_screen.dart';

import 'auth_fakes.dart' show alphaFlavour;
import 'm4_harness.dart' show appOf;
import 'orders_fakes.dart' as ord;
import 'payments_fakes.dart' as pay;
import 'profiles_fakes.dart' as prof;
import 'reports_fakes.dart' as rep;
import 'rig.dart';
import 'smart_fakes.dart' as sm;

/// 360 dp wide phone of the brief, tall enough that a lazy list builds every row; every screen is also run at text scale 1.3.
Future<void> phoneP2(WidgetTester t, {double scale = 1.0}) async {
  t.view.physicalSize = const Size(360, 1800);
  t.view.devicePixelRatio = 1.0;
  t.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(() {
    t.view.resetPhysicalSize();
    t.view.resetDevicePixelRatio();
    t.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

typedef OpenP2 = Future<void> Function(WidgetTester t, Rig rig, {bool reduceMotion});

Widget _scope(List<Override> overrides, Widget home, bool reduce) => ProviderScope(overrides: overrides, child: appOf(home, reduceMotion: reduce));

Future<void> _pumpN(WidgetTester t, {int n = 6, int ms = 50}) async {
  for (var i = 0; i < n; i++) {
    await t.pump(Duration(milliseconds: ms));
  }
}

/// A page with one button that pushes [screen] (the viewer and the summary have somewhere to pop to), then waits for the route.
Widget _opener(String label, Widget screen) => Builder(
      builder: (c) => Scaffold(
        body: Center(child: TextButton(onPressed: () => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => screen)), child: Text(label))),
      ),
    );

// ---------------------------------------------------------------- A6 .. A9 (profiles)

List<Override> _profileOverrides(Rig rig, prof.FakeProfilesApi api) => [...prof.overrides(api), sessionControllerProvider.overrideWithValue(rig.controller)];

Future<void> openA6(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = prof.FakeProfilesApi()
    ..onList = (_) async => prof.listBody(data: [
          prof.profile(),
          prof.profile(id: prof.pidChild, name: 'Bikram Test (synthetic)', rel: 'child', method: 'report_link', historyFrom: '2026-03-01T04:15:00.000Z'),
          prof.profile(id: prof.pidReport, name: 'Sita Test (synthetic)', rel: 'parent'),
        ], paused: 1);
  await t.pumpWidget(_scope(_profileOverrides(rig, api), const ProfilesScreen(), reduceMotion));
  await _pumpN(t);
}

/// A6 with the list call failing (error state) and with nothing to list (empty state).
Future<void> openA6Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = prof.FakeProfilesApi();
  await t.pumpWidget(_scope(_profileOverrides(rig, api), const ProfilesScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA7(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_profileOverrides(rig, prof.FakeProfilesApi()), const LinkCodeScreen(), reduceMotion));
  await t.pump(); // the card has just been built: enter motion not yet finished
}

Future<void> openA8(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_profileOverrides(rig, prof.FakeProfilesApi()), const ReportLinkScreen(), reduceMotion));
  await t.pump();
}

Future<void> openA9(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_profileOverrides(rig, prof.FakeProfilesApi()), const RegisterScreen(), reduceMotion));
  await _pumpN(t);
}

// ---------------------------------------------------------------- A10, A11 (orders)

List<Override> _orderOverrides(Rig rig, ord.FakeOrdersApi api) => [
      flavourProvider.overrideWithValue(alphaFlavour()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      patientOrdersApiProvider.overrideWithValue(api),
    ];

String _oid(int i) => '01950c16-0000-7000-8000-000000000a1$i';

/// One row for every stage of 04-UI-UX A10, so every chip tone is on screen.
Future<void> openA10(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  const stages = ['registered', 'sample_collected', 'in_lab', 'partial_report', 'report_ready', 'recollection_needed', 'cancelled'];
  final api = ord.FakeOrdersApi()
    ..onList = (_) => {
          'data': [for (var i = 0; i < stages.length; i++) ord.listed(_oid(i), stages[i], paymentDue: stages[i] == 'recollection_needed', reports: stages[i] == 'report_ready' ? 1 : 0)],
          'page': {'limit': 50},
        };
  await t.pumpWidget(_scope(_orderOverrides(rig, api), const OrdersListScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA10Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_orderOverrides(rig, ord.FakeOrdersApi()), const OrdersListScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA10Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = ord.FakeOrdersApi()..onList = (_) => throw Exception('offline');
  await t.pumpWidget(_scope(_orderOverrides(rig, api), const OrdersListScreen(), reduceMotion));
  await _pumpN(t);
}

/// A11 with samples, one released report and a payment due.
Future<void> openA11(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = ord.FakeOrdersApi()
    ..onGet = (_, _) => {
          ...ord.detail(stage: 'partial_report', paymentDue: true, reports: 1),
          'reports': [rep.reportRow(kind: 'partial', panels: const ['Synthetic Lipid Profile', 'Synthetic CBC'])],
        };
  await t.pumpWidget(_scope(_orderOverrides(rig, api), OrderDetailScreen(orderId: ord.orderId), reduceMotion));
  await _pumpN(t);
}

/// A11 recollection: the red "New sample needed" step.
Future<void> openA11Recollect(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = ord.FakeOrdersApi()..onGet = (_, _) => ord.detail(stage: 'recollection_needed');
  await t.pumpWidget(_scope(_orderOverrides(rig, api), OrderDetailScreen(orderId: ord.orderId), reduceMotion));
  await _pumpN(t);
}

// ---------------------------------------------------------------- A12, A13 (reports)

List<Override> _reportOverrides(Rig rig, rep.FakeReportsApi api) => [
      flavourProvider.overrideWithValue(alphaFlavour()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      secureTempFilesProvider.overrideWithValue(rig.temp),
      patientReportsApiProvider.overrideWithValue(api),
      reportSharerProvider.overrideWithValue(rep.FakeSharer()),
      reportViewerBuilderProvider.overrideWithValue(rep.StubViewer().build),
    ];

const reportId3 = '01950c16-0000-7000-8000-000000000c03';

rep.FakeReportsApi reportsApi() => rep.FakeReportsApi()
  ..onList = (_, older) => rep.page([
        rep.reportRow(smart: true, panels: const ['Synthetic Lipid Profile', 'Synthetic CBC']),
        rep.reportRow(id: rep.reportId2, kind: 'partial', panels: const ['Synthetic Thyroid Panel']),
        rep.reportRow(id: reportId3, kind: 'amended', panels: const ['Synthetic Liver Panel']),
        if (older) rep.reportRow(id: rep.reportId2, version: 1, status: 'superseded', panels: const ['Synthetic Old Panel']),
      ]);

Future<void> openA12(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_reportOverrides(rig, reportsApi()), const ReportsListScreen(), reduceMotion));
  await t.pump(const Duration(milliseconds: 10));
  await rep.settle(t);
}

Future<void> openA13(WidgetTester t, Rig rig, {bool reduceMotion = false, rep.FakeReportsApi? api}) async {
  await t.pumpWidget(_scope(_reportOverrides(rig, api ?? rep.FakeReportsApi()), _opener('Open report', ReportViewerScreen(reportId: rep.reportId, versionNo: 1)), reduceMotion));
  await t.tap(find.text('Open report'));
  await t.pump(const Duration(milliseconds: 10));
  await rep.settle(t);
}

Future<void> openA13Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) =>
    openA13(t, rig, reduceMotion: reduceMotion, api: rep.FakeReportsApi()..onDownload = (_, _, _) => throw LimsException(LimsErrorCodes.commonNotFound));

// ---------------------------------------------------------------- A14 (smart summary)

List<Override> _smartOverrides(Rig rig, sm.FakeSmartApi api) => [
      flavourProvider.overrideWithValue(alphaFlavour()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      secureTempFilesProvider.overrideWithValue(rig.temp),
      patientSmartSummaryApiProvider.overrideWithValue(api),
    ];

Future<void> _openA14(WidgetTester t, Rig rig, sm.FakeSmartApi api, bool reduce) async {
  await t.pumpWidget(_scope(_smartOverrides(rig, api), _opener('Open summary', SmartSummaryScreen(reportId: sm.smartReportId, versionNo: 1)), reduce));
  await t.tap(find.text('Open summary'));
  await t.pump(const Duration(milliseconds: 10));
  await sm.settleSmart(t);
}

/// Every panel status and every trend of 04-UI-UX A14, so each tone is on screen.
Future<void> openA14(WidgetTester t, Rig rig, {bool reduceMotion = false}) => _openA14(
      t,
      rig,
      sm.FakeSmartApi()
        ..onGet = (_) => sm.summaryBody(panels: [
              {'panel_code': 'SYN_A', 'display_name': 'Synthetic Panel A', 'status': 'in_range'},
              {'panel_code': 'SYN_B', 'display_name': 'Synthetic Panel B', 'status': 'borderline'},
              {'panel_code': 'SYN_C', 'display_name': 'Synthetic Panel C', 'status': 'out_of_range'},
              {'panel_code': 'SYN_D', 'display_name': 'Synthetic Panel D', 'status': 'critical'},
            ], trends: [
              {'direction': 'improved'},
              {'direction': 'worsened'},
              {'direction': 'stable'},
            ]),
      reduceMotion,
    );

Future<void> openA14Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) =>
    _openA14(t, rig, sm.FakeSmartApi()..onGet = (_) => throw LimsException(LimsErrorCodes.commonInternal), reduceMotion);

/// The A13 smart-summary hook on its own (it is a row, not a screen).
Future<void> openA14Entry(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = sm.FakeSmartApi();
  await t.pumpWidget(_scope(_smartOverrides(rig, api), const Scaffold(body: SmartSummaryEntry(reportId: sm.smartReportId, versionNo: 1, smartSummaryAvailable: true)), reduceMotion));
  await t.pump(const Duration(milliseconds: 10));
}

// ---------------------------------------------------------------- A15 (pay due, result)

List<Override> _payOverrides(Rig rig, pay.FakePaymentsApi api) => [
      flavourProvider.overrideWithValue(alphaFlavour()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      patientPaymentsApiProvider.overrideWithValue(api),
      paymentUrlOpenerProvider.overrideWithValue((Uri _) async {}),
    ];

Future<void> openA15(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(_payOverrides(rig, pay.FakePaymentsApi()), PayDueScreen(orderId: pay.payOrderId, amountPaisa: 225000, gateways: const ['esewa', 'khalti']), reduceMotion));
  await t.pump(const Duration(milliseconds: 10));
}

Future<void> _openResult(WidgetTester t, Rig rig, Map<String, Object?> body, bool reduce) async {
  final api = pay.FakePaymentsApi()..onGet = (_) => body;
  await t.pumpWidget(_scope(_payOverrides(rig, api), PaymentResultScreen(paymentRequestId: pay.payId), reduce));
  await _pumpN(t);
}

Future<void> openA15Paid(WidgetTester t, Rig rig, {bool reduceMotion = false}) => _openResult(t, rig, pay.pr('completed'), reduceMotion);
Future<void> openA15Failed(WidgetTester t, Rig rig, {bool reduceMotion = false}) => _openResult(t, rig, pay.pr('failed'), reduceMotion);
Future<void> openA15Confirming(WidgetTester t, Rig rig, {bool reduceMotion = false}) => _openResult(t, rig, pay.pr('queued', review: true), reduceMotion);
