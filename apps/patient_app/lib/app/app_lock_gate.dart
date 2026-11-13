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
  bool _noScreenLock = false; // waiting for the sign-in fallback: no button

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.timer.locked.addListener(_onLockChanged);
  }

  @override
  void dispose() {
    widget.timer.locked.removeListener(_onLockChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // One prompt per lock, requested by LimsAppLockGate; later prompts come from [Try again].
  void _onLockChanged() {
    if (!widget.timer.locked.value) {
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

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: widget.timer.locked,
        // Kit LimsAppLockGate (04-UI-UX A4, CR16) with [Try again]; it requests the first prompt of each lock. The PHI
        // subtree is also Offstage while locked: state kept, not painted, hit-tested or exposed to accessibility.
        // Lock-out copy: the kit gate has no message slot (CR .orchestra/cr/T-A4.md), so after 3 failures the gate is
        // taken offstage (no button) and the kit LimsEmptyState shows "Locked. Open the app again later." over it.
        // No device screen lock: same, without copy, until the sign-in fallback takes over.
        builder: (context, locked, child) {
          final show = locked && widget.enabled();
          final lockedOut = show && _lockedOut;
          final noButton = lockedOut || (show && _noScreenLock);
          return Stack(fit: StackFit.expand, children: [
            Offstage(
              offstage: noButton,
              child: LimsAppLockGate(
                isLocked: show,
                onUnlockRequested: _unlock,
                unlockLabel: 'Try again',
                child: Offstage(offstage: show, child: child),
              ),
            ),
            if (noButton)
              Positioned.fill(
                child: ColoredBox(
                  color: Theme.of(context).colorScheme.surface,
                  child: lockedOut ? const LimsEmptyState(icon: Icons.lock, title: 'Locked. Open the app again later.') : null,
                ),
              ),
          ]);
        },
        child: widget.child,
      );
}
