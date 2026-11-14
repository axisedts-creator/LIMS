import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/providers.dart';
import 'payments_api.dart';

/// Payment state lives in widget state only (never persisted, TRD §3.5).
final patientPaymentsApiProvider = Provider<PatientPaymentsApi>((ref) => TransportPatientPaymentsApi(transport: ref.watch(transportProvider)));

/// Opens the gateway in the SYSTEM browser (never an in-app view); tests record the Uri.
final paymentUrlOpenerProvider = Provider<Future<void> Function(Uri url)>(
  (_) => (u) => launchUrl(u, mode: LaunchMode.externalApplication),
);
