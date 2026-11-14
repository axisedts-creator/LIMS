// T-P3 test support: fake reports API (E22 wire bodies as plain JSON maps, E23 bytes), fake sharer, stub PDF viewer, screen hosts. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/reports/reports_api.dart
//     abstract interface class PatientReportsApi {
//       Future<Object?> listReports({String? profileId, String? orderId, bool includeSuperseded = false, String? cursor, int? limit});   // E22: decoded `{data:[PatientReport], page:{next_cursor?, limit}}`
//       Future<Uint8List> downloadReport({required String reportId, required int versionNo});                                            // E23: the PDF bytes; throws LimsException (common.not_found / rate_limited / dependency_unavailable / internal)
//     }
//   lib/features/reports/reports_providers.dart
//     patientReportsApiProvider  (Provider<PatientReportsApi>)
//     abstract interface class ReportSharer { Future<void> share(String filePath); }    reportSharerProvider (Provider<ReportSharer>)   = the ONLY way a report leaves the app (Save/Share), called only after the confirmation dialog
//     reportViewerBuilderProvider (Provider<Widget Function(String filePath, VoidCallback onClose)>), default `(p, c) => LimsPdfViewer(filePath: p, onClose: c)`  (a test seam: flutter_pdfview is a platform view)
//   lib/features/reports/reports_list_screen.dart   ReportsListScreen()                                  = A12; a row tap pushes ReportViewerScreen (Navigator.push) with the row's report_id / version_no
//   lib/features/reports/report_viewer_screen.dart  ReportViewerScreen({required String reportId, required int versionNo}) = A13
//     downloads once on open, writes the bytes to ONE file inside `ref.read(secureTempFilesProvider).dir` (SecureTempFiles, REQ-SEC-103), hands the path to the viewer builder; deletes that file on close (viewer onClose, system back, dispose) and never writes outside that dir.
//     Both screens: wrapped in LimsSecureScreen (REQ-SEC-109); text from the spec (03-APP-FLOW §11 A12/A13, 04-UI-UX A12/A13): quoted strings below.
//   The temp-file writes may be async: tests let real IO finish with `settle` (tester.runAsync).
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/reports/report_viewer_screen.dart';
import 'package:patient_app/features/reports/reports_api.dart';
import 'package:patient_app/features/reports/reports_list_screen.dart';
import 'package:patient_app/features/reports/reports_providers.dart';

import 'auth_fakes.dart';
import 'rig.dart';

const reportId = '01950c16-0000-7000-8000-000000000c01';
const reportId2 = '01950c16-0000-7000-8000-000000000c02';
const profileId = '01950c16-0000-7000-8000-000000000c0a';
const orderId = '01950c16-0000-7000-8000-000000000c0b';

/// Synthetic "PDF": recognisable bytes the stub viewer can echo back.
Uint8List pdfBytes([String tag = 'one']) => Uint8List.fromList('%PDF-1.7\n% synthetic report $tag\n%%EOF\n'.codeUnits);

/// A PatientReport as E22 returns it.
Map<String, Object?> reportRow({
  String id = reportId,
  int version = 1,
  String status = 'valid',
  String kind = 'final',
  List<String> panels = const ['Synthetic Lipid Profile'],
  bool smart = false,
  int? supersedes,
  String releasedAt = '2026-03-01T04:15:00.000Z',
}) =>
    {
      'report_id': id,
      'version_no': version,
      'order_id': orderId,
      'profile_id': profileId,
      'kind': kind,
      'status': status,
      'released_at': releasedAt,
      'panel_names': panels,
      'smart_summary_available': smart,
      if (supersedes != null) 'supersedes_version_no': supersedes,
    };

Map<String, Object?> page(List<Map<String, Object?>> rows) => {'data': rows, 'page': {'limit': 50}};

class FakeReportsApi implements PatientReportsApi {
  /// Answers E22 call n (1-based) with the decoded body or throws. Default: empty list.
  Object? Function(int call, bool includeSuperseded) onList = (_, _) => page([]);

  /// Answers E23 call n with the bytes or throws.
  Uint8List Function(int call, String reportId, int versionNo) onDownload = (_, _, _) => pdfBytes();

  /// Awaited before E23 call n answers (holds a download in flight).
  Future<void>? Function(int call)? holdDownload;

  final List<({String? profileId, String? orderId, bool includeSuperseded, String? cursor, int? limit})> listCalls = [];
  final List<({String reportId, int versionNo})> downloadCalls = [];

  @override
  Future<Object?> listReports({String? profileId, String? orderId, bool includeSuperseded = false, String? cursor, int? limit}) async {
    listCalls.add((profileId: profileId, orderId: orderId, includeSuperseded: includeSuperseded, cursor: cursor, limit: limit));
    return onList(listCalls.length, includeSuperseded);
  }

  @override
  Future<Uint8List> downloadReport({required String reportId, required int versionNo}) async {
    downloadCalls.add((reportId: reportId, versionNo: versionNo));
    final call = downloadCalls.length;
    final h = holdDownload?.call(call);
    if (h != null) await h;
    return onDownload(call, reportId, versionNo);
  }
}

class FakeSharer implements ReportSharer {
  final List<String> shared = [];
  @override
  Future<void> share(String filePath) async => shared.add(filePath);
}

/// Replaces the platform PDF view: records the path it was given and what the file held at that moment, and exposes a close control.
class StubViewer {
  final List<String> paths = [];
  final List<Uint8List?> contentAtOpen = [];

  Widget build(String filePath, VoidCallback onClose) {
    paths.add(filePath);
    Uint8List? content;
    try {
      content = File(filePath).readAsBytesSync();
    } catch (_) {
      content = null;
    }
    contentAtOpen.add(content);
    return Column(children: [
      const Text('PDF VIEWER STUB'),
      TextButton(onPressed: onClose, child: const Text('Close viewer')),
    ]);
  }
}

class Host {
  Host(this.rig)
      : api = FakeReportsApi(),
        sharer = FakeSharer(),
        viewer = StubViewer();
  final Rig rig;
  final FakeReportsApi api;
  final FakeSharer sharer;
  final StubViewer viewer;

  Widget scope(Widget home) => ProviderScope(
        overrides: [
          flavourProvider.overrideWithValue(alphaFlavour()),
          sessionControllerProvider.overrideWithValue(rig.controller),
          secureTempFilesProvider.overrideWithValue(rig.temp),
          patientReportsApiProvider.overrideWithValue(api),
          reportSharerProvider.overrideWithValue(sharer),
          reportViewerBuilderProvider.overrideWithValue(viewer.build),
        ],
        child: MaterialApp(theme: LimsTheme.light(), home: home),
      );

  /// Files currently inside the secure temp dir (recursive).
  List<File> tempFiles() => rig.tempDir.existsSync() ? rig.tempDir.listSync(recursive: true).whereType<File>().toList() : <File>[];
}

/// Lets real file IO and timers finish inside testWidgets (fake async), then pumps the frames that show the result.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 20));
  }
  // T-P3 ruling: let the ~300 ms route transition finish so controls are hit-testable.
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
}

/// Mounts a page with an "Open report" button; tapping it pushes A13 (so close / back have somewhere to pop to).
Future<void> openViewer(WidgetTester tester, Host h, {String id = reportId, int version = 1, bool waitForIt = true}) async {
  await tester.pumpWidget(h.scope(Builder(
    builder: (c) => Scaffold(
      body: Center(
        child: TextButton(
          onPressed: () => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => ReportViewerScreen(reportId: id, versionNo: version))),
          child: const Text('Open report'),
        ),
      ),
    ),
  )));
  await tester.tap(find.text('Open report'));
  await tester.pump(const Duration(milliseconds: 10));
  if (waitForIt) await settle(tester);
}

Future<void> openList(WidgetTester tester, Host h) async {
  await tester.pumpWidget(h.scope(const ReportsListScreen()));
  await tester.pump(const Duration(milliseconds: 10));
  await settle(tester);
}
