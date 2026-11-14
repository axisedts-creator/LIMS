// 04-UI-UX A0 splash, A2 phone entry, A3 OTP entry in one widget (03-APP-FLOW §2.1; US-EN-01.1/.3/.4/.5/.6/.7, US-EN-02.1).
// LD-28 (2026-11-07, A33-5): "Privacy policy" and "Terms of use" links on A2 (first run), opened in the system browser,
// URLs from platform config (Flavour), optional tenant privacy URL under the lab name.
// LD-140: lims_ui components and token names only; one primary button per page; errors show icon + words.
// All state is widget-local, so leaving the sign-in area (sign-in, logout, session expiry) drops the phone, the challenge
// token and the code. Nothing here logs or persists them (02-CV 9.2, REQ-SEC-103).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/flavour.dart';
import '../../app/providers.dart';
import 'auth_providers.dart';
import 'patient_auth_api.dart';

enum _Step { loading, loadFailed, phone, code }

final _e164 = RegExp(r'^\+[1-9][0-9]{7,14}$');
final _prefix = RegExp(r'^\+[1-9][0-9]{0,3}$');

class SignInFlow extends ConsumerStatefulWidget {
  const SignInFlow({super.key});

  @override
  ConsumerState<SignInFlow> createState() => _SignInFlowState();
}

class _SignInFlowState extends ConsumerState<SignInFlow> {
  static const _configAttempts = 3; // A0: E1 is tried 3 times, then the error state
  static const _genericError = 'Something went wrong. Try again.';

  _Step _step = _Step.loading;
  List<String> _prefixes = const [];
  String _consentText = '';

  String _phone = '';
  String? _phoneError;
  String? _notice; // errors that are not about one field
  bool _busy = false;

  String? _challenge;
  String? _codeError;
  int _otpKey = 0; // a new key = a fresh, empty code field
  int _resendIn = 0;
  Timer? _timer;
  Timer? _retryTimer; // A0 config retry back-off; cancelled on dispose so no timer outlives the screen

  Flavour get _flavour => ref.read(flavourProvider);
  PatientAuthApi get _api => ref.read(patientAuthApiProvider);

  @override
  void initState() {
    super.initState();
    _loadConfig();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _retryTimer?.cancel();
    super.dispose();
  }

  // ---- A0 -------------------------------------------------------------------------------------------------------

  Future<void> _loadConfig() async {
    if (_step != _Step.loading) setState(() => _step = _Step.loading);
    for (var attempt = 1; attempt <= _configAttempts; attempt++) {
      try {
        final cfg = _parseConfig(await _api.getAppConfig());
        if (!mounted) return;
        setState(() {
          _prefixes = cfg.prefixes;
          _consentText = cfg.consent;
          _step = _Step.phone;
        });
        return;
      } on LimsException catch (e) {
        if (e.code == LimsErrorCodes.engagementAppVersionUnsupported) break; // 426: the router shows A1, no retry loop
      } catch (_) {
        // network or malformed body: counts as a failed attempt
      }
      if (attempt < _configAttempts) {
        final wait = Completer<void>();
        _retryTimer = Timer(Duration(seconds: attempt), wait.complete);
        await wait.future; // never completes if disposed first: the loop simply stops
      }
      if (!mounted) return;
    }
    if (mounted) setState(() => _step = _Step.loadFailed);
  }

  ({List<String> prefixes, String consent}) _parseConfig(Object? body) {
    if (body case {'allowed_phone_prefixes': List<Object?> raw, 'consent': {'text': String text}}) {
      final prefixes = [for (final p in raw) if (p is String && _prefix.hasMatch(p)) p];
      if (prefixes.isNotEmpty) return (prefixes: prefixes, consent: text);
    }
    throw const FormatException('app config');
  }

  // ---- A2 / A3 requests -----------------------------------------------------------------------------------------

  Future<void> _send() async {
    if (_busy) return;
    if (!_e164.hasMatch(_phone)) {
      setState(() => _phoneError = 'Enter a valid mobile number.');
      return;
    }
    setState(() {
      _busy = true;
      _phoneError = null;
      _notice = null;
    });
    try {
      final r = await _api.requestOtp(phoneE164: _phone);
      if (r case {'challenge_token': String token, 'resend_after_seconds': int wait}) {
        if (!mounted) return;
        setState(() {
          _challenge = token;
          _codeError = null;
          _otpKey++;
          _step = _Step.code;
          _startCountdown(wait);
        });
      } else {
        throw const FormatException('otp challenge');
      }
    } catch (e) {
      if (mounted) setState(() => _showRequestError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showRequestError(Object e) {
    final lab = _flavour.displayName;
    if (e is LimsException) {
      switch (e.code) {
        case LimsErrorCodes.commonRateLimited:
          final wait = e is RateLimitedException ? e.retryAfter : null;
          if (wait == null || wait <= Duration.zero) {
            _notice = 'Too many codes requested. Try again later.';
          } else {
            final minutes = (wait.inSeconds + 59) ~/ 60;
            _notice = 'Too many codes requested. Try again in $minutes ${minutes == 1 ? 'minute' : 'minutes'}.';
          }
          return;
        case LimsErrorCodes.commonFeatureDisabled:
          _notice = "The app isn't available for $lab yet.";
          return;
        case LimsErrorCodes.commonValidationFailed:
          if (_step == _Step.phone && (e.fieldErrors ?? const []).any((f) => f.path == '/phone_e164')) {
            _phoneError = 'This app accepts numbers starting with ${_prefixes.join(', ')} only.';
            return;
          }
      }
    }
    _notice = _genericError; // never the server detail
  }

  Future<void> _verify(String code) async {
    final challenge = _challenge;
    if (_busy || challenge == null) return;
    setState(() {
      _busy = true;
      _notice = null;
      _codeError = null;
    });
    try {
      final r = await _api.verifyOtp(challengeToken: challenge, code: code);
      if (r case {'session_token': String session, 'access_token': String access, 'access_expires_at': String exp}) {
        final expires = DateTime.tryParse(exp);
        if (expires != null) {
          // Session token to secure storage, JWT in memory only (US-EN-02.1); the router then leaves the sign-in area.
          await ref.read(sessionControllerProvider).signIn(sessionToken: session, accessToken: access, accessExpiresAt: expires);
          return;
        }
      }
      throw const FormatException('otp verify');
    } on LimsException catch (e) {
      if (!mounted) return;
      if (e.code == LimsErrorCodes.authOtpAttemptsExhausted) {
        _backToPhone('Too many attempts. Request a new code.'); // US-EN-01.4: a new challenge is needed
      } else {
        setState(() {
          _otpKey++;
          if (e.code == LimsErrorCodes.authOtpInvalid) {
            _codeError = 'That code is wrong or has expired.'; // US-EN-01.5
          } else {
            _notice = _genericError; // 03-APP-FLOW 2.1 rule 4: the same code may be tried again
          }
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _otpKey++;
          _notice = _genericError;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _backToPhone([String? notice]) {
    _timer?.cancel();
    setState(() {
      _challenge = null;
      _phone = '';
      _phoneError = null;
      _notice = notice;
      _step = _Step.phone;
    });
  }

  void _startCountdown(int seconds) {
    _timer?.cancel();
    _resendIn = seconds;
    if (seconds <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _resendIn--);
      if (_resendIn <= 0) t.cancel();
    });
  }

  // ---- widgets --------------------------------------------------------------------------------------------------

  void _open(String url) {
    final uri = Uri.tryParse(url);
    if (uri != null) ref.read(externalUrlOpenerProvider)(uri);
  }

  Widget _link(String label, String? url) => url == null || url.isEmpty
      ? const SizedBox.shrink()
      : TextButton(onPressed: () => _open(url), child: Text(label));

  Widget _noticeRow(String message) {
    final c = limsTone('danger');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: LimsTokens.space2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.error_outline, color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(message, style: TextStyle(color: c.fg))),
        ]),
      ),
    );
  }

  Future<void> _showConsent() => LimsDialog.show<void>(
        context,
        title: 'App terms',
        content: Text(_consentText),
        actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close'))],
      );

  /// 07-SECURITY `phone_masked`: country prefix + `•••••` + last 2 digits (TRD "+99X•••••42"); never reveals the length.
  String _masked() {
    final prefix = ([..._prefixes]..sort((a, b) => b.length - a.length)).firstWhere(_phone.startsWith, orElse: () => '+');
    final national = _phone.substring(prefix.length);
    final shown = national.length < 2 ? national.length : 2;
    return '$prefix•••••${national.substring(national.length - shown)}';
  }

  String _countdown() => 'Resend in ${_resendIn ~/ 60}:${(_resendIn % 60).toString().padLeft(2, '0')}';

  Widget _phoneStep() {
    final lab = _flavour.displayName;
    final t = Theme.of(context).textTheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(lab, style: t.titleLarge),
      Align(alignment: AlignmentDirectional.centerStart, child: _link('Privacy policy', _flavour.tenantPrivacyUrl)),
      const SizedBox(height: LimsTokens.space4),
      LimsPhoneField(
        label: 'Mobile number',
        prefixes: _prefixes,
        initialPrefix: _prefixes.first,
        errorText: _phoneError,
        onChanged: (v) => _phone = v,
      ),
      if (_notice != null) _noticeRow(_notice!),
      const SizedBox(height: LimsTokens.space4),
      if (_busy) const LimsLoading(label: 'Sending code'),
      LimsButton(label: 'Send code', onPressed: _busy ? null : _send),
      TextButton(onPressed: _showConsent, child: Text("By continuing you agree to $lab's app terms.", textAlign: TextAlign.center)),
      Wrap(alignment: WrapAlignment.center, children: [
        _link('Privacy policy', _flavour.privacyUrl),
        _link('Terms of use', _flavour.termsUrl),
      ]),
    ]);
  }

  Widget _codeStep() => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Enter the 6-digit code sent to ${_masked()}.', style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: LimsTokens.space4),
        LimsOtpField(key: ValueKey(_otpKey), autofocus: true, errorText: _codeError, onCompleted: _verify),
        if (_notice != null) _noticeRow(_notice!),
        const SizedBox(height: LimsTokens.space4),
        if (_busy) const LimsLoading(label: 'Checking code'),
        LimsButton(
          label: _resendIn > 0 ? _countdown() : 'Resend code',
          secondary: true,
          onPressed: _resendIn > 0 || _busy ? null : _send,
        ),
        const SizedBox(height: LimsTokens.space2),
        LimsButton(label: 'Change number', secondary: true, onPressed: _busy ? null : _backToPhone),
      ]);

  @override
  Widget build(BuildContext context) {
    final body = switch (_step) {
      _Step.loading => Column(mainAxisSize: MainAxisSize.min, children: [
          const LimsLoading(label: 'Loading'),
          Text(_flavour.displayName, style: Theme.of(context).textTheme.titleMedium),
        ]),
      _Step.loadFailed => LimsErrorState(
          title: "We can't reach ${_flavour.displayName} right now.",
          retryLabel: 'Try again',
          onRetry: _loadConfig,
        ),
      _Step.phone => _phoneStep(),
      _Step.code => _codeStep(),
    };
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(padding: const EdgeInsets.all(LimsTokens.space4), child: body),
        ),
      ),
    );
  }
}
