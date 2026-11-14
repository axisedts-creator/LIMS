import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import 'smart_summary_api.dart';

/// The summary lives in A14 widget state only (never persisted, TRD §3.5).
final patientSmartSummaryApiProvider = Provider<PatientSmartSummaryApi>((ref) => TransportPatientSmartSummaryApi(transport: ref.watch(transportProvider)));
