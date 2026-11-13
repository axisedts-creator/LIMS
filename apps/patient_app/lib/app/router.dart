// Routes come from contracts/routes.yaml ids via lims_shared (`patient_app.*`); never hand-typed (02-TRD §3.5).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../core/session/session_controller.dart';
import '../features/auth/sign_in_flow.dart';
import 'update_required_screen.dart';

const kSignInPath = '/sign-in'; // A0–A4 live under it (T-A4)
const kUpdateRequiredPath = '/update-required'; // A1
const kHomePath = '/';

/// `/orders/{order_id}` -> `/orders/:order_id` for every `patient_app.*` id.
final List<String> patientRoutePatterns = [
  for (final e in limsRoutePaths.entries)
    if (e.key.startsWith('patient_app.')) e.value.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => ':${m[1]}'),
];

/// null = stay. 426 wins over everything; signed-out users reach only the sign-in area (deep links to PHI go there).
String? patientRedirect({required bool updateRequired, required SessionStatus status, required String location}) {
  if (updateRequired) return location == kUpdateRequiredPath ? null : kUpdateRequiredPath;
  final signedIn = status == SessionStatus.signedIn;
  if (location == kUpdateRequiredPath) return signedIn ? kHomePath : kSignInPath;
  final inSignIn = location == kSignInPath || location.startsWith('$kSignInPath/');
  if (!signedIn) return inSignIn ? null : kSignInPath;
  return inSignIn ? kHomePath : null;
}

GoRouter buildPatientRouter({
  required SessionController session,
  required ValueListenable<bool> updateRequired,
  required Uri storeUrl,
  required Future<void> Function(Uri url) openUrl,
}) {
  // Feature screens arrive with T-A4/T-P*; every PHI screen is already wrapped in LimsSecureScreen (REQ-SEC-109).
  Widget phi(String title) => LimsSecureScreen(child: Scaffold(body: Center(child: Text(title))));
  return GoRouter(
    initialLocation: kHomePath,
    refreshListenable: Listenable.merge([session.status, updateRequired]),
    redirect: (_, state) => patientRedirect(
      updateRequired: updateRequired.value,
      status: session.status.value,
      location: state.uri.path,
    ),
    routes: [
      GoRoute(path: kHomePath, builder: (_, _) => phi('Home')),
      GoRoute(path: kSignInPath, builder: (_, _) => const SignInFlow()), // A0 -> A2 -> A3 (T-A4)
      GoRoute(path: kUpdateRequiredPath, builder: (_, _) => UpdateRequiredScreen(storeUrl: storeUrl, openUrl: openUrl)),
      for (final p in patientRoutePatterns) GoRoute(path: p, builder: (_, _) => phi(p)),
    ],
  );
}
