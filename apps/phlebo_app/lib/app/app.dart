import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'theme.dart';

class PhleboApp extends StatelessWidget {
  const PhleboApp({super.key, required this.router, this.gate});

  final GoRouter router;

  /// Wraps every page (sign-in, lock and device states sit above the router).
  final Widget Function(Widget child)? gate;

  @override
  Widget build(BuildContext context) => MaterialApp.router(
        title: 'LIMS Phlebo',
        theme: phleboTheme(),
        routerConfig: router,
        builder: gate == null ? null : (context, child) => gate!(child ?? const SizedBox.shrink()),
      );
}
