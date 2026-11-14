// T-P4 test support: fake E24 API (decoded SmartSummaryView wire body), hosts for A14 and its entry. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/reports/smart/smart_summary_api.dart
//     abstract interface class PatientSmartSummaryApi { Future<Object?> getSmartSummary({required String reportId, required int versionNo}); }   // E24: decoded SmartSummaryView; throws LimsException (common.not_found = none approved / hidden)
//     class TransportPatientSmartSummaryApi implements PatientSmartSummaryApi { TransportPatientSmartSummaryApi({required PatientTransport transport}); }   // GET /v1/engagement/me/reports/{report_id}/versions/{version_no}/smart-summary
//   lib/features/reports/smart/smart_summary_providers.dart   patientSmartSummaryApiProvider (Provider<PatientSmartSummaryApi>)
//   lib/features/reports/smart/smart_summary_screen.dart      SmartSummaryScreen({required String reportId, required int versionNo, bool superseded = false})  = A14: fetches E24 ONCE on open (no polling), LimsSecureScreen
//   lib/features/reports/smart/smart_summary_entry.dart       SmartSummaryEntry({required String reportId, required int versionNo, required bool smartSummaryAvailable, bool superseded = false})
//       = the A13 "smart tab" hook: renders NOTHING (no text, no API call) when smartSummaryAvailable is false; otherwise a control labelled "Smart summary" that pushes SmartSummaryScreen (Navigator.push).
//   Text is the spec's (04-UI-UX A14), quoted in the tests. The app shows what E24 returned; no number is recomputed, no wording is invented.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/reports/smart/smart_summary_api.dart';
import 'package:patient_app/features/reports/smart/smart_summary_entry.dart';
import 'package:patient_app/features/reports/smart/smart_summary_providers.dart';
import 'package:patient_app/features/reports/smart/smart_summary_screen.dart';

import 'auth_fakes.dart';
import 'rig.dart';

const smartReportId = '01950c16-0000-7000-8000-000000000d01';

const lipidText = 'Synthetic: your LDL is higher than the usual range.';
const adviceText = 'Synthetic: eat more fibre.';
const followUpText = 'Synthetic: repeat the lipid panel.';
const disclaimer = 'Synthetic disclaimer text.';
const defaultDisclaimer = 'This summary is for information only and does not replace advice from your doctor.';

/// A SmartSummaryView as E24 returns it (snake_case wire form, no ids besides report_id).
Map<String, Object?> summaryBody({
  int version = 1,
  Object? healthScore = const {'value': 82, 'band': 'good'},
  List<Map<String, Object?>>? panels,
  List<Map<String, Object?>>? deranged,
  List<Map<String, Object?>>? advice,
  List<Map<String, Object?>>? followUps,
  List<Map<String, Object?>>? trends,
  Object? disclaimerText = disclaimer,
}) =>
    {
      'report_id': smartReportId,
      'version_no': version,
      'approved_at': '2026-03-01T05:00:00.000Z',
      if (healthScore != null) 'health_score': healthScore,
      'panels': panels ??
          [
            {'panel_code': 'SYN_LIPID', 'display_name': 'Synthetic Lipid Profile', 'status': 'borderline'},
            {'panel_code': 'SYN_CBC', 'status': 'in_range'},
          ],
      'deranged': deranged ?? [{'direction': 'high', 'severity': 'borderline', 'text': lipidText}],
      'advice': advice ?? [{'text': adviceText}],
      'follow_ups': followUps ?? [{'interval_days': 90, 'text': followUpText}],
      'trends': trends ?? [{'direction': 'improved'}],
      if (disclaimerText != null) 'disclaimer_text': disclaimerText,
    };

class FakeSmartApi implements PatientSmartSummaryApi {
  /// Answers E24 call n (1-based) with the decoded body or throws.
  Object? Function(int call) onGet = (_) => summaryBody();
  Future<void>? Function(int call)? hold;
  final List<({String reportId, int versionNo})> calls = [];

  @override
  Future<Object?> getSmartSummary({required String reportId, required int versionNo}) async {
    calls.add((reportId: reportId, versionNo: versionNo));
    final n = calls.length;
    final h = hold?.call(n);
    if (h != null) await h;
    return onGet(n);
  }
}

class SmartHost {
  SmartHost(this.rig) : api = FakeSmartApi();
  final Rig rig;
  final FakeSmartApi api;

  Widget scope(Widget home) => ProviderScope(
        overrides: [
          flavourProvider.overrideWithValue(alphaFlavour()),
          sessionControllerProvider.overrideWithValue(rig.controller),
          secureTempFilesProvider.overrideWithValue(rig.temp),
          patientSmartSummaryApiProvider.overrideWithValue(api),
        ],
        child: MaterialApp(theme: LimsTheme.light(), home: home),
      );
}

/// A tall surface so a lazy list builds every section; then lets the screen load.
Future<void> tall(WidgetTester tester) async {
  tester.view.physicalSize = const Size(800, 8000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> settleSmart(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> openSummary(WidgetTester tester, SmartHost h, {bool superseded = false, int version = 1, bool waitForIt = true}) async {
  await tall(tester);
  await tester.pumpWidget(h.scope(Builder(
    builder: (c) => Scaffold(
      body: Center(
        child: TextButton(
          onPressed: () => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => SmartSummaryScreen(reportId: smartReportId, versionNo: version, superseded: superseded))),
          child: const Text('Open summary'),
        ),
      ),
    ),
  )));
  await tester.tap(find.text('Open summary'));
  await tester.pump(const Duration(milliseconds: 10));
  if (waitForIt) await settleSmart(tester);
}

Future<void> openEntry(WidgetTester tester, SmartHost h, {required bool available, bool superseded = false}) async {
  await tall(tester);
  await tester.pumpWidget(h.scope(Scaffold(body: SmartSummaryEntry(reportId: smartReportId, versionNo: 1, smartSummaryAvailable: available, superseded: superseded))));
  await tester.pump(const Duration(milliseconds: 10));
  await settleSmart(tester);
}
