// T-A4 — A0 -> A2 -> A3 against the Prism mock of contracts/openapi/engagement.yaml (E1 getPatientAppConfig, E2
// requestPatientOtp). Prism validates the request path, the `X-Lims-Patient-PreAuth` header and the body against the
// contract and answers with the contract examples. Synthetic data only.
//
// Run (not part of T-A4-verify.cmd; needs a device/emulator):
//   npx @stoplight/prism-cli mock contracts/openapi/engagement.yaml -p 4010
//   cd apps/patient_app && flutter test integration_test/sign_in_prism_test.dart --dart-define PRISM_URL=http://10.0.2.2:4010
// (10.0.2.2 = host from the Android emulator; use http://127.0.0.1:4010 on desktop/iOS simulator.)
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/flavour.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/auth/sign_in_flow.dart';

const _base = String.fromEnvironment('PRISM_URL', defaultValue: 'http://127.0.0.1:4010');

/// Minimal dart:io transport for this test only (the app's real one is the generated lims_api_client, CR-C16-016/017).
/// Non-2xx bodies are 02-CV problem+json; their `code` becomes the LimsException code.
PatientTransport prismTransport(HttpClient http) => (method, path, {query, headers, body}) async {
      final uri = Uri.parse('$_base$path').replace(queryParameters: query?.map((k, v) => MapEntry(k, '$v')));
      final req = await http.openUrl(method, uri);
      headers?.forEach(req.headers.set);
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close();
      final text = await res.transform(utf8.decoder).join();
      final json = text.isEmpty ? null : jsonDecode(text);
      if (res.statusCode >= 400) {
        final code = json is Map && json['code'] is String ? json['code'] as String : 'common.internal';
        throw LimsException(code, safeDetail: 'HTTP ${res.statusCode}');
      }
      return json;
    };

/// Real HTTP: pump frames until [f] shows (A3's countdown timer means pumpAndSettle would never settle).
Future<void> pumpUntil(WidgetTester tester, Finder f) async {
  for (var i = 0; i < 100 && f.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('A0 loads E1 from Prism, A2 sends E2, A3 shows the masked number', (tester) async {
    final http = HttpClient();
    addTearDown(() => http.close(force: true));
    await tester.pumpWidget(ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(const Flavour(
          env: 'dev',
          tenantCode: 'syn_alpha',
          displayName: 'Synthetic Lab Alpha',
          apiBaseUrl: _base,
          portalOrigin: 'https://portal.invalid',
          storeUrl: 'https://store.invalid/app',
          privacyUrl: 'https://legal.invalid/privacy',
          termsUrl: 'https://legal.invalid/terms',
        )),
        innerTransportProvider.overrideWithValue(prismTransport(http)),
        externalUrlOpenerProvider.overrideWithValue((Uri _) async {}),
      ],
      child: const MaterialApp(home: SignInFlow()),
    ));
    await pumpUntil(tester, find.text('Send code'));
    expect(find.text('Send code'), findsOneWidget, reason: 'E1 answered by Prism -> A2');

    await tester.enterText(find.byType(TextField), '12345678');
    await tester.pump();
    await tester.tap(find.text('Send code'));
    await pumpUntil(tester, find.textContaining('Enter the 6-digit code sent to'));
    expect(find.textContaining('Enter the 6-digit code sent to'), findsOneWidget, reason: 'E2 202 from Prism -> A3');
    expect(find.textContaining('12345678'), findsNothing, reason: 'number is masked');
  });
}
