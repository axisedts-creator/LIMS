import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_ui/lims_ui.dart';

class PhleboApp extends StatelessWidget {
  const PhleboApp({super.key, required this.router});

  final GoRouter router;

  @override
  Widget build(BuildContext context) => MaterialApp.router(
        title: 'LIMS Phlebo',
        theme: LimsTheme.light(),
        routerConfig: router,
      );
}
