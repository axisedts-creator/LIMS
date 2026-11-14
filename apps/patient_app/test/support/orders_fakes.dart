// T-P2 test support: fake orders API (E20 / E21 wire bodies as plain JSON maps), order fixtures and the screen host. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/orders/orders_api.dart
//     abstract interface class PatientOrdersApi {
//       Future<Object?> listOrders({String? profileId, String? stage, String? cursor, int? limit});   // E20: decoded `{data:[PatientOrder], page:{next_cursor?, limit}}`
//       Future<Object?> getOrder({required String orderId, String? ifNoneMatch});                      // E21: decoded PatientOrderDetail, or `null` when the server answered 304 (If-None-Match = the last body's `etag`)
//     }                                                                                                 // both throw LimsException (common.not_found, common.internal, ...)
//   lib/features/orders/orders_providers.dart   patientOrdersApiProvider (Provider<PatientOrdersApi>)
//   lib/features/orders/orders_list_screen.dart  OrdersListScreen()               = A10 (no polling; pull-to-refresh)
//   lib/features/orders/order_detail_screen.dart OrderDetailScreen({required String orderId}) = A11 (polls E21 every 30 s [CONV] while the app is in the foreground and the screen is mounted)
//   Both screens: wrapped in LimsSecureScreen (REQ-SEC-109); status chips are LimsStatusChip; text from the spec (04-UI-UX A10/A11, 03-APP-FLOW §11): "No orders yet", "This order is no longer available", "Payment due", "Updated hh:mm".
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/orders/order_detail_screen.dart';
import 'package:patient_app/features/orders/orders_api.dart';
import 'package:patient_app/features/orders/orders_list_screen.dart';
import 'package:patient_app/features/orders/orders_providers.dart';

import 'auth_fakes.dart';
import 'rig.dart';

const orderId = '01950c16-0000-7000-8000-000000000a01';
const profileId = '01950c16-0000-7000-8000-000000000a02';

/// A PatientOrderDetail as the API returns it. `etag` is the quoted `"<version>.<max seq>.<reports>"` string.
Map<String, Object?> detail({
  String id = orderId,
  String stage = 'sample_collected',
  String etag = '"1.1.0"',
  List<Map<String, Object?>>? specimens,
  bool paymentDue = false,
  int reports = 0,
}) =>
    {
      'order_id': id,
      'profile_id': profileId,
      'registered_at': '2026-03-01T04:15:00.000Z',
      'stage': stage,
      'payment_due': paymentDue,
      if (paymentDue) 'balance_due': {'amount_paisa': 225000, 'currency': 'NPR'},
      'specimen_count': (specimens ?? _oneSpecimen).length,
      'report_count': reports,
      'centre_display_name': 'Synthetic Centre A',
      'specimens': specimens ?? _oneSpecimen,
      'reports': <Object?>[],
      'etag': etag,
    };

final List<Map<String, Object?>> _oneSpecimen = [
  {'specimen_ref': 1, 'stage': 'sample_collected', 'collected_at': '2026-03-01T04:30:00.000Z'},
];

/// The same order once the lab received the sample: stage in_lab, new ETag.
Map<String, Object?> detailInLab({String etag = '"2.2.0"'}) => detail(stage: 'in_lab', etag: etag, specimens: [
      {'specimen_ref': 1, 'stage': 'in_lab', 'collected_at': '2026-03-01T04:30:00.000Z', 'received_at': '2026-03-01T05:10:00.000Z'},
    ]);

Map<String, Object?> listed(String id, String stage, {bool paymentDue = false, int reports = 0}) => {
      'order_id': id,
      'profile_id': profileId,
      'registered_at': '2026-03-01T04:15:00.000Z',
      'stage': stage,
      'payment_due': paymentDue,
      if (paymentDue) 'balance_due': {'amount_paisa': 225000, 'currency': 'NPR'},
      'specimen_count': 1,
      'report_count': reports,
      'centre_display_name': 'Synthetic Centre A',
    };

class FakeOrdersApi implements PatientOrdersApi {
  /// Answers E21 call n (1-based) with the decoded body, `null` (= 304) or throws. Default: always the same body.
  Object? Function(int call, String? ifNoneMatch) onGet = (_, _) => detail();
  /// Answers E20 call n.
  Object? Function(int call) onList = (_) => {'data': <Object?>[], 'page': {'limit': 50}};
  /// Awaited before E21 call n answers (holds a request in flight).
  Future<void>? Function(int call)? holdGet;

  final List<({String orderId, String? ifNoneMatch})> getCalls = [];
  final List<({String? profileId, String? stage, String? cursor, int? limit})> listCalls = [];
  int inFlight = 0;
  int maxInFlight = 0;

  @override
  Future<Object?> getOrder({required String orderId, String? ifNoneMatch}) async {
    getCalls.add((orderId: orderId, ifNoneMatch: ifNoneMatch));
    final call = getCalls.length;
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      final h = holdGet?.call(call);
      if (h != null) await h;
      return onGet(call, ifNoneMatch);
    } finally {
      inFlight--;
    }
  }

  @override
  Future<Object?> listOrders({String? profileId, String? stage, String? cursor, int? limit}) async {
    listCalls.add((profileId: profileId, stage: stage, cursor: cursor, limit: limit));
    return onList(listCalls.length);
  }
}

Widget ordersScope(Rig rig, FakeOrdersApi api, {required Widget home}) => ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(alphaFlavour()),
        sessionControllerProvider.overrideWithValue(rig.controller),
        patientOrdersApiProvider.overrideWithValue(api),
      ],
      child: MaterialApp(theme: LimsTheme.light(), home: home),
    );

/// Mounts A11 and lets the first fetch land (no pumpAndSettle: the poll timer never settles).
Future<void> openDetail(WidgetTester tester, Rig rig, FakeOrdersApi api, {String id = orderId}) async {
  await tester.pumpWidget(ordersScope(rig, api, home: OrderDetailScreen(orderId: id)));
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

Future<void> openList(WidgetTester tester, Rig rig, FakeOrdersApi api) async {
  await tester.pumpWidget(ordersScope(rig, api, home: const OrdersListScreen()));
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

/// Advances fake time in 1 s steps so every timer due inside the span fires and its futures complete.
Future<void> elapse(WidgetTester tester, Duration d) async {
  for (var i = 0; i < d.inSeconds; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}
