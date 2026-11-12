import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_lock_gate.dart';
import 'providers.dart';
import 'router.dart';

class PatientApp extends ConsumerStatefulWidget {
  const PatientApp({super.key});

  @override
  ConsumerState<PatientApp> createState() => _PatientAppState();
}

class _PatientAppState extends ConsumerState<PatientApp> {
  late final GoRouter _router;

  @override
  void initState() {
    super.initState();
    final session = ref.read(sessionControllerProvider);
    _router = buildPatientRouter(
      session: session,
      updateRequired: ref.read(updateRequiredProvider),
      storeUrl: Uri.parse(ref.read(flavourProvider).storeUrl),
      openUrl: (u) => launchUrl(u, mode: LaunchMode.externalApplication),
    );
    session.restore();
  }

  @override
  void dispose() {
    _router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.read(sessionControllerProvider);
    final timer = ref.read(backgroundTimerProvider);
    return MaterialApp.router(
      title: ref.read(flavourProvider).displayName,
      theme: LimsTheme.light(),
      routerConfig: _router,
      builder: (_, child) => AppLockGate(
        timer: timer,
        deviceAuth: ref.read(deviceAuthProvider),
        // No device screen lock: fall back to a fresh OTP sign-in (US-EN-02.4).
        onSignInRequired: () async {
          await session.logout().then<void>((_) {}, onError: (_) {});
          timer.unlock();
        },
        child: child!,
      ),
    );
  }
}
