// HC-T21 / PHLEBO-UI-FULL-1: router. Paths come verbatim from limsRoutePaths (routes.yaml). Without a controller (tests of
// the route table) each route renders a placeholder.
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_shared/lims_shared.dart';

import 'controller.dart';
import 'routes.dart';
import 'shell.dart';

String _colon(String tpl) => tpl.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => ':${m[1]}');

String _today() {
  final n = DateTime.now();
  return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

// Placeholder screen: deliberately renders nothing from the URL (no PHI / unvalidated input on screen).
Widget _placeholder(String id) => Scaffold(body: Center(child: Text(id)));

/// Closes every open page and dialog and goes home, so nothing of the previous user's screens comes back.
void resetNavigation(GoRouter router) {
  router.routerDelegate.navigatorKey.currentState?.popUntil((r) => r.isFirst);
  router.go('/');
}

/// The route date in the URL is never shown or trusted: Today always shows the downloaded route.
GoRouter buildRouter([AppController? controller]) {
  Widget home() => controller == null ? _placeholder('phlebo_app.route') : HomeShell(controller: controller);
  return GoRouter(
    initialLocation: phleboRouteLocation(_today()),
    errorBuilder: (_, __) => home(),
    routes: [
      GoRoute(path: '/', builder: (_, __) => home()),
      GoRoute(path: _colon(limsRoutePaths['phlebo_app.route']!), builder: (_, __) => home()),
      GoRoute(
        path: _colon(limsRoutePaths['phlebo_app.visit']!),
        // VisitHost only looks the id up in the downloaded list, so an unknown or malformed id shows "not on your list".
        builder: (_, state) => controller == null
            ? _placeholder('phlebo_app.visit')
            : VisitHost(controller: controller, visitId: state.pathParameters['visit_id'] ?? ''),
      ),
    ],
  );
}
