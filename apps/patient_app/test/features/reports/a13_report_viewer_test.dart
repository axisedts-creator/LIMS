// T-P3 — A13 report viewer (04-UI-UX A13; 03-APP-FLOW §11 A13 states; US-EN-08.3, 08.6; REQ-SEC-103 "transient PDFs are the only files the app writes; they die on viewer close and on logout").
// The platform PDF view is replaced by a stub (reportViewerBuilderProvider); what is tested is OUR code: download, the temp file, its deletion, the save confirmation, error states. Synthetic data only.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/reports/report_viewer_screen.dart';

import '../../support/reports_fakes.dart';
import '../../support/rig.dart';

const saveWarning = "This saves the report outside the app. Anyone with access to your phone's files may see it.";

/// The Share/Save control of the app bar: an icon button whose tooltip says share/save, or a text action of that name.
Finder shareControlAny() => find.byWidgetPredicate((w) {
      if (w is IconButton) return RegExp('share|save', caseSensitive: false).hasMatch(w.tooltip ?? '');
      if (w is Text) return RegExp(r'^(share|save)\b', caseSensitive: false).hasMatch(w.data ?? '');
      return false;
    }, description: 'share / save control');

Finder shareControl() => shareControlAny().first;

Finder inDialog(String text) => find.descendant(of: find.byType(AlertDialog), matching: find.text(text));

void main() {
  late Rig rig;
  late Host h;

  setUp(() async {
    rig = await Rig.create();
    h = Host(rig);
  });
  tearDown(() => rig.dispose());

  group('download and temp file (US-EN-08.3, 08.6)', () {
    testWidgets('opening A13 downloads that report version ONCE and shows the viewer; no server id or url is shown', (tester) async {
      await openViewer(tester, h, id: reportId, version: 2);
      expect(h.api.downloadCalls, [(reportId: reportId, versionNo: 2)]);
      expect(find.text('PDF VIEWER STUB'), findsOneWidget);
      expect(find.byType(LimsSecureScreen), findsOneWidget, reason: 'PHI screen: screenshots blocked (REQ-SEC-109)');
      expect(find.textContaining(reportId), findsNothing);
    });

    testWidgets('while the download runs: progress "Downloading report…", no viewer, nothing on disk yet that is a finished report', (tester) async {
      final gate = Completer<void>();
      h.api.holdDownload = (_) => gate.future;
      await openViewer(tester, h);
      expect(find.text('Downloading report…'), findsOneWidget);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      gate.complete();
      await settle(tester);
      expect(find.text('Downloading report…'), findsNothing);
      expect(find.text('PDF VIEWER STUB'), findsOneWidget);
    });

    testWidgets('the bytes go to exactly one .pdf inside the secure temp dir, the viewer gets that path, and the file name carries no report id', (tester) async {
      final bytes = pdfBytes('abc');
      h.api.onDownload = (_, _, _) => bytes;
      await openViewer(tester, h);
      final files = h.tempFiles();
      expect(files, hasLength(1));
      expect(files.single.path.toLowerCase(), endsWith('.pdf'));
      expect(files.single.path.startsWith(rig.tempDir.path), isTrue, reason: 'only inside SecureTempFiles.dir');
      expect(files.single.uri.pathSegments.last, isNot(contains(reportId)), reason: 'file names are visible on the device');
      expect(files.single.readAsBytesSync(), bytes);
      expect(h.viewer.paths, [files.single.path]);
      expect(h.viewer.contentAtOpen.single, bytes, reason: 'the file is complete before the viewer opens it');
    });

    testWidgets('closing the viewer deletes the temp file and leaves A13', (tester) async {
      await openViewer(tester, h);
      expect(h.tempFiles(), hasLength(1));
      await tester.tap(find.text('Close viewer'));
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
      expect(find.byType(ReportViewerScreen), findsNothing);
      expect(find.text('Open report'), findsOneWidget);
    });

    testWidgets('system back deletes the temp file too', (tester) async {
      await openViewer(tester, h);
      expect(h.tempFiles(), hasLength(1));
      await tester.pageBack();
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
      expect(find.byType(ReportViewerScreen), findsNothing);
    });

    testWidgets('logout while the viewer is open deletes the temp file (US-EN-08.6, US-EN-02.5); the screen does not crash', (tester) async {
      await rig.signIn();
      await openViewer(tester, h);
      expect(h.tempFiles(), hasLength(1));
      await tester.runAsync(() => rig.controller.logout());
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leaving A13 before the download finished leaves NO file behind when the bytes arrive late', (tester) async {
      final gate = Completer<void>();
      h.api.holdDownload = (_) => gate.future;
      await openViewer(tester, h, waitForIt: false);
      await tester.pump(const Duration(milliseconds: 400)); // ruling: finish route transition, no real IO, download stays pending
      await tester.pageBack();
      await settle(tester);
      gate.complete();
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
      expect(h.viewer.paths, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('opening the same report again downloads again and writes a fresh file (no cached copy, REQ-SEC-103); each close empties the dir', (tester) async {
      await openViewer(tester, h);
      await tester.tap(find.text('Close viewer'));
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
      await tester.tap(find.text('Open report'));
      await tester.pump(const Duration(milliseconds: 10));
      await settle(tester);
      expect(h.api.downloadCalls, hasLength(2));
      expect(h.tempFiles(), hasLength(1));
      await tester.tap(find.text('Close viewer'));
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('the temp file is removed even if it vanished already (logout wipe then close): no exception', (tester) async {
      await openViewer(tester, h);
      h.tempFiles().single.deleteSync();
      await tester.tap(find.text('Close viewer'));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(h.tempFiles(), isEmpty);
    });
  });

  group('Save / Share only after an explicit confirmation (US-EN-08.6)', () {
    testWidgets('tapping Share/Save shows the confirmation dialog with the spec text and [Save] [Cancel]; nothing is shared yet', (tester) async {
      await openViewer(tester, h);
      await tester.tap(shareControl());
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text(saveWarning), findsOneWidget);
      expect(inDialog('Save'), findsOneWidget);
      expect(inDialog('Cancel'), findsOneWidget);
      expect(h.sharer.shared, isEmpty);
    });

    testWidgets('Cancel: nothing leaves the app, the report stays open and its temp file stays until close', (tester) async {
      await openViewer(tester, h);
      await tester.tap(shareControl());
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(inDialog('Cancel'));
      await settle(tester);
      expect(h.sharer.shared, isEmpty);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('PDF VIEWER STUB'), findsOneWidget);
      expect(h.tempFiles(), hasLength(1));
    });

    testWidgets('dismissing the dialog by tapping outside is NOT a confirmation', (tester) async {
      await openViewer(tester, h);
      await tester.tap(shareControl());
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tapAt(const Offset(2, 2));
      await settle(tester);
      expect(find.byType(AlertDialog), findsNothing);
      expect(h.sharer.shared, isEmpty);
    });

    testWidgets('Save: the sharer gets the temp file path exactly once; closing afterwards still deletes the temp file', (tester) async {
      await openViewer(tester, h);
      final path = h.tempFiles().single.path;
      await tester.tap(shareControl());
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(inDialog('Save'));
      await settle(tester);
      expect(h.sharer.shared, [path]);
      await tester.tap(find.text('Close viewer'));
      await settle(tester);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('the dialog is asked again on every share (consent is not remembered)', (tester) async {
      await openViewer(tester, h);
      for (var i = 0; i < 2; i++) {
        await tester.tap(shareControl());
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.text(saveWarning), findsOneWidget, reason: 'round $i');
        await tester.tap(inDialog('Cancel'));
        await settle(tester);
      }
      expect(h.sharer.shared, isEmpty);
    });

    testWidgets('no Share/Save control while there is nothing to share (download failed)', (tester) async {
      h.api.onDownload = (_, _, _) => throw LimsException(LimsErrorCodes.commonInternal);
      await openViewer(tester, h);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      expect(shareControlAny(), findsNothing);
    });
  });

  group('errors (03-APP-FLOW §11 A13): no viewer, no file, no server detail, retry works', () {
    Future<void> failWith(WidgetTester tester, LimsException e) async {
      h.api.onDownload = (call, _, _) => call == 1 ? throw e : pdfBytes();
      await openViewer(tester, h);
    }

    testWidgets('503 common.dependency_unavailable: "The report can\'t be downloaded right now"', (tester) async {
      await failWith(tester, LimsException(LimsErrorCodes.commonDependencyUnavailable, safeDetail: 'storage password hunter2'));
      expect(find.textContaining("The report can't be downloaded right now"), findsOneWidget);
      expect(find.textContaining('hunter2'), findsNothing);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('integrity / generic failure (common.internal): "Download failed"', (tester) async {
      await failWith(tester, LimsException(LimsErrorCodes.commonInternal, safeDetail: 'sha256 mismatch deadbeef'));
      expect(find.textContaining('Download failed'), findsOneWidget);
      expect(find.textContaining('deadbeef'), findsNothing);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('429 common.rate_limited (21st download in an hour): an error message, no viewer, no file', (tester) async {
      await failWith(tester, LimsException(LimsErrorCodes.commonRateLimited));
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('404 common.not_found: an error message, no viewer, no file', (tester) async {
      await failWith(tester, LimsException(LimsErrorCodes.commonNotFound));
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.text('PDF VIEWER STUB'), findsNothing);
      expect(h.tempFiles(), isEmpty);
    });

    testWidgets('Retry downloads again and then shows the viewer with ONE file', (tester) async {
      await failWith(tester, LimsException(LimsErrorCodes.commonDependencyUnavailable));
      await tester.tap(find.textContaining(RegExp('retry|try again', caseSensitive: false)));
      await tester.pump(const Duration(milliseconds: 10));
      await settle(tester);
      expect(h.api.downloadCalls, hasLength(2));
      expect(find.text('PDF VIEWER STUB'), findsOneWidget);
      expect(h.tempFiles(), hasLength(1));
    });
  });
}
