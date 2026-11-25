import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../ui/phlebo_theme.dart';

class PhleboApp extends StatelessWidget {
  const PhleboApp({super.key, required this.router});

  final GoRouter router;

  @override
  Widget build(BuildContext context) => MaterialApp.router(
        title: 'LIMS Phlebo',
        theme: PhleboTheme.light(),
        routerConfig: router,
      );
}
