// A9 Register myself / my child (E16 + E17 polling; 04-UI-UX A9; 03-APP-FLOW §3.3; US-EN-05.1, .3-.5). The name, birth date and age are PHI: they live in
// widget state only (kept after a failure so the user can fix them, dropped with the screen) and travel only in the E16 body. LD-140: lims_ui widgets and
// tokens only; one primary button. The child age rule is the server's (AppConfig has no minor age): its 400 field message shows inline.
// E17 poll: first ~2 s after the 202, then every 2 s, 10 polls (20 s), then pull-to-refresh asks once more.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import '../auth/auth_providers.dart';
import 'name_text.dart';
import 'profile_copy.dart';
import 'profiles_providers.dart';

enum _Phase { loading, loadFailed, noConsent, disabled, form, creating, created, failed }

const _pollEvery = Duration(seconds: 2);
const _maxPolls = 10;
const _atTheLabTitle = 'Registration happens at the lab';
const _atTheLabMessage = 'Ask the front desk for an app code, then add it from the Profiles screen.';
const _sexOptions = [('male', 'Male'), ('female', 'Female'), ('other', 'Other'), ('unknown', 'Prefer not to say')];

String _isoToday() {
  final d = DateTime.now();
  return '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key, this.onCreated});

  /// Called with the profile id once E17 reports `created`.
  final void Function(String profileId)? onCreated;

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  _Phase _phase = _Phase.loading;
  AppConsent? _consent;
  bool _hasSelf = false;

  String _relationship = 'self';
  String? _sex;
  String? _dob; // A.D. ISO; exclusive with the age field
  bool _sms = true;
  bool _whatsapp = true;
  bool _agreed = false;
  final _name = TextEditingController();
  final _age = TextEditingController();

  String? _nameError, _sexError, _dobError, _ageError, _notice;
  bool _busy = false;

  Map<String, Object?>? _lastBody; // kept so [Try again] re-sends the same details
  String? _regId;
  Timer? _timer;
  int _ticks = 0;
  bool _polling = false;
  bool _timedOut = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _name.dispose();
    _age.dispose();
    super.dispose();
  }

  // ---- E1 + E13 ---------------------------------------------------------------------------------------------------

  Future<void> _load() async {
    setState(() => _phase = _Phase.loading);
    // E13 only tells whether a "me" profile exists; if it fails the server still enforces the rule.
    final listing = ref.read(profilesApiProvider).listMyProfiles().then((j) => parseProfileList(j).hasSelf).catchError((_) => false);
    try {
      final consent = await readConsent(ref.read(patientAuthApiProvider));
      final hasSelf = await listing;
      if (!mounted) return;
      setState(() {
        _consent = consent;
        _hasSelf = hasSelf;
        if (hasSelf) _relationship = 'child';
        _phase = consent == null ? _Phase.noConsent : _Phase.form;
      });
    } catch (_) {
      if (mounted) setState(() => _phase = _Phase.loadFailed);
    }
  }

  // ---- E16 --------------------------------------------------------------------------------------------------------

  void _submit() {
    if (_busy) return;
    final consent = _consent;
    if (consent == null) return;
    final name = normaliseName(_name.text);
    final ageText = _age.text.trim();
    final age = int.tryParse(ageText);
    String? ageError;
    String? dobError;
    if (_dob == null && ageText.isEmpty) {
      dobError = 'Enter the date of birth or the age.';
    } else if (_dob == null && (age == null || age < 0 || age > 150)) {
      ageError = 'Enter an age from 0 to 150.';
    }
    final nameError = name.isEmpty ? 'Enter the full name.' : null;
    final sexError = _sex == null ? 'Choose one.' : null;
    final notice = _agreed ? null : 'Tick the box to agree to the terms.';
    setState(() {
      _nameError = nameError;
      _sexError = sexError;
      _dobError = dobError;
      _ageError = ageError;
      _notice = notice;
    });
    if (nameError != null || sexError != null || dobError != null || ageError != null || notice != null) return;
    _send({
      'relationship': _relationship,
      'full_name': name,
      'sex': _sex,
      if (_dob != null) 'birth_on': _dob else 'age_years': age,
      'sms_consent': _sms,
      'whatsapp_consent': _whatsapp,
      'consent_text_version': consent.version,
    });
  }

  Future<void> _send(Map<String, Object?> body) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final reg = parseSelfRegistration(await ref.read(profilesApiProvider).createSelfRegistration(body));
      if (!mounted) return;
      setState(() {
        _busy = false;
        _lastBody = body;
        _regId = reg.id;
        _phase = _Phase.creating;
        _timedOut = false;
        _ticks = 0;
      });
      if (!_apply(reg)) {
        _timer?.cancel();
        _timer = Timer.periodic(_pollEvery, (_) => _tick());
      }
    } catch (e) {
      if (mounted) await _showSendError(e);
    }
  }

  Future<void> _showSendError(Object e) async {
    var termsChanged = false;
    String? notice;
    var phase = _Phase.form;
    String? nameError, sexError, dobError, ageError;
    if (e is LimsException && e.code == LimsErrorCodes.commonFeatureDisabled) {
      phase = _Phase.disabled;
    } else if (e is LimsException && e.code == LimsErrorCodes.commonValidationFailed) {
      for (final f in e.fieldErrors ?? const <FieldError>[]) {
        switch (f.path) {
          case '/age_years':
            ageError = f.message; // fixed server sentences, no submitted value in them
          case '/birth_on':
            dobError = f.message;
          case '/full_name':
            nameError = 'Enter the full name.';
          case '/sex':
            sexError = 'Choose one.';
          case '/consent_text_version':
            termsChanged = true;
        }
      }
      if (termsChanged) {
        notice = 'The terms changed. Read them and tick the box again.';
      } else if (nameError == null && sexError == null && dobError == null && ageError == null) {
        notice = genericError;
      }
    } else {
      notice = linkFailureCopy(e);
    }
    setState(() {
      _busy = false;
      _phase = phase;
      _nameError = nameError;
      _sexError = sexError;
      _dobError = dobError;
      _ageError = ageError;
      _notice = notice;
      if (termsChanged) _agreed = false; // consent must be given for the new text
    });
    if (termsChanged) {
      try {
        final fresh = await readConsent(ref.read(patientAuthApiProvider));
        if (!mounted) return;
        setState(() {
          _consent = fresh;
          if (fresh == null) _phase = _Phase.noConsent;
        });
      } catch (_) {
        if (mounted) setState(() => _notice = genericError);
      }
    }
  }

  // ---- E17 --------------------------------------------------------------------------------------------------------

  Future<void> _tick() async {
    _ticks++;
    final last = _ticks >= _maxPolls;
    if (last) _timer?.cancel();
    await _poll();
    if (last && mounted && _phase == _Phase.creating) setState(() => _timedOut = true);
  }

  Future<void> _poll() async {
    final id = _regId;
    if (id == null || _polling) return;
    _polling = true;
    try {
      final reg = parseSelfRegistration(await ref.read(profilesApiProvider).getSelfRegistration(id));
      if (mounted && _regId == id) _apply(reg);
    } catch (_) {
      // transient: the next poll (or a pull-to-refresh) asks again
    } finally {
      _polling = false;
    }
  }

  /// True when [reg] ends the wait.
  bool _apply(SelfRegistration reg) {
    final profileId = reg.profileId;
    if (reg.status == 'created' && profileId != null) {
      _timer?.cancel();
      setState(() => _phase = _Phase.created);
      LimsSnackbar.show(context, 'Profile created', tone: 'success');
      widget.onCreated?.call(profileId);
      return true;
    }
    if (reg.status == 'failed') {
      _timer?.cancel();
      setState(() => _phase = _Phase.failed);
      return true;
    }
    return false;
  }

  void _retry() {
    final body = _lastBody;
    if (body == null) return;
    setState(() => _phase = _Phase.form); // the form stays on screen (with its spinner) until E16 answers
    _send(body);
  }

  // ---- widgets ----------------------------------------------------------------------------------------------------

  Future<void> _readTerms() => LimsDialog.show<void>(
        context,
        title: 'App terms',
        content: Text(_consent?.text ?? ''),
        actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close'))],
      );

  Widget _infoBox(String lab) {
    final c = limsTone('info');
    return Container(
      padding: const EdgeInsets.all(LimsTokens.space3),
      color: c.bg,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(Icons.info_outline, color: c.fg),
        const SizedBox(width: LimsTokens.space2),
        Expanded(
          child: Text(
            "This creates a new record at $lab. If you've visited before, ask for an app code instead to see your earlier reports.",
            style: TextStyle(color: c.fg),
          ),
        ),
      ]),
    );
  }

  Widget _form() {
    final lab = ref.read(flavourProvider).displayName;
    final consent = _consent!;
    const gap = SizedBox(height: LimsTokens.space4);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Who is this for?', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: LimsTokens.space2),
        LimsSegmentedControl<String>(
          options: const [(value: 'self', label: 'Myself'), (value: 'child', label: 'My child')],
          value: _relationship,
          disabled: _hasSelf ? const {'self'} : const {}, // LD-164: render "Myself" disabled; the tap guard below stays as a second line
          onChanged: (v) {
            if (v == 'self' && _hasSelf) return; // one "me" profile per account
            setState(() => _relationship = v);
          },
        ),
        if (_hasSelf) Padding(padding: const EdgeInsets.only(top: LimsTokens.space1), child: Text('You already have a profile for yourself.', style: Theme.of(context).textTheme.bodySmall)),
        gap,
        LimsTextField(label: 'Full name', maxLength: 200, sensitive: true, controller: _name, errorText: _nameError, onChanged: (_) => setState(() => _nameError = null)),
        gap,
        Text('Sex', style: Theme.of(context).textTheme.titleMedium),
        RadioGroup<String>(
          groupValue: _sex,
          onChanged: (v) => setState(() {
            _sex = v;
            _sexError = null;
          }),
          child: Column(children: [for (final o in _sexOptions) RadioListTile<String>(value: o.$1, title: Text(o.$2))]),
        ),
        if (_sexError != null) ProfileNotice(_sexError!),
        gap,
        LimsDatePicker(
          label: 'Date of birth',
          value: _dob,
          firstDate: '1900-01-01',
          lastDate: _isoToday(),
          calendarMode: consent.calendar,
          errorText: _dobError,
          onChanged: (iso) => setState(() {
            _dob = iso;
            _age.clear(); // date of birth or age, never both
            _dobError = null;
            _ageError = null;
          }),
        ),
        gap,
        LimsTextField(
          label: 'Age in years (if DOB unknown)',
          maxLength: 3,
          controller: _age,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          errorText: _ageError,
          onChanged: (v) => setState(() {
            if (v.isNotEmpty) _dob = null;
            _ageError = null;
            _dobError = null;
          }),
        ),
        gap,
        SwitchListTile(title: const Text('SMS updates'), value: _sms, onChanged: (v) => setState(() => _sms = v)),
        SwitchListTile(title: const Text('WhatsApp updates'), value: _whatsapp, onChanged: (v) => setState(() => _whatsapp = v)),
        CheckboxListTile(
          controlAffinity: ListTileControlAffinity.leading,
          value: _agreed,
          onChanged: (v) => setState(() {
            _agreed = v ?? false;
            _notice = null;
          }),
          title: Text("I have read and agree to $lab's terms"),
          secondary: TextButton(onPressed: _readTerms, child: const Text('Read')),
        ),
        gap,
        _infoBox(lab),
        if (_notice != null) ProfileNotice(_notice!),
        gap,
        if (_busy) const LimsLoading(label: 'Creating record'),
        LimsButton(label: 'Create record', onPressed: _busy ? null : _submit),
      ]),
    );
  }

  Widget _creating() => RefreshIndicator(
        onRefresh: _poll,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(LimsTokens.space4),
          children: [
            if (!_timedOut) const LimsLoading(label: 'Creating your record'),
            Text('Creating your record…', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
            if (_timedOut) ...[
              const SizedBox(height: LimsTokens.space2),
              Text('This is taking longer than usual. Pull down to check again.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
            ],
          ],
        ),
      );

  Widget _body() => switch (_phase) {
        _Phase.loading => const LimsLoading(),
        _Phase.loadFailed => LimsErrorState(title: 'Could not load the registration form', message: 'Check your connection and try again.', onRetry: _load),
        _Phase.noConsent => const LimsEmptyState(title: _atTheLabTitle, message: _atTheLabMessage),
        _Phase.disabled => const LimsErrorState(title: _atTheLabTitle, message: _atTheLabMessage),
        _Phase.form => _form(),
        _Phase.creating => _creating(),
        _Phase.created => const LimsEmptyState(title: 'Your record is ready.', icon: Icons.check_circle_outline),
        _Phase.failed => LimsErrorState(
            title: "We couldn't create your record.",
            message: 'Your details are kept. Try again to send them once more.',
            retryLabel: 'Try again',
            onRetry: _retry,
          ),
      };

  @override
  Widget build(BuildContext context) => LimsSecureScreen(child: LimsScaffold(title: 'Register', body: _body()));
}
