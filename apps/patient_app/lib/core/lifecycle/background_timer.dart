// US-EN-02.4 / REQ-SEC-110: lock the app when it was in the background for MORE than 300 s.
import 'package:flutter/widgets.dart';

class BackgroundTimer {
  BackgroundTimer({required this.now, this.threshold = const Duration(seconds: 300)});

  final DateTime Function() now;
  final Duration threshold;

  /// Sticky: only [unlock] clears it.
  final ValueNotifier<bool> locked = ValueNotifier(false);

  DateTime? _pausedAt;

  void onLifecycle(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _pausedAt ??= now(); // a repeated pause never restarts the clock
      case AppLifecycleState.resumed:
        final since = _pausedAt;
        _pausedAt = null;
        if (since == null) return;
        final away = now().difference(since);
        // Clock moved backwards (negative) fails closed.
        if (away.isNegative || away > threshold) locked.value = true;
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break; // system dialogs / the biometric prompt itself must not lock
    }
  }

  void unlock() => locked.value = false;

  void dispose() => locked.dispose();
}
