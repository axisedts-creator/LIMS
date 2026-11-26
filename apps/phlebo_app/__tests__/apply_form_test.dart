// PHLEBO-UI-FULL-1: the application form's rules and screen. Synthetic data only.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/app/theme.dart';
import 'package:phlebo_app/features/apply/domain/application.dart';
import 'package:phlebo_app/features/apply/ui/apply_screen.dart';

PickedFile _file(String name, [int size = 10]) => PickedFile(name: name, bytes: List.filled(size, 1));

ApplicationDraft _complete() {
  final d = ApplicationDraft()
    ..fullName = 'Sita Demo'
    ..phone = '9800000001'
    ..email = 'Sita@Example.Test'
    ..area = 'Demo Tole'
    ..employment = Employment.fullTime
    ..declared = true;
  for (final k in DocKind.values) {
    d.documents[k]!.add(_file(k == DocKind.photo ? 'me.jpg' : 'doc.pdf'));
  }
  return d;
}

void main() {
  group('Nepal mobile number', () {
    test('accepts the forms people type and returns E.164', () {
      for (final ok in ['9800000001', '98 0000 0001', '980-000-0001', '+9779800000001', '9779800000001', '09800000001', '9700000001', '9600000001']) {
        expect(nepalMobileToE164(ok), matches(RegExp(r'^\+9779[678]\d{8}$')), reason: ok);
      }
      expect(nepalMobileToE164('98 0000 0001'), '+9779800000001');
    });

    test('rejects landlines, short, long, foreign and junk input', () {
      for (final bad in ['', '980000000', '98000000011', '9500000001', '014000000', '+919800000001', '98000abcde', '+977', "9800000001'; DROP", '９８００００００0１']) {
        expect(nepalMobileToE164(bad), isNull, reason: bad);
      }
    });
  });

  group('rules', () {
    test('a complete full-time application has no problems and sends no shift fields', () {
      final d = _complete();
      expect(d.problems(), isEmpty);
      expect(d.toJson(), {'full_name': 'Sita Demo', 'phone_e164': '+9779800000001', 'email': 'sita@example.test', 'area': 'Demo Tole', 'employment_type': 'full_time'});
    });

    test('part time needs a shift count and exactly that many times of day', () {
      final d = _complete()..employment = Employment.partTime;
      expect(d.problems().keys, ['shift']);
      d.shiftCount = ShiftCount.single;
      expect(d.problems().keys, ['slots']);
      d.slots.add(DaySlot.evening);
      expect(d.problems(), isEmpty);
      d.shiftCount = ShiftCount.double;
      expect(d.problems().keys, ['slots']);
      d.slots.add(DaySlot.morning);
      expect(d.problems(), isEmpty);
      expect(d.toJson()['day_slots'], ['morning', 'evening']);
      expect(d.toJson()['shift_count'], 'double');
    });

    test('every document kind and the declaration are required', () {
      final d = _complete()..declared = false;
      d.documents[DocKind.identity]!.clear();
      expect(d.problems().keys, containsAll(['doc.identity', 'declared']));
    });

    test('files: type, empty and size limits; a photo cannot be a PDF', () {
      expect(_file('a.pdf').problem(DocKind.licence), isNull);
      expect(_file('a.PNG').problem(DocKind.photo), isNull);
      expect(_file('a.pdf').problem(DocKind.photo), isNotNull);
      expect(_file('a.exe').problem(DocKind.licence), isNotNull);
      expect(_file('noextension').problem(DocKind.licence), isNotNull);
      expect(_file('a.jpg', 0).problem(DocKind.licence), isNotNull);
      expect(_file('a.jpg', maxFileBytes + 1).problem(DocKind.licence), isNotNull);
    });
  });

  group('screen', () {
    Future<void> pump(WidgetTester t, {required Future<String?> Function(ApplicationDraft) submit, PickedFile? pick}) async {
      t.view.physicalSize = const Size(400, 3000); // tall: the whole form is built
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(MaterialApp(
        theme: phleboTheme(),
        home: ApplyScreen(pickFile: (_) async => pick, submit: submit, onClose: () {}),
      ));
      await t.pump(const Duration(milliseconds: 600));
    }

    testWidgets('nothing is sent while details are missing', (t) async {
      var sent = 0;
      await pump(t, submit: (_) async {
        sent++;
        return null;
      });
      await t.tap(find.byKey(const ValueKey('apply.send')));
      await t.pump();
      expect(sent, 0);
      expect(find.text('Enter your full name.'), findsOneWidget);
      expect(find.text('Choose full time or part time.'), findsOneWidget);
    });

    testWidgets('a filled form is sent once; a server refusal keeps the form; success shows what happens next', (t) async {
      final drafts = <ApplicationDraft>[];
      String? answer = "Couldn't send. Check your connection and try again.";
      await pump(t, pick: _file('doc.jpg'), submit: (d) async {
        drafts.add(d);
        return answer;
      });
      await t.enterText(find.byKey(const ValueKey('apply.name')), 'Sita Demo');
      await t.enterText(find.byKey(const ValueKey('apply.phone')), '9800000001');
      await t.enterText(find.byKey(const ValueKey('apply.email')), 'sita@example.test');
      await t.enterText(find.byKey(const ValueKey('apply.area')), 'Demo Tole');
      await t.tap(find.text('Full time'));
      for (final k in DocKind.values) {
        await t.tap(find.byKey(ValueKey('apply.add.${k.name}')));
        await t.pump();
      }
      await t.tap(find.byKey(const ValueKey('apply.declared')));
      await t.pump();
      await t.tap(find.byKey(const ValueKey('apply.send')));
      await t.pump();
      await t.pump();
      expect(drafts, hasLength(1));
      expect(find.text(answer), findsOneWidget);
      expect(find.text('Sita Demo'), findsOneWidget, reason: 'the form is kept after a failure');

      answer = null;
      await t.tap(find.byKey(const ValueKey('apply.send')));
      await t.pump();
      await t.pump();
      expect(drafts, hasLength(2));
      expect(find.text('Back to sign in'), findsOneWidget);
      expect(find.textContaining('SMS'), findsOneWidget);
    });

    testWidgets('a bad file is refused with a reason and not added', (t) async {
      await pump(t, pick: _file('virus.exe'), submit: (_) async => null);
      await t.tap(find.byKey(const ValueKey('apply.add.licence')));
      await t.pump();
      expect(find.text('Use a JPG, PNG or PDF file.'), findsOneWidget);
      expect(find.text('virus.exe'), findsNothing);
    });
  });
}
