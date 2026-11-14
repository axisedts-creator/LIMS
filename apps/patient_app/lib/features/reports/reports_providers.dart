import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import 'reports_api.dart';

/// Screens keep report data in widget state only (never persisted, TRD §3.5): leaving the screen or logging out drops it.
final patientReportsApiProvider = Provider<PatientReportsApi>((ref) => TransportPatientReportsApi(transport: ref.watch(transportProvider)));

/// The ONLY way a report leaves the app (Save / Share); called only after the confirmation dialog (US-EN-08.6).
abstract interface class ReportSharer {
  Future<void> share(String filePath);
}

/// [CONV] No share dependency is in pubspec yet (CR in .orchestra/cr/T-P3.md): the default refuses, the screen shows a fixed message.
class UnavailableReportSharer implements ReportSharer {
  const UnavailableReportSharer();

  @override
  Future<void> share(String filePath) => Future<void>.error(UnsupportedError('share'));
}

final reportSharerProvider = Provider<ReportSharer>((_) => const UnavailableReportSharer());

/// Test seam: flutter_pdfview is a platform view.
final reportViewerBuilderProvider = Provider<Widget Function(String filePath, VoidCallback onClose)>(
  (_) => (filePath, onClose) => LimsPdfViewer(filePath: filePath, onClose: onClose),
);
