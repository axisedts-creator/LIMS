// T-PAY1 test support: fake payments API (E41 / E42 wire bodies as plain JSON maps), PaymentRequest fixtures, screen host. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/payments/payments_api.dart
//     abstract interface class PatientPaymentsApi {
//       Future<Object?> createPaymentRequest({required String orderId, required String gateway, required String idempotencyKey});  // E41 -> decoded PaymentRequest (202, or 200 for the open one). NO amount parameter (REQ-SEC-046)
//       Future<Object?> getPaymentRequest({required String paymentRequestId});                                                      // E42 -> decoded PaymentRequest
//     }                                                                                                                              // both throw LimsException
//   lib/features/payments/payments_providers.dart
//     patientPaymentsApiProvider  (Provider<PatientPaymentsApi>)
//     paymentUrlOpenerProvider    (Provider<Future<void> Function(Uri url)>)   = opens the SYSTEM browser (url_launcher in prod); tests record the Uri
//   lib/features/payments/pay_due_screen.dart        PayDueScreen({required String orderId, required int amountPaisa, required List<String> gateways})
//        = A15 start: amount (read-only text "Rs. 2,250.00"), LimsSegmentedControl over the offered gateways ("eSewa", "Khalti"), ONE primary [Continue]; E41; polls E42 every 2 s up to 30 s while queued
//          ("Preparing payment…" -> "Opening eSewa…" / "Opening Khalti…"); on ready opens action.url ONCE through the opener; failed -> the mapped text of 03-APP-FLOW §10.1.
//   lib/features/payments/payment_result_screen.dart PaymentResultScreen({required String paymentRequestId, Uri? returnUri})
//        = A15 result (app link /payments/{payment_request_id}/done?intent_id&outcome): polls E42 every 3 s up to 60 s; the returnUri is NEVER read for a result (REQ-SEC-059).
//          completed -> "Paid — thank you"; failed / expired -> "Payment not completed" [Try again]; review or 60 s without a result -> "We are confirming your payment. This can take a few minutes." [Check again] (one more E42).
//   Both screens: LimsSecureScreen (REQ-SEC-109), LimsStatusChip for status, no hex colours / pixel radii / inline styles (LD-140).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/payments/pay_due_screen.dart';
import 'package:patient_app/features/payments/payment_result_screen.dart';
import 'package:patient_app/features/payments/payments_api.dart';
import 'package:patient_app/features/payments/payments_providers.dart';

import 'auth_fakes.dart';
import 'rig.dart';

const payOrderId = '01950c16-0000-7000-8000-000000000b01';
const payId = '01950c16-0000-7000-8000-000000000b02';
const secretToken = 'SECRET-TOKEN-4f9c2a';
const khaltiUrl = 'https://pay.invalid/khalti/$secretToken';
const esewaUrl = 'https://portal.invalid/launch/$secretToken';

/// A PaymentRequest as E41 / E42 return it (OpenAPI PaymentRequest; no intent id, no account / patient id).
Map<String, Object?> pr(
  String status, {
  String gateway = 'khalti',
  bool review = false,
  String? failureCode,
  String? url,
}) =>
    {
      'id': payId,
      'order_id': payOrderId,
      'gateway': gateway,
      'status': status,
      'review': review,
      if (status == 'ready' || status == 'completed') 'amount': {'amount_paisa': 225000, 'currency': 'NPR'},
      if (status == 'ready') 'action': {'kind': gateway == 'khalti' ? 'redirect' : 'form_post', 'url': url ?? (gateway == 'khalti' ? khaltiUrl : esewaUrl)},
      if (status == 'ready') 'expires_at': '2026-03-01T04:30:00.000Z',
      if (failureCode != null) 'failure_code': failureCode,
    };

class FakePaymentsApi implements PatientPaymentsApi {
  /// Answers E41 call n (1-based): decoded body or throws.
  Object? Function(int call, String gateway, String key) onCreate = (_, g, _) => pr('queued', gateway: g);
  /// Answers E42 call n (1-based).
  Object? Function(int call) onGet = (_) => pr('queued');
  /// Awaited before E41 call n answers.
  Future<void>? Function(int call)? holdCreate;

  final List<({String orderId, String gateway, String key})> createCalls = [];
  final List<String> getCalls = [];

  @override
  Future<Object?> createPaymentRequest({required String orderId, required String gateway, required String idempotencyKey}) async {
    createCalls.add((orderId: orderId, gateway: gateway, key: idempotencyKey));
    final call = createCalls.length;
    final h = holdCreate?.call(call);
    if (h != null) await h;
    return onCreate(call, gateway, idempotencyKey);
  }

  @override
  Future<Object?> getPaymentRequest({required String paymentRequestId}) async {
    getCalls.add(paymentRequestId);
    return onGet(getCalls.length);
  }
}

Widget paymentsScope(Rig rig, FakePaymentsApi api, List<Uri> opened, {required Widget home}) => ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(alphaFlavour()),
        sessionControllerProvider.overrideWithValue(rig.controller),
        patientPaymentsApiProvider.overrideWithValue(api),
        paymentUrlOpenerProvider.overrideWithValue((Uri u) async => opened.add(u)),
      ],
      child: MaterialApp(theme: LimsTheme.light(), home: home),
    );

Future<void> openPay(WidgetTester tester, Rig rig, FakePaymentsApi api, List<Uri> opened, {List<String> gateways = const ['esewa', 'khalti']}) async {
  await tester.pumpWidget(paymentsScope(rig, api, opened, home: PayDueScreen(orderId: payOrderId, amountPaisa: 225000, gateways: gateways)));
  await tester.pump(const Duration(milliseconds: 10));
}

Future<void> openResult(WidgetTester tester, Rig rig, FakePaymentsApi api, List<Uri> opened, {Uri? returnUri}) async {
  await tester.pumpWidget(paymentsScope(rig, api, opened, home: PaymentResultScreen(paymentRequestId: payId, returnUri: returnUri)));
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

/// Advances fake time in 1 s steps so every timer due inside the span fires and its futures complete.
Future<void> tick(WidgetTester tester, Duration d) async {
  for (var i = 0; i < d.inSeconds; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}
