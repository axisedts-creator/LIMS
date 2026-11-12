// HC-T21: router skeleton. Paths come verbatim from limsRoutePaths (routes.yaml); screens arrive in later HC tasks.
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_shared/lims_shared.dart';

import 'routes.dart';

String _colon(String tpl) => tpl.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => ':${m[1]}');

String _today() {
  final n = DateTime.now();
  return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
}

// Placeholder screen: deliberately renders nothing from the URL (no PHI / unvalidated input on screen).
Widget _placeholder(String id) => Scaffold(body: Center(child: Text(id)));

GoRouter buildRouter() => GoRouter(
      initialLocation: phleboRouteLocation(_today()),
      routes: [
        GoRoute(path: _colon(limsRoutePaths['phlebo_app.route']!), builder: (_, __) => _placeholder('phlebo_app.route')),
        GoRoute(path: _colon(limsRoutePaths['phlebo_app.visit']!), builder: (_, __) => _placeholder('phlebo_app.visit')),
      ],
    );
