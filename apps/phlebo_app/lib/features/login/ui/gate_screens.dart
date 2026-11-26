// PHLEBO-UI-FULL-1 Part A: splash, sign in, lock gate and the device states. Screens take data and callbacks only.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';

const _tagline = 'Home collection,\nvisit by visit';
const _appTag = 'PHLEBOTOMIST APP';

class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) => const Column(mainAxisSize: MainAxisSize.min, children: [
        BrandMark(),
        SizedBox(height: LimsTokens.space3),
        Pill(_appTag),
      ]);
}

/// A01.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(
        body: BrandBackground(
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              _Brand(),
              SizedBox(height: LimsTokens.space8),
              CircularProgressIndicator(color: LimsTokens.colorAccentFg, semanticsLabel: 'Loading'),
              SizedBox(height: LimsTokens.space4),
              Text('Getting your route ready'),
            ]),
          ),
        ),
      );
}

/// A02.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.onSignIn, required this.versionLabel, this.notice, this.onApply});

  /// "Don't have a login?": opens the application form. Null hides the link.
  final VoidCallback? onApply;

  /// Null on success, else the sentence to show.
  final Future<String?> Function(String email, String password) onSignIn;
  final String versionLabel;
  final String? notice;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _ready => !_busy && _email.text.trim().isNotEmpty && _password.text.isNotEmpty;

  Future<void> _submit() async {
    if (!_ready) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.onSignIn(_email.text.trim(), _password.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
      if (error != null) _password.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final notice = _error ?? widget.notice;
    return LimsSecureScreen(
      child: Scaffold(
        body: BrandBackground(
          child: LayoutBuilder(
            builder: (context, box) => SingleChildScrollView(
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: box.maxHeight),
                child: Column(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                  SafeArea(
                    bottom: false,
                    child: Padding(
                      padding: const EdgeInsets.all(LimsTokens.space8),
                      child: Column(children: [
                        const _Brand(),
                        const SizedBox(height: LimsTokens.space4),
                        Text(_tagline, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(color: LimsTokens.colorAccentFg)),
                      ]),
                    ),
                  ),
                  Material(
                    color: LimsTokens.colorNeutral0,
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(LimsTokens.radiusXl)),
                    child: SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.all(LimsTokens.space4),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                          Semantics(header: true, child: Text('Sign in', style: t.titleLarge)),
                          const Text('Use your mobile number and the password you set.'),
                          const SizedBox(height: LimsTokens.space3),
                          if (notice != null) ...[
                            NoticeCard(tone: _error == null ? 'warning' : 'danger', text: notice),
                            const SizedBox(height: LimsTokens.space3),
                          ],
                          LimsTextField(
                            key: const ValueKey('login.email'),
                            label: 'Mobile number or email',
                            maxLength: 254,
                            sensitive: true,
                            controller: _email,
                            keyboardType: TextInputType.emailAddress,
                            onChanged: (_) => setState(() {}),
                          ),
                          LimsTextField(
                            key: const ValueKey('login.password'),
                            label: 'Password',
                            maxLength: 128,
                            sensitive: true,
                            obscureText: true,
                            controller: _password,
                            onChanged: (_) => setState(() {}),
                          ),
                          const SizedBox(height: LimsTokens.space2),
                          LimsButton(
                            key: const ValueKey('login.submit'),
                            label: _busy ? 'Signing in…' : 'Sign in',
                            onPressed: _ready ? _submit : null,
                          ),
                          if (widget.onApply != null) ...[
                            const SizedBox(height: LimsTokens.space2),
                            LimsButton(key: const ValueKey('login.apply'), label: "Don't have a login? Apply to join", secondary: true, onPressed: _busy ? null : widget.onApply),
                          ],
                          const SizedBox(height: LimsTokens.space3),
                          Text(widget.versionLabel, textAlign: TextAlign.center, style: t.bodySmall),
                        ]),
                      ),
                    ),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A brand-gradient page with one primary button (lock gate and session end).
class _GatePage extends StatelessWidget {
  const _GatePage({required this.icon, required this.title, required this.message, required this.action, this.extra});

  final IconData icon;
  final String title, message;
  final String? extra;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: BrandBackground(
        child: SizedBox.expand(
          child: Column(children: [
            Expanded(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(LimsTokens.space6),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const BrandMark(wide: false),
                    const SizedBox(height: LimsTokens.space6),
                    Icon(icon, size: LimsTokens.space12, color: LimsTokens.colorAccentFg),
                    const SizedBox(height: LimsTokens.space4),
                    Text(title, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(color: LimsTokens.colorAccentFg)),
                    const SizedBox(height: LimsTokens.space2),
                    Text(message, textAlign: TextAlign.center),
                    if (extra != null) ...[
                      const SizedBox(height: LimsTokens.space3),
                      Semantics(liveRegion: true, child: Text(extra!, style: t.titleSmall?.copyWith(color: LimsTokens.colorAccentFg))),
                    ],
                  ]),
                ),
              ),
            ),
            BottomActions(children: [action]),
          ]),
        ),
      ),
    );
  }
}

/// A03. The prompt is asked once when the page appears; the button asks again.
class LockScreen extends StatefulWidget {
  const LockScreen({super.key, required this.attemptsLeft, required this.maxAttempts, required this.onUnlock});

  final int attemptsLeft, maxAttempts;
  final Future<void> Function() onUnlock;

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _asking = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _ask());
  }

  Future<void> _ask() async {
    if (_asking || !mounted) return;
    setState(() => _asking = true);
    try {
      await widget.onUnlock();
    } finally {
      if (mounted) setState(() => _asking = false); // a failed attempt must never leave the button dead
    }
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.attemptsLeft;
    return _GatePage(
      icon: Icons.lock_outline,
      title: 'Phone locked',
      message: 'Unlock with your screen lock to continue. Your visits stay on this phone.',
      extra: left < widget.maxAttempts ? '$left ${left == 1 ? 'attempt' : 'attempts'} left' : null,
      action: LimsButton(label: 'Unlock', icon: Icons.fingerprint, onPressed: _asking ? null : _ask),
    );
  }
}

/// A03b.
class SessionEndedScreen extends StatelessWidget {
  const SessionEndedScreen({super.key, required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) => _GatePage(
        icon: Icons.lock_reset,
        title: 'Session ended',
        message: 'Too many failed attempts. Sign in again to continue.',
        action: LimsButton(label: 'Sign in again', onPressed: onSignIn),
      );
}

/// A04..A04e: a white page, an icon, an explanation and at most one action.
class DeviceStateScreen extends StatelessWidget {
  const DeviceStateScreen({
    super.key,
    required this.icon,
    required this.tone,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
    this.warning,
  });

  const DeviceStateScreen.wipePending({super.key, required int waiting, required VoidCallback onUpload})
      : icon = Icons.phonelink_erase,
        tone = 'warning',
        title = 'This phone will be erased',
        message = 'The centre asked for this phone to be wiped. Your unsent changes upload first, then all home-collection '
            'data on this phone is erased.',
        warning = '$waiting changes are not uploaded yet. Connect to the internet to keep them.',
        actionLabel = 'Upload now',
        onAction = onUpload;

  const DeviceStateScreen.wiped({super.key, required VoidCallback onSignIn})
      : icon = Icons.delete_sweep_outlined,
        tone = 'neutral',
        title = 'This phone was erased',
        message = 'All home-collection data was removed by the centre. Sign in again to set this phone up.',
        warning = null,
        actionLabel = 'Sign in again',
        onAction = onSignIn;

  const DeviceStateScreen.updateRequired({super.key})
      : icon = Icons.system_update,
        tone = 'info',
        title = 'Update the app to continue',
        message = 'This version is older than the centre allows. Get the new version from your lab administrator, then open the app again.',
        warning = null,
        actionLabel = null,
        onAction = null;

  const DeviceStateScreen.noScreenLock({super.key, required VoidCallback onRetry})
      : icon = Icons.lock_outline,
        tone = 'warning',
        title = 'Set a screen lock first',
        message = 'Set a screen lock (PIN, pattern or fingerprint) on this phone first.',
        warning = null,
        actionLabel = 'I have set it',
        onAction = onRetry;

  const DeviceStateScreen.blocked({super.key})
      : icon = Icons.gpp_bad_outlined,
        tone = 'danger',
        title = "This phone can't be used",
        message = "This phone can't be used for home collection. Ask your lab administrator.",
        warning = null,
        actionLabel = null,
        onAction = null;

  const DeviceStateScreen.misconfigured({super.key})
      : icon = Icons.error_outline,
        tone = 'danger',
        title = "The app couldn't start",
        message = 'Close the app and open it again. If this keeps happening, ask your lab administrator.',
        warning = null,
        actionLabel = null,
        onAction = null;

  final IconData icon;
  final String tone, title, message;
  final String? warning, actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Column(children: [
            Expanded(
              child: StatePage(
                icon: icon,
                tone: tone,
                title: title,
                message: message,
                children: [if (warning != null) NoticeCard(tone: 'warning', text: warning!)],
              ),
            ),
            if (actionLabel != null) BottomActions(children: [LimsButton(label: actionLabel!, onPressed: onAction)]),
          ]),
        ),
      );
}
