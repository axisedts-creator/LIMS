// Re-auth gate (C17 03-APP-FLOW §3, 04 A16): shown after the app was away for more than 300 s or on a cold start with a
// session. The OS prompt itself is the host's (plugin pinned by CR-C17-010); this is only the surface around it.
// 5 failures end the session (the host signs out; the screen says so).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../../ui/phlebo_theme.dart';

class LockScreen extends StatelessWidget {
  const LockScreen({
    super.key,
    required this.onUnlock,
    this.attemptsLeft,
    this.sessionEnded = false,
    this.onSignInAgain,
  });

  final VoidCallback onUnlock;

  /// Attempts left before the session ends (shown after the first failure).
  final int? attemptsLeft;

  /// 5 failures: the session is over, the only action is to sign in again.
  final bool sessionEnded;
  final VoidCallback? onSignInAgain;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: Scaffold(
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: PhleboGradients.entry),
        child: SafeArea(
          child: CustomScrollView(
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Padding(
                  padding: const EdgeInsets.all(LimsTokens.space6),
                  child: Column(
                    children: [
                      const Spacer(),
                      const PhleboBrandMark(height: LimsTokens.space16),
                      const SizedBox(height: LimsTokens.space6),
                      Container(
                        padding: const EdgeInsets.all(LimsTokens.space5),
                        decoration: BoxDecoration(
                          color: LimsTokens.colorAccentFg.withValues(
                            alpha: 0.16,
                          ),
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          sessionEnded ? Icons.lock_reset : Icons.lock_outline,
                          size: LimsTokens.space10,
                          color: LimsTokens.colorAccentFg,
                        ),
                      ),
                      const SizedBox(height: LimsTokens.space4),
                      Semantics(
                        header: true,
                        child: Text(
                          sessionEnded ? 'Session ended' : 'Phone locked',
                          style: t.headlineSmall?.copyWith(
                            color: LimsTokens.colorAccentFg,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      const SizedBox(height: LimsTokens.space2),
                      Text(
                        sessionEnded
                            ? 'Too many failed attempts. Sign in again to continue.'
                            : 'Unlock with your screen lock to continue. Your visits stay on this phone.',
                        textAlign: TextAlign.center,
                        style: t.bodyMedium?.copyWith(
                          color: LimsTokens.colorAccentFg,
                        ),
                      ),
                      if (!sessionEnded && attemptsLeft != null) ...[
                        const SizedBox(height: LimsTokens.space3),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            attemptsLeft == 1
                                ? '1 attempt left'
                                : '$attemptsLeft attempts left',
                            style: t.labelLarge?.copyWith(
                              color: LimsTokens.colorToneWarningBg,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                      const Spacer(),
                      SizedBox(
                        width: double.infinity,
                        child: sessionEnded
                            ? LimsButton(
                                label: 'Sign in again',
                                onPressed: onSignInAgain,
                              )
                            : LimsButton(
                                label: 'Unlock',
                                icon: Icons.fingerprint,
                                onPressed: onUnlock,
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      ),
    );
  }
}
