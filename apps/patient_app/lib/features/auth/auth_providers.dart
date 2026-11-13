import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/providers.dart';
import 'patient_auth_api.dart';

final patientAuthApiProvider = Provider<PatientAuthApi>((ref) => TransportPatientAuthApi(
      transport: ref.watch(transportProvider),
      tenantCode: ref.watch(flavourProvider).tenantCode,
      platform: Platform.isIOS ? 'ios' : 'android',
    ));

/// LD-28: legal links open in the system browser, never inside the app.
final externalUrlOpenerProvider = Provider<Future<void> Function(Uri)>(
  (_) => (u) => launchUrl(u, mode: LaunchMode.externalApplication),
);
