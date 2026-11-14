// T-L6 — A9 Register myself / my child (E16 + E17 polling). PRD US-EN-05.1/.2(partly)/.3/.4/.5; 03-APP-FLOW §3.3 and §10.1 A9 row; 04-UI-UX A9 field table.
// Choices the brief left open (cite if disputed):
//   - Widgets found by their visible words: segment labels "Myself" / "My child"; sex radios "Male" / "Female" / "Other" / "Prefer not to say" (wire `unknown`);
//     LimsTextField labels "Full name" and "Age in years (if DOB unknown)"; LimsDatePicker label "Date of birth"; switches "SMS updates" / "WhatsApp updates";
//     the ONE Checkbox is the consent ("I have read and agree to Synthetic Lab Alpha's terms") with a [Read] button that shows consent.text from E1; submit [Create record].
//   - Date of birth is driven through LimsDatePicker.onChanged (the platform calendar dialog is T-01's); DOB and age are exclusive: setting one clears the other.
//   - The tenant minor age is NOT on the client wire (AppConfig has none), so the child age rule is the server's: 400 + fieldErrors path /birth_on or /age_years shows inline.
//   - Polling: first E17 ~2 s after the 202, then every 2 s, stop after 20 s (<= 10 polls), then pull-to-refresh (RefreshIndicator) asks once more.
//   - failed: [Try again] re-submits the SAME form as a NEW E16 request (a new Idempotency-Key is the transport's job); failure_code is never shown.
//   - 400 on /consent_text_version (spec: only "400"): the screen re-reads E1, unticks the consent (it must be given for the new text) and shows an error in words + icon.
//   - NOT covered here: "You can link earlier visits with a code from the lab" after duplicateSuspected (US-EN-05.2) — the SelfRegistration wire has no such flag (T-L4 note); see T-L6-tests.md.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/profiles/register_screen.dart';

import '../../support/profiles_fakes.dart';

const create = 'Create record';
const longName = 'Asha Kumari Synthetic';

void main() {
  late FakeProfilesApi api;
  setUp(() => api = FakeProfilesApi());

  Future<void> open(WidgetTester t, {void Function(String)? onCreated, FakeConfigApi? config, List<Map<String, Object?>> existing = const []}) async {
    api.onList = (_) async => listBody(data: existing);
    t.view.physicalSize = const Size(800, 3200); // tall: the whole form is built, no scrolling needed
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(const SizedBox());
    await t.pumpWidget(host(RegisterScreen(onCreated: onCreated), api, config: config));
    await settle(t);
  }

  Finder field(String label) => find.widgetWithText(TextField, label);

  Future<void> fill(WidgetTester t, {String name = longName, String sex = 'Female', String? age = '30', bool consent = true, bool child = false}) async {
    if (child) {
      await t.tap(find.text('My child'));
      await t.pump();
    }
    await t.enterText(field('Full name'), name);
    await t.tap(find.text(sex));
    await t.pump();
    if (age != null) await t.enterText(field('Age in years (if DOB unknown)'), age);
    if (consent) await t.tap(find.byType(Checkbox));
    await t.pump();
  }

  Future<void> submit(WidgetTester t) async {
    await t.ensureVisible(find.text(create));
    await t.tap(find.text(create), warnIfMissed: false);
    await settle(t);
  }

  Map<String, Object?> sent() => api.created.single;

  group('the form (04-UI-UX A9)', () {
    testWidgets('fields, defaults and copy: Myself selected, SMS + WhatsApp on, consent off, info box with the lab name, one primary button, LimsSecureScreen', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.text('Myself'), findsOneWidget);
      expect(find.text('My child'), findsOneWidget);
      for (final s in ['Male', 'Female', 'Other', 'Prefer not to say']) {
        expect(find.text(s), findsOneWidget, reason: s);
      }
      expect(find.byType(LimsDatePicker), findsOneWidget);
      expect(t.widget<LimsDatePicker>(find.byType(LimsDatePicker)).label, 'Date of birth');
      expect(field('Full name'), findsOneWidget);
      expect(field('Age in years (if DOB unknown)'), findsOneWidget);
      final switches = t.widgetList<Switch>(find.byType(Switch)).toList();
      expect(switches, hasLength(2));
      expect(switches.every((s) => s.value), isTrue, reason: 'SMS and WhatsApp default on');
      expect(find.text('SMS updates'), findsOneWidget);
      expect(find.text('WhatsApp updates'), findsOneWidget);
      expect(t.widget<Checkbox>(find.byType(Checkbox)).value, isFalse, reason: 'consent defaults off');
      expect(find.textContaining("I have read and agree to Synthetic Lab Alpha's terms"), findsOneWidget);
      expect(find.text('This creates a new record at Synthetic Lab Alpha. If you\'ve visited before, ask for an app code instead to see your earlier reports.'), findsOneWidget);
      expect(primaryButtons(), findsOneWidget);
      expect(find.text(create), findsOneWidget);
    });

    testWidgets('name and age fields use LimsTextField with the 04-UI-UX maxima (200 / 3)', (t) async {
      await open(t);
      final fields = t.widgetList<LimsTextField>(find.byType(LimsTextField)).toList();
      expect(fields.firstWhere((f) => f.label == 'Full name').maxLength, 200);
      expect(fields.firstWhere((f) => f.label == 'Age in years (if DOB unknown)').maxLength, 3);
    });

    testWidgets('[Read] shows the consent text from E1 (not stored anywhere else on the page)', (t) async {
      await open(t, config: FakeConfigApi(() => configBody(text: 'Synthetic consent body text.')));
      expect(find.text('Synthetic consent body text.'), findsNothing);
      await t.tap(find.text('Read'));
      await t.pumpAndSettle();
      expect(find.text('Synthetic consent body text.'), findsOneWidget);
    });

    testWidgets('E1 loaded once for the screen; E2/E3 never called (fake throws if they are)', (t) async {
      final cfg = FakeConfigApi();
      await open(t, config: cfg);
      await t.pump(const Duration(seconds: 5));
      expect(cfg.configCalls, 1);
    });

    testWidgets('no consent text_version (tenant has no app consent): no form, "Registration happens at the lab"', (t) async {
      await open(t, config: FakeConfigApi(() => configBody(textVersion: null)));
      expect(find.textContaining('Registration happens at the lab'), findsOneWidget);
      expect(find.text(create), findsNothing);
    });

    testWidgets('a profile with relationship self already exists: "My child" is selected, tapping "Myself" does not change it (Myself disabled)', (t) async {
      await open(t, existing: [profile()]);
      await t.tap(find.text('Myself'), warnIfMissed: false);
      await t.pump();
      await fill(t, child: false);
      await submit(t);
      expect(sent()['relationship'], 'child');
    });

    testWidgets('04-UI-UX A9 "Myself (disabled if a self profile exists)": the Myself segment is RENDERED disabled, My child stays enabled', (t) async {
      await open(t, existing: [profile()]);
      final segs = (t.widget(find.byWidgetPredicate((w) => w is SegmentedButton)) as dynamic).segments as List;
      final myself = segs.firstWhere((s) => (((s as dynamic).label) as Text).data == 'Myself') as dynamic;
      final child = segs.firstWhere((s) => (((s as dynamic).label) as Text).data == 'My child') as dynamic;
      expect(myself.enabled, isFalse, reason: 'not just ignored on tap: shown disabled');
      expect(child.enabled, isTrue);
    });

    testWidgets('no self profile: both segments are enabled', (t) async {
      await open(t);
      final segs = (t.widget(find.byWidgetPredicate((w) => w is SegmentedButton)) as dynamic).segments as List;
      expect(segs.every((s) => (s as dynamic).enabled == true), isTrue);
    });

    testWidgets('self choice stays available when the account has only a child profile', (t) async {
      await open(t, existing: [profile(id: pidChild, rel: 'child', method: 'self_registered')]);
      await fill(t);
      await submit(t);
      expect(sent()['relationship'], 'self');
    });
  });

  group('validation before sending (no E16 call)', () {
    testWidgets('untouched form: Create record sends nothing', (t) async {
      await open(t);
      await submit(t);
      expect(api.createCalls, 0);
    });

    for (final c in <String, Future<void> Function(WidgetTester)>{
      'no name': (t) => fill(t, name: ''),
      'whitespace-only name': (t) => fill(t, name: '   '),
      'no sex chosen': (t) async {
        await t.enterText(field('Full name'), longName);
        await t.enterText(field('Age in years (if DOB unknown)'), '30');
        await t.tap(find.byType(Checkbox));
        await t.pump();
      },
      'neither date of birth nor age': (t) => fill(t, age: null),
      'consent not ticked': (t) => fill(t, consent: false),
      'age 151': (t) => fill(t, age: '151'),
      'age not a number': (t) => fill(t, age: 'abc'),
    }.entries) {
      testWidgets('rejected: ${c.key}', (t) async {
        await open(t);
        await c.value(t);
        await submit(t);
        expect(api.createCalls, 0);
      });
    }

    testWidgets('a name longer than 200 characters is cut to 200 (never sent longer)', (t) async {
      await open(t);
      await fill(t, name: 'A' * 260);
      await submit(t);
      expect((sent()['full_name'] as String).length, lessThanOrEqualTo(200));
    });
  });

  group('the request (E16, US-EN-05.1)', () {
    testWidgets('myself, age known: exact body — relationship, full_name, sex, age_years, both consents, consent_text_version from E1; nothing else', (t) async {
      await open(t);
      await fill(t);
      await submit(t);
      expect(sent(), {
        'relationship': 'self',
        'full_name': longName,
        'sex': 'female',
        'age_years': 30,
        'sms_consent': true,
        'whatsapp_consent': true,
        'consent_text_version': '2026-01',
      });
    });

    testWidgets('child with a date of birth: birth_on (A.D. ISO) and NO age_years', (t) async {
      await open(t);
      await fill(t, child: true, age: null);
      t.widget<LimsDatePicker>(find.byType(LimsDatePicker)).onChanged('2018-04-02');
      await t.pump();
      await submit(t);
      expect(sent()['relationship'], 'child');
      expect(sent()['birth_on'], '2018-04-02');
      expect(sent().containsKey('age_years'), isFalse);
    });

    testWidgets('date of birth then age: age wins and birth_on is dropped (xor)', (t) async {
      await open(t);
      await fill(t, age: null);
      t.widget<LimsDatePicker>(find.byType(LimsDatePicker)).onChanged('2000-01-01');
      await t.pump();
      await t.enterText(field('Age in years (if DOB unknown)'), '25');
      await t.pump();
      await submit(t);
      expect(sent().containsKey('birth_on') && sent().containsKey('age_years'), isFalse);
      expect(sent()['age_years'], 25);
    });

    testWidgets('sex radios map: Male/Female/Other/Prefer not to say -> male/female/other/unknown', (t) async {
      final wire = <String>[];
      for (final s in ['Male', 'Female', 'Other', 'Prefer not to say']) {
        api.created.clear();
        await open(t);
        await fill(t, sex: s);
        await submit(t);
        wire.add(sent()['sex'] as String);
      }
      expect(wire, ['male', 'female', 'other', 'unknown']);
    });

    testWidgets('switches off -> sms_consent / whatsapp_consent false', (t) async {
      await open(t);
      await fill(t);
      for (final s in t.widgetList<Switch>(find.byType(Switch)).toList().indexed) {
        await t.ensureVisible(find.byType(Switch).at(s.$1));
        await t.tap(find.byType(Switch).at(s.$1));
        await t.pump();
      }
      await submit(t);
      expect(sent()['sms_consent'], isFalse);
      expect(sent()['whatsapp_consent'], isFalse);
    });

    testWidgets('the name is NFC-normalised and trimmed (04-UI-UX: LimsTextField NFC)', (t) async {
      await open(t);
      await fill(t, name: '  Réna Synthetic ');
      await submit(t);
      expect(sent()['full_name'], 'Réna Synthetic');
    });

    testWidgets('double tap on Create record sends one E16 and shows a spinner meanwhile', (t) async {
      final gate = Completer<Object?>();
      api.onCreate = (_, __) => gate.future;
      await open(t);
      await fill(t);
      await t.ensureVisible(find.text(create));
      await t.tap(find.text(create));
      await t.tap(find.text(create), warnIfMissed: false);
      await t.pump();
      expect(api.createCalls, 1);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      gate.complete(selfReg());
      await settle(t);
    });
  });

  group('errors (US-EN-05.3/.4; 03-APP-FLOW §10.1 A9)', () {
    Future<void> failWith(WidgetTester t, Object e, {bool child = false}) async {
      api.onCreate = (_, __) async => throw e;
      await open(t);
      await fill(t, child: child);
      await submit(t);
    }

    testWidgets('400 with /age_years: the server message shows inline, the form keeps what was typed, no polling starts', (t) async {
      await failWith(
        t,
        LimsException(LimsErrorCodes.commonValidationFailed,
            fieldErrors: const [FieldError(path: '/age_years', code: 'common.validation_failed', message: 'Age must be below the child age limit.')]),
        child: true,
      );
      expect(find.text('Age must be below the child age limit.'), findsOneWidget);
      expect(find.text(longName), findsOneWidget, reason: 'typed name is kept');
      await t.pump(const Duration(seconds: 30));
      expect(api.getRegCalls, 0);
    });

    testWidgets('400 with /birth_on shows next to the date of birth', (t) async {
      await failWith(
        t,
        LimsException(LimsErrorCodes.commonValidationFailed,
            fieldErrors: const [FieldError(path: '/birth_on', code: 'common.validation_failed', message: 'Date of birth is too recent for a child record.')]),
        child: true,
      );
      expect(find.text('Date of birth is too recent for a child record.'), findsOneWidget);
    });

    testWidgets('400 /consent_text_version (the text changed): words, and E1 is read again so the next try uses the new version', (t) async {
      var cfgN = 0;
      final cfg = FakeConfigApi(() => configBody(textVersion: ++cfgN == 1 ? '2026-01' : '2026-02'));
      api.onCreate = (_, n) async => n == 1
          ? throw LimsException(LimsErrorCodes.commonValidationFailed, fieldErrors: const [FieldError(path: '/consent_text_version', code: 'common.validation_failed', message: 'x')])
          : selfReg();
      await open(t, config: cfg);
      await fill(t);
      await submit(t);
      expect(find.byIcon(kErrIcon), findsWidgets, reason: 'words + icon; the exact sentence is the writer\'s (spec silent)');
      expect(cfg.configCalls, greaterThanOrEqualTo(2));
      expect(t.widget<Checkbox>(find.byType(Checkbox)).value, isFalse, reason: 'consent must be given again for the new text');
      await t.tap(find.byType(Checkbox));
      await submit(t);
      expect(api.created.last['consent_text_version'], '2026-02');
    });

    testWidgets('403 common.feature_disabled -> "Registration happens at the lab"', (t) async {
      await failWith(t, LimsException(LimsErrorCodes.commonFeatureDisabled));
      expect(find.textContaining('Registration happens at the lab'), findsOneWidget);
      expect(find.byIcon(kErrIcon), findsWidgets);
    });

    testWidgets('409 link_limit_reached -> "You have the maximum number of profiles."', (t) async {
      await failWith(t, LimsException(LimsErrorCodes.engagementLinkLimitReached));
      expect(find.text(copyLimit), findsOneWidget);
    });

    testWidgets('429 -> "Too many tries. Try again in an hour."', (t) async {
      await failWith(t, LimsException(LimsErrorCodes.commonRateLimited));
      expect(find.text(copyTooMany), findsOneWidget);
    });

    testWidgets('anything else: generic words; no code, no server detail, no personal data in the message', (t) async {
      await failWith(t, LimsException('common.internal', safeDetail: 'Asha Kumari Synthetic row 7'));
      expect(find.text('Something went wrong. Try again.'), findsOneWidget);
      expect(find.textContaining('common.internal'), findsNothing);
      expect(find.textContaining('row 7'), findsNothing);
    });
  });

  group('creating the record (E17 polling, US-EN-05.1/.5; 03-APP-FLOW §3.3)', () {
    Future<void> registerQueued(WidgetTester t, {void Function(String)? onCreated}) async {
      await open(t, onCreated: onCreated);
      await fill(t);
      await submit(t);
    }

    testWidgets('202 queued: spinner and "Creating your record…"; the form is replaced, not editable', (t) async {
      api.onGetReg = (_, __) async => selfReg();
      await registerQueued(t);
      expect(find.text('Creating your record…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      expect(find.text(create), findsNothing);
    });

    testWidgets('polls E17 for the id the 202 returned: first poll about 2 s after, then every 2 s, none sooner', (t) async {
      final ids = <String>[];
      api.onGetReg = (id, _) async {
        ids.add(id);
        return selfReg();
      };
      await registerQueued(t);
      await t.pump(const Duration(milliseconds: 1500));
      expect(api.getRegCalls, 0, reason: 'not before ~2 s');
      await t.pump(const Duration(milliseconds: 600));
      expect(api.getRegCalls, 1);
      await t.pump(const Duration(seconds: 2));
      expect(api.getRegCalls, 2);
      expect(ids.toSet(), {regId});
    });

    testWidgets('stops polling after 20 s (<= 10 polls) and shows words; pull-to-refresh asks once more', (t) async {
      api.onGetReg = (_, __) async => selfReg();
      await registerQueued(t);
      for (var i = 0; i < 40; i++) {
        await t.pump(const Duration(seconds: 1));
      }
      final after20 = api.getRegCalls;
      expect(after20, inInclusiveRange(9, 11));
      await t.pump(const Duration(seconds: 60));
      expect(api.getRegCalls, after20, reason: 'no polling after 20 s');
      expect(find.text(create), findsNothing);
      await t.drag(find.byType(Scrollable).first, const Offset(0, 1000)); // view is 800x3200: RefreshIndicator arms at 25% of viewport (T-L6 ruling)
      await t.pump(const Duration(milliseconds: 100));
      await t.pump(const Duration(seconds: 1));
      await t.pump(const Duration(seconds: 1));
      expect(api.getRegCalls, after20 + 1);
    });

    testWidgets('created: "Profile created", onCreated(profile_id from E17), polling stops', (t) async {
      api.onGetReg = (_, n) async => n < 2 ? selfReg() : selfReg(status: 'created', profileId: newProfileId);
      String? created;
      await registerQueued(t, onCreated: (id) => created = id);
      await t.pump(const Duration(seconds: 2));
      await t.pump(const Duration(seconds: 2));
      await settle(t);
      expect(find.text('Profile created'), findsOneWidget);
      expect(created, newProfileId);
      final n = api.getRegCalls;
      await t.pump(const Duration(seconds: 30));
      expect(api.getRegCalls, n);
    });

    testWidgets('failed (US-EN-05.5): words and [Try again]; failure_code is not shown; no "Profile created"', (t) async {
      api.onGetReg = (_, __) async => selfReg(status: 'failed', failureCode: 'frontdesk.unavailable');
      await registerQueued(t);
      await t.pump(const Duration(seconds: 2));
      await settle(t);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.textContaining('frontdesk.unavailable'), findsNothing);
      expect(find.text('Profile created'), findsNothing);
      expect(find.byIcon(kErrIcon), findsWidgets);
    });

    testWidgets('[Try again] sends the same details as a NEW E16 and polls the new id', (t) async {
      var posts = 0;
      api.onCreate = (_, __) async => selfReg(id: ++posts == 1 ? regId : '01950c16-0000-7000-8000-0000000000b2');
      api.onGetReg = (id, _) async => id == regId ? selfReg(status: 'failed', failureCode: 'x') : selfReg(status: 'created', profileId: newProfileId);
      String? created;
      await registerQueued(t, onCreated: (id) => created = id);
      await t.pump(const Duration(seconds: 2));
      await settle(t);
      await t.tap(find.text('Try again'));
      await settle(t);
      expect(api.createCalls, 2);
      expect(api.created[1], api.created[0]);
      await t.pump(const Duration(seconds: 2));
      await settle(t);
      expect(created, newProfileId);
    });

    testWidgets('a transient E17 error does not end the wait; the next poll goes on', (t) async {
      api.onGetReg = (_, n) async => n == 1 ? throw LimsException('common.internal') : selfReg(status: 'created', profileId: newProfileId);
      String? created;
      await registerQueued(t, onCreated: (id) => created = id);
      await t.pump(const Duration(seconds: 2));
      await t.pump(const Duration(seconds: 2));
      await settle(t);
      expect(created, newProfileId);
    });

    testWidgets('leaving the screen cancels the poll timer (no E17 after dispose)', (t) async {
      api.onGetReg = (_, __) async => selfReg();
      await registerQueued(t);
      await t.pump(const Duration(seconds: 2));
      final n = api.getRegCalls;
      await t.pumpWidget(const SizedBox());
      await t.pump(const Duration(seconds: 30));
      expect(api.getRegCalls, n);
      expect(t.takeException(), isNull);
    });
  });
}
