// 04-UI-UX A1 "Update required" (US-EN-20.1): one action, no back, no navigation.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

class UpdateRequiredScreen extends StatelessWidget {
  const UpdateRequiredScreen({super.key, required this.storeUrl, required this.openUrl});

  final Uri storeUrl;
  final Future<void> Function(Uri url) openUrl;

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        child: Scaffold(
          body: SafeArea(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text('Update required', style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 12),
                  const Text('This version of the app is no longer supported. Please update to continue.', textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  LimsButton(label: 'Open store', onPressed: () => openUrl(storeUrl)),
                ]),
              ),
            ),
          ),
        ),
      );
}
