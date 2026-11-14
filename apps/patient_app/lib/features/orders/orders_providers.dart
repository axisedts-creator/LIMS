import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import 'orders_api.dart';

/// Screens keep order data in widget state only (never persisted, TRD §3.5): leaving the screen or logging out drops it.
final patientOrdersApiProvider = Provider<PatientOrdersApi>((ref) => TransportPatientOrdersApi(transport: ref.watch(transportProvider)));
