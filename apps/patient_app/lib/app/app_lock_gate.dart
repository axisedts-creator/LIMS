// US-EN-02.4 / REQ-SEC-110: after > 300 s in the background PHI is hidden until the device biometric/PIN succeeds;
// a device with no screen lock cannot be unlocked, so the patient must sign in again with a new OTP.
import 'package:flutter/widgets.dart';
import 'package:local_auth/local_auth.dart';
import 'package:lims_ui/lims_ui.dart';

import '../core/lifecycle/background_timer.dart';

abstract interface class DeviceAuth {
  Future<bool> isDeviceSecure();
  Future<bool> authenticate();
}

/// local_auth-backed [DeviceAuth] (CR-C16-017).
class LocalDeviceAuth implements DeviceAuth {
  LocalDeviceAuth({LocalAuthentication? auth, this.reason = 'Unlock to continue'}) : _auth = auth ?? LocalAuthentication();

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
  });

  final BackgroundTimer timer;
  final DeviceAuth deviceAuth;
  final VoidCallback onSignInRequired;
  final Widget child;

  @override
  State<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends State<AppLockGate> with WidgetsBindingObserver {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => widget.timer.onLifecycle(state);

  Future<void> _unlock() async {
    if (_busy) return;
    _busy = true;
    try {
      if (!await widget.deviceAuth.isDeviceSecure()) {
        widget.onSignInRequired();
        return;
      }
      if (await widget.deviceAuth.authenticate()) widget.timer.unlock();
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: widget.timer.locked,
        // Offstage on top of the lims_ui gate: while locked the PHI subtree keeps its state but is not painted, hit-tested
        // or exposed to accessibility/screen capture.
        builder: (_, locked, child) => LimsAppLockGate(
          isLocked: locked,
          onUnlockRequested: _unlock,
          child: Offstage(offstage: locked, child: child),
        ),
        child: widget.child,
      );
}
