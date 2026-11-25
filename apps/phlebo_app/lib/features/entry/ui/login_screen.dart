// M1 Sign in (C17 04-UI-UX §3.1) in the M1/M5 entry look: gradient hero, white sheet, one lime primary button.
// The screen holds no credentials beyond the two text controllers and never logs them. Every message below is the spec's
// copy (03-APP-FLOW §3 Login row, 04-UI-UX §3.1); the outcome comes from the host so this screen stays testable offline.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../../ui/phlebo_theme.dart';

enum LoginOutcome {
  ok,
  badCredentials,
  rateLimited,
  locked,
  noScreenLock,
  rooted,
  updateRequired,
  otherUserUnsent,
  rebind,
  failed,
}

String loginMessage(LoginOutcome o) => switch (o) {
  LoginOutcome.ok => '',
  LoginOutcome.badCredentials => 'Email or password is incorrect.',
  LoginOutcome.rateLimited => 'Too many attempts. Try again later.',
  LoginOutcome.locked =>
    'Your account is locked. Contact your lab administrator.',
  LoginOutcome.noScreenLock =>
    'Set a screen lock (PIN, pattern or fingerprint) on this phone first.',
  LoginOutcome.rooted => "This phone can't be used for home collection.",
  LoginOutcome.updateRequired => 'Update the app to continue.',
  LoginOutcome.otherUserUnsent => 'This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it.',
  LoginOutcome.rebind => 'Sign in again to set up this phone.',
  LoginOutcome.failed => "Couldn't sign in. Try again.",
};

const loginOfflineMessage = 'You need an internet connection to sign in.';

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onSignIn,
    required this.appVersion,
    this.offline = false,
    this.environmentName,
    this.onUseFingerprint,
    this.initialOutcome,
  });

  /// Resolves with the outcome; `ok` means the host navigates away.
  final Future<LoginOutcome> Function(String email, String password) onSignIn;
  final String appVersion;
  final bool offline;

  /// Shown in non-prod flavours only ("Staging").
  final String? environmentName;

  /// Offered only while an earlier session is still valid on this phone (works offline, 12 h in the board).
  final Future<void> Function()? onUseFingerprint;
  final LoginOutcome? initialOutcome;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  LoginOutcome? _outcome;

  @override
  void initState() {
    super.initState();
    _outcome = widget.initialOutcome;
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _ready =>
      _email.text.trim().isNotEmpty &&
      _password.text.isNotEmpty &&
      !_busy &&
      !widget.offline;

  Future<void> _submit() async {
    if (!_ready) return;
    setState(() {
      _busy = true;
      _outcome = null;
    });
    LoginOutcome result;
    try {
      result = await widget.onSignIn(_email.text.trim(), _password.text);
    } catch (_) {
      result = LoginOutcome.failed;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _outcome = result == LoginOutcome.ok ? null : result;
      if (result != LoginOutcome.ok) _password.clear();
    });
  }

  String? get _message => widget.offline
      ? loginOfflineMessage
      : (_outcome == null ? null : loginMessage(_outcome!));

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final msg = _message;
    return Scaffold(
      backgroundColor: LimsTokens.colorAccentHover,
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: PhleboGradients.entry),
        child: CustomScrollView(
          slivers: [
            SliverFillRemaining(
              hasScrollBody: false,
              child: Column(
                children: [
                  Expanded(
                    child: SafeArea(
                      bottom: false,
                      child: Padding(
                        padding: const EdgeInsets.all(LimsTokens.space6),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const PhleboBrandMark(
                              landscape: true,
                              height: LimsTokens.space12,
                            ),
                            const SizedBox(height: LimsTokens.space3),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: LimsTokens.space4,
                                vertical: LimsTokens.space1,
                              ),
                              decoration: BoxDecoration(
                                color: LimsTokens.colorAccentFg.withValues(
                                  alpha: 0.16,
                                ),
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
                            const SizedBox(height: LimsTokens.space4),
                            Text(
                              'Home collection,\nvisit by visit',
                              textAlign: TextAlign.center,
                              style: t.headlineSmall?.copyWith(
                                color: LimsTokens.colorAccentFg,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.fromLTRB(
                      LimsTokens.space5,
                      LimsTokens.space6,
                      LimsTokens.space5,
                      LimsTokens.space4,
                    ),
                    decoration: const BoxDecoration(
                      color: LimsTokens.colorNeutral0,
                      borderRadius: BorderRadius.vertical(
                        top: Radius.circular(LimsTokens.radiusXl),
                      ),
                    ),
                    child: SafeArea(
                      top: false,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              'Sign in',
                              style: t.headlineSmall?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          const SizedBox(height: LimsTokens.space1),
                          Text(
                            'Use the account your lab administrator gave you.',
                            style: t.bodyMedium?.copyWith(
                              color: LimsTokens.colorNeutral600,
                            ),
                          ),
                          const SizedBox(height: LimsTokens.space4),
                          if (msg != null) ...[
                            PhleboNotice(
                              tone: widget.offline
                                  ? 'warning'
                                  : (_outcome == LoginOutcome.rebind
                                        ? 'info'
                                        : 'danger'),
                              text: msg,
                              icon: widget.offline ? Icons.cloud_off : null,
                            ),
                            const SizedBox(height: LimsTokens.space3),
                          ],
                          LimsTextField(
                            label: 'Email',
                            maxLength: 254,
                            sensitive: true,
                            controller: _email,
                            keyboardType: TextInputType.emailAddress,
                            onChanged: (_) => setState(() {}),
                          ),
                          LimsTextField(
                            label: 'Password',
                            maxLength: 128,
                            sensitive: true,
                            obscureText: true,
                            controller: _password,
                            onChanged: (_) => setState(() {}),
                          ),
                          const SizedBox(height: LimsTokens.space2),
                          LimsButton(
                            label: _busy ? 'Signing in…' : 'Sign in',
                            onPressed: _ready ? _submit : null,
                          ),
                          if (widget.onUseFingerprint != null) ...[
                            const SizedBox(height: LimsTokens.space2),
                            LimsButton(
                              label: 'Use fingerprint',
                              icon: Icons.fingerprint,
                              secondary: true,
                              onPressed: _busy
                                  ? null
                                  : () => widget.onUseFingerprint!(),
                            ),
                          ],
                          const SizedBox(height: LimsTokens.space3),
                          Text(
                            [
                              if (widget.environmentName != null)
                                widget.environmentName!,
                              'Phlebotomist app ${widget.appVersion}',
                            ].join(' · '),
                            textAlign: TextAlign.center,
                            style: t.labelMedium?.copyWith(
                              color: LimsTokens.colorNeutral600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
