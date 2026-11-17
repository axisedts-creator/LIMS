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
              // LD-258 (M4): the content sits on a white LimsCard (450 ms enter fade) on the neutral.50 page.
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(LimsTokens.space4),
                child: LimsCard(
                  title: 'Update required',
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const Text('This version of the app is no longer supported. Please update to continue.'),
                    const SizedBox(height: LimsTokens.space6),
                    LimsButton(label: 'Open store', onPressed: () => openUrl(storeUrl)),
                  ]),
                ),
              ),
            ),
          ),
        ),
      );
}
