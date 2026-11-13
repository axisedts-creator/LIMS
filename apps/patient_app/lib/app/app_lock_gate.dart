// US-EN-02.4 / REQ-SEC-110, 04-UI-UX A4: after > 300 s in the background PHI is hidden until the device biometric/PIN succeeds;
// a device with no screen lock cannot be unlocked, so the patient must sign in again with a new OTP.
// A4 copy: prompt reason "Confirm it's you to view your health records", [Try again], and after 3 failures
// "Locked. Open the app again later." (no button, no more prompts until the app is opened again).
import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';
import 'package:lims_ui/lims_ui.dart';

import '../core/lifecycle/background_timer.dart';

abstract interface class DeviceAuth {
  Future<bool> isDeviceSecure();
  Future<bool> authenticate();
}

/// local_auth-backed [DeviceAuth] (CR-C16-017).
class LocalDeviceAuth implements DeviceAuth {
  LocalDeviceAuth({LocalAuthentication? auth, this.reason = "Confirm it's you to view your health records"})
      : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;
  final String reason;

  @override
  Future<bool> isDeviceSecure() => _auth.isDeviceSupported();

  @override
  Future<bool> authenticate() async {
    try {
      return await _auth.authenticate(localizedReason: reason);
    } catch (_) {
      return false; // cancelled, locked out, plugin error: stay locked
    }
  }
}

class AppLockGate extends StatefulWidget {
  const AppLockGate({
    super.key,
    required this.timer,
    required this.deviceAuth,
    required this.onSignInRequired,
    required this.child,
    this.enabled = _always,
  });

  static bool _always() => true;

  final BackgroundTimer timer;
  final DeviceAuth deviceAuth;
  final VoidCallback onSignInRequired;
  final Widget child;

  /// False while signed out: A2/A3 are not PHI, so nothing is locked and no prompt is shown.
  final bool Function() enabled;

  @override
  State<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends State<AppLockGate> with WidgetsBindingObserver {
  static const _maxFailures = 3;

  bool _busy = false;
  int _failures = 0;
  bool _lockedOut = false; // 3 failures in this lock: no button, no prompts
  bool _noScreenLock = false; // waiting for the sign-in fallback

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.timer.locked.addListener(_onLockChanged);
    if (widget.timer.locked.value) _requestUnlock();
  }

  @override
  void dispose() {
    widget.timer.locked.removeListener(_onLockChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // One prompt per lock; later prompts come from [Try again].
  void _onLockChanged() {
    if (widget.timer.locked.value) {
      _requestUnlock();
    } else {
      _failures = 0;
      _lockedOut = false;
      _noScreenLock = false;
    }
  }

  void _requestUnlock() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.timer.locked.value && widget.enabled()) _unlock();
      });

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.timer.onLifecycle(state);
    if (state != AppLifecycleState.resumed) return;
    if (!widget.enabled()) {
      widget.timer.unlock(); // signed out: nothing to protect
    } else if (_lockedOut && widget.timer.locked.value) {
      // "Open the app again later": opening it again starts a fresh set of tries.
      setState(() {
        _failures = 0;
        _lockedOut = false;
      });
      _requestUnlock();
    }
  }

  Future<void> _unlock() async {
    if (_busy || _lockedOut) return;
    _busy = true;
    try {
      if (!await widget.deviceAuth.isDeviceSecure()) {
        if (mounted) setState(() => _noScreenLock = true);
        widget.onSignInRequired();
        return;
      }
      if (await widget.deviceAuth.authenticate()) {
        _failures = 0;
        widget.timer.unlock();
      } else if (mounted && ++_failures >= _maxFailures) {
        setState(() => _lockedOut = true);
      } else if (mounted) {
        setState(() {}); // keep [Try again] in step with the count
      }
    } finally {
      _busy = false;
    }
  }

  Widget _lockScreen(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(LimsTokens.space4),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.lock, size: LimsTokens.space8),
            const SizedBox(height: LimsTokens.space4),
            if (_lockedOut)
              Text('Locked. Open the app again later.', style: t.titleMedium, textAlign: TextAlign.center)
            else if (!_noScreenLock)
              LimsButton(label: 'Try again', onPressed: _unlock),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: widget.timer.locked,
        // Offstage under an opaque lock screen: while locked the PHI subtree keeps its state but is not painted,
        // hit-tested or exposed to accessibility/screen capture.
        builder: (_, locked, child) {
          final show = locked && widget.enabled();
          return Stack(fit: StackFit.expand, children: [
            Offstage(offstage: show, child: child),
            if (show) Positioned.fill(child: _lockScreen(context)),
          ]);
        },
        child: widget.child,
      );
}
