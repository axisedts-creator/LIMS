// Splash (M5 board + wireframe H11): CSS-style gradient plus the brand mark, nothing else. One progress indicator at most.
// Copy is the app's own; the board's slogan is not copied (LD-258).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../../ui/phlebo_theme.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key, this.status = 'Getting your route ready'});

  /// What the app is doing now ("Getting your route ready", "Checking this phone").
  final String status;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: Scaffold(
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: PhleboGradients.entry),
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(LimsTokens.space6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const PhleboBrandMark(
                    landscape: true,
                    height: LimsTokens.space12,
                  ),
                  const SizedBox(height: LimsTokens.space4),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: LimsTokens.space4,
                      vertical: LimsTokens.space1,
                    ),
                    decoration: BoxDecoration(
                      color: LimsTokens.colorAccentFg.withValues(alpha: 0.16),
                      borderRadius: const BorderRadius.all(
                        Radius.circular(LimsTokens.radiusFull),
                      ),
                    ),
                    child: Text(
                      'PHLEBOTOMIST APP',
                      style: t.labelMedium?.copyWith(
                        color: LimsTokens.colorAccentFg,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1,
                      ),
                    ),
                  ),
                  const SizedBox(height: LimsTokens.space10),
                  Semantics(
                    liveRegion: true,
                    label: status,
                    child: const SizedBox.square(
                      dimension: LimsTokens.space8,
                      child: CircularProgressIndicator(
                        strokeWidth: 3,
                        color: LimsTokens.colorAccentFg,
                        backgroundColor: Colors.transparent,
                      ),
                    ),
                  ),
                  const SizedBox(height: LimsTokens.space3),
                  Text(
                    status,
                    style: t.bodyMedium?.copyWith(
                      color: LimsTokens.colorAccentFg,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      ),
    );
  }
}
