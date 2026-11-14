// T-N1 — 04-UI-UX A22 Enquiries (list / thread / new); 03-APP-FLOW §10.1 (A22 row: "No messages" + [New message], skeleton, 409 "This conversation is closed", thread); PRD US-EN-18.1 / 18.2 / 18.4;
// 07-SECURITY §3 (enquiry text is P3: no local store, never logged). Field rules (04-UI-UX A22): Topic coded (T3b enquiry_categories) required; About (profile) optional; Subject <= 120 required;
// Message <= 2000 required, with a counter. Thread: bubbles (patient right, lab left) with timestamps; reply box disabled when closed ("This conversation is closed.").
// Choices the brief left open (cite if disputed): button labels "New message" and "Send"; controls labelled "Topic", "About", "Subject", "Message" (new) and "Reply" (thread), opened by tapping the label,
//   options = the display strings of the coded set / profile names; counter text "<n> / <max>"; status words "Open" / "Answered" / "Closed"; copy for 409 on create "You have too many open messages. Wait for a reply first.",
//   403 common.feature_disabled "Messages are turned off for now."; 409 version_conflict on reply -> the thread is fetched again and the typed text stays.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/enquiries/enquiry_thread_screen.dart';
import 'package:patient_app/features/enquiries/enquiries_screen.dart';
import 'package:patient_app/features/enquiries/new_enquiry_screen.dart';

import '../../support/enquiries_fakes.dart';

Iterable<String> allText(WidgetTester t) => t.widgetList<Text>(find.byType(Text)).map((w) => w.data ?? w.textSpan?.toPlainText() ?? '');
Finder field(String label) => find.widgetWithText(TextField, label);
Future<void> pick(WidgetTester t, String control, String option) async {
  await t.tap(find.text(control).first);
  await settle(t);
  await t.tap(find.text(option).last);
  await settle(t);
}

void main() {
  group('list (A22)', () {
    testWidgets('loading: skeleton while E48 is open; empty: "No messages" + [New message] that calls onNew', (tester) async {
      final c = Completer<void>();
      final api = FakeEnquiriesApi()..hold = c.future;
      var newTaps = 0;
      await tester.pumpWidget(hostWith(EnquiriesScreen(onNew: () => newTaps++), api));
      await tester.pump();
      expect(find.byType(LimsLoading), findsOneWidget);
      c.complete();
      await settle(tester);
      expect(find.byType(LimsEmptyState), findsOneWidget);
      expect(find.text('No messages'), findsOneWidget);
      await tester.tap(find.text('New message'));
      expect(newTaps, 1);
    });

    testWidgets('rows show the subject and a status word (Open / Answered / Closed, not colour only); newest first as sent; tap -> onOpen(id)', (tester) async {
      final api = FakeEnquiriesApi(threads: [
        threadWire(id: enqId(1), subject: 'First subject (synthetic)'),
        threadWire(id: enqId(2), subject: 'Second subject (synthetic)', status: 'answered'),
        threadWire(id: enqId(3), subject: 'Third subject (synthetic)', status: 'closed'),
      ]);
      String? opened;
      await tester.pumpWidget(hostWith(EnquiriesScreen(onOpen: (id) => opened = id), api));
      await settle(tester);
      for (final s in ['First subject (synthetic)', 'Second subject (synthetic)', 'Third subject (synthetic)', 'Open', 'Answered', 'Closed']) {
        expect(find.text(s), findsOneWidget, reason: s);
      }
      expect(find.byType(LimsStatusChip), findsNWidgets(3));
      await tester.tap(find.text('Second subject (synthetic)'));
      expect(opened, enqId(2));
    });

    testWidgets('error: LimsErrorState with [Retry]; Retry asks again', (tester) async {
      final api = FakeEnquiriesApi(threads: [threadWire(id: enqId(1))])..onListOverride = (n) async => n == 1 ? throw LimsException('common.internal') : pageOf([summaryWire(id: enqId(1))]);
      await tester.pumpWidget(hostWith(EnquiriesScreen(), api));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await settle(tester);
      expect(api.listCalls, 2);
      expect(find.text('Where is my report? (synthetic)'), findsOneWidget);
    });

    testWidgets('A22 is a PHI screen (LimsSecureScreen) built on LimsScaffold; message text never appears in the list (only subjects)', (tester) async {
      final api = FakeEnquiriesApi(threads: [threadWire(id: enqId(1), messages: [msg('patient', 'PRIVATE-body-text')])]);
      await tester.pumpWidget(hostWith(EnquiriesScreen(), api));
      await settle(tester);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.byType(LimsScaffold), findsOneWidget);
      expect(allText(tester), isNot(contains('PRIVATE-body-text')));
    });
  });

  group('new (US-EN-18.1)', () {
    testWidgets('loads the Topic options from T3b enquiry_categories; Subject allows 120 and Message 2000 characters, each with a counter', (tester) async {
      final api = FakeEnquiriesApi();
      await tester.pumpWidget(hostWith(const NewEnquiryScreen(), api));
      await settle(tester);
      expect(api.codedSets, ['enquiry_categories']);
      expect(tester.widget<TextField>(field('Subject')).maxLength, 120);
      expect(tester.widget<TextField>(field('Message')).maxLength, 2000);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('[Send] stays disabled until Topic, Subject and Message are filled; then E49 gets category_code / subject / message and onCreated gets the new id', (tester) async {
      final api = FakeEnquiriesApi();
      String? created;
      await tester.pumpWidget(hostWith(NewEnquiryScreen(onCreated: (id) => created = id), api));
      await settle(tester);
      Finder send() => find.widgetWithText(FilledButton, 'Send');
      expect(tester.widget<FilledButton>(send()).onPressed, isNull);
      await tester.enterText(field('Subject'), 'Where is my report?');
      await tester.enterText(field('Message'), 'Synthetic message text.');
      await settle(tester);
      expect(tester.widget<FilledButton>(send()).onPressed, isNull); // no topic yet
      await pick(tester, 'Topic', 'Report');
      expect(tester.widget<FilledButton>(send()).onPressed, isNotNull);
      await tester.tap(send());
      await settle(tester);
      expect(api.created, [(category: 'report', subject: 'Where is my report?', message: 'Synthetic message text.', profileId: null)]);
      expect(created, isNotNull);
    });

    testWidgets('About (optional): choosing a profile sends its id as profile_id', (tester) async {
      final api = FakeEnquiriesApi();
      await tester.pumpWidget(hostWith(NewEnquiryScreen(onCreated: (_) {}), api));
      await settle(tester);
      await pick(tester, 'Topic', 'Booking');
      await pick(tester, 'About', 'Asha Test (synthetic)');
      await tester.enterText(field('Subject'), 's');
      await tester.enterText(field('Message'), 'm');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(api.created.single.profileId, eSelf);
      expect(api.created.single.category, 'booking');
    });

    testWidgets('409 engagement.enquiry_invalid_transition (open-limit) -> a plain message, the form keeps its text, nothing navigates', (tester) async {
      final api = FakeEnquiriesApi()..onCreateOverride = (_) async => throw LimsException('engagement.enquiry_invalid_transition');
      String? created;
      await tester.pumpWidget(hostWith(NewEnquiryScreen(onCreated: (id) => created = id), api));
      await settle(tester);
      await pick(tester, 'Topic', 'Other');
      await tester.enterText(field('Subject'), 'kept subject');
      await tester.enterText(field('Message'), 'kept message');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(find.text('You have too many open messages. Wait for a reply first.'), findsOneWidget);
      expect(created, isNull);
      expect(find.text('kept subject'), findsOneWidget);
      expect(find.text('kept message'), findsOneWidget);
    });

    testWidgets('403 common.feature_disabled -> "Messages are turned off for now."', (tester) async {
      final api = FakeEnquiriesApi()..onCreateOverride = (_) async => throw LimsException('common.feature_disabled');
      await tester.pumpWidget(hostWith(NewEnquiryScreen(onCreated: (_) {}), api));
      await settle(tester);
      await pick(tester, 'Topic', 'Other');
      await tester.enterText(field('Subject'), 's');
      await tester.enterText(field('Message'), 'm');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(find.text('Messages are turned off for now.'), findsOneWidget);
    });

    testWidgets('a double tap on [Send] creates one enquiry (the button is busy while E49 runs)', (tester) async {
      final c = Completer<Object?>();
      final api = FakeEnquiriesApi()..onCreateOverride = (_) => c.future;
      await tester.pumpWidget(hostWith(NewEnquiryScreen(onCreated: (_) {}), api));
      await settle(tester);
      await pick(tester, 'Topic', 'Other');
      await tester.enterText(field('Subject'), 's');
      await tester.enterText(field('Message'), 'm');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'), warnIfMissed: false);
      await tester.pump();
      expect(api.created, hasLength(1));
      c.complete(threadWire(id: enqId(9)));
      await settle(tester);
    });
  });

  group('thread (US-EN-18.2, 18.4)', () {
    FakeEnquiriesApi answered() => FakeEnquiriesApi(threads: [
          threadWire(id: enqId(1), status: 'answered', version: 4, messages: [msg('patient', 'Patient question text', at: '2026-11-04T10:00:00.000Z'), msg('staff', 'Lab answer text', at: '2026-11-04T12:30:00.000Z')]),
        ]);

    testWidgets('bubbles: the patient message sits right of the lab message; each has a timestamp; messages in order', (tester) async {
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), answered()));
      await settle(tester);
      final mine = tester.getTopRight(find.text('Patient question text'));
      final lab = tester.getTopRight(find.text('Lab answer text'));
      expect(mine.dx, greaterThan(lab.dx));
      expect(tester.getTopLeft(find.text('Patient question text')).dy, lessThan(tester.getTopLeft(find.text('Lab answer text')).dy));
      expect(allText(tester).where((t) => RegExp(r'\d{1,2}[:.]\d{2}').hasMatch(t) || t.contains('2026') || t.contains('Nov')), isNotEmpty);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('Reply: [Send] posts the text with the thread version (If-Match source), clears the box and shows the returned thread', (tester) async {
      final api = answered();
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      await tester.enterText(field('Reply'), 'Synthetic follow-up');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(api.replied, [(id: enqId(1), message: 'Synthetic follow-up', version: 4)]);
      expect(find.text('Synthetic follow-up'), findsOneWidget); // now a bubble, no longer only in the box
      expect(tester.widget<TextField>(field('Reply')).controller!.text, isEmpty);
    });

    testWidgets('an empty reply cannot be sent; the box allows 2000 characters', (tester) async {
      final api = answered();
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      expect(tester.widget<TextField>(field('Reply')).maxLength, 2000);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Send')).onPressed, isNull);
      expect(api.replyCalls, 0);
    });

    testWidgets('closed: the reply box is disabled with "This conversation is closed." and nothing can be sent', (tester) async {
      final api = FakeEnquiriesApi(threads: [threadWire(id: enqId(3), status: 'closed', version: 5)]);
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(3)), api));
      await settle(tester);
      expect(find.text('This conversation is closed.'), findsOneWidget);
      final box = find.widgetWithText(TextField, 'Reply');
      expect(box.evaluate().isEmpty || !tester.widget<TextField>(box).enabled!, isTrue);
      final send = find.widgetWithText(FilledButton, 'Send');
      expect(send.evaluate().isEmpty || tester.widget<FilledButton>(send).onPressed == null, isTrue);
      expect(api.replyCalls, 0);
    });

    testWidgets('409 engagement.enquiry_invalid_transition on reply (closed meanwhile) -> "This conversation is closed." and the box is disabled', (tester) async {
      final api = answered()..onReplyOverride = (r, n) async => throw LimsException('engagement.enquiry_invalid_transition');
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      await tester.enterText(field('Reply'), 'too late');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(find.text('This conversation is closed.'), findsOneWidget);
      final box = find.widgetWithText(TextField, 'Reply');
      expect(box.evaluate().isEmpty || !tester.widget<TextField>(box).enabled!, isTrue);
    });

    testWidgets('409 common.version_conflict on reply -> the thread is fetched again; the typed text is kept', (tester) async {
      final api = answered()..onReplyOverride = (r, n) async => throw LimsException('common.version_conflict');
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      await tester.enterText(field('Reply'), 'keep me');
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await settle(tester);
      expect(api.getCalls, 2);
      expect(tester.widget<TextField>(field('Reply')).controller!.text, 'keep me');
    });

    testWidgets('error on load -> LimsErrorState with Retry; unknown / foreign id (404) is an error state, not a crash', (tester) async {
      final api = FakeEnquiriesApi(); // enqId(1) is unknown to this fake -> common.not_found
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('message text is rendered as plain text (markup in a message is shown, not interpreted)', (tester) async {
      final api = FakeEnquiriesApi(threads: [threadWire(id: enqId(1), messages: [msg('staff', '<b>bold</b> **x**')])]);
      await tester.pumpWidget(hostWith(EnquiryThreadScreen(enquiryId: enqId(1)), api));
      await settle(tester);
      expect(find.text('<b>bold</b> **x**'), findsOneWidget);
    });
  });
}
