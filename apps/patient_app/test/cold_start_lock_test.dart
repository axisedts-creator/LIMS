// T-A1 review item 2 — REQ-SEC-110 / US-EN-02.4: the background clock is in memory only, so a process killed while
// backgrounded must come back LOCKED when a session token is stored (fail closed on cold start). Synthetic data only.
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/app/app.dart';
import 'package:patient_app/app/app_lock_gate.dart';
import 'package:patient_app/app/flavour.dart';
import 'package:patient_app/app/providers.dart';

import 'support/rig.dart';

class _Auth implements DeviceAuth {
  int prompts = 0;
  @override
  Future<bool> isDeviceSecure() async => true;
  @override
  Future<bool> authenticate() async {
    prompts++;
    return false; // cancelled: PHI must stay hidden
  }
}

const _flavour = Flavour(
  env: 'dev',
  tenantCode: 'demo_lab',
  displayName: 'Patient (test)',
  apiBaseUrl: 'https://api.invalid',
  portalOrigin: 'https://portal.invalid',
  storeUrl: 'https://store.invalid/app',
);

void main() {
  late Rig rig;
  late _Auth auth;

  setUp(() async {
    rig = await Rig.create();
    auth = _Auth();
  });
  tearDown(() => rig.dispose());

  Future<ProviderContainer> boot(WidgetTester tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(_flavour),
        sessionControllerProvider.overrideWithValue(rig.controller),
        deviceAuthProvider.overrideWithValue(auth),
      ],
      child: const PatientApp(),
    ));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    return ProviderScope.containerOf(tester.element(find.byType(PatientApp)));
  }

  testWidgets('stored session token at startup: app is locked and the device prompt is required', (tester) async {
    await rig.store.write(tok('S0'));
    final c = await boot(tester);
    expect(c.read(backgroundTimerProvider).locked.value, isTrue);
    expect(auth.prompts, greaterThanOrEqualTo(1));
  });

  testWidgets('no stored token at startup: not locked, no prompt', (tester) async {
    final c = await boot(tester);
    expect(c.read(backgroundTimerProvider).locked.value, isFalse);
    expect(auth.prompts, 0);
  });
}
