// T-BK1 — source rules widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes / families, inline style objects). 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence of PHI (bookings, addresses).
// 04-UI-UX A19: no map (a map tile server would be a foreign service; latitude / longitude stay empty). 07-SECURITY AB-7: the app never sends patient_id. Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const files = ['bookings_api', 'bookings_providers', 'bookings_list_screen', 'booking_detail_screen', 'booking_wizard_screen', 'addresses_screen'];

List<File> sources() {
  final dir = Directory('lib/features/bookings');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String read(String name) => File('lib/features/bookings/$name.dart').readAsStringSync();

void main() {
  test('the bookings feature exists: api, providers, list (A16), detail (A18), wizard (A17), addresses (A19)', () {
    for (final f in files) {
      expect(File('lib/features/bookings/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/bookings/$f.dart');
    }
  });

  test('screens build on lims_ui: wizard uses LimsSlotPicker, list / detail use LimsStatusChip, every screen is a LimsSecureScreen (PHI, REQ-SEC-109)', () {
    for (final s in ['bookings_list_screen', 'booking_detail_screen', 'booking_wizard_screen', 'addresses_screen']) {
      expect(read(s), contains('package:lims_ui/lims_ui.dart'), reason: s);
      expect(read(s), contains('LimsSecureScreen'), reason: s);
    }
    expect(read('booking_wizard_screen'), contains('LimsSlotPicker'));
    expect(read('booking_wizard_screen'), contains('LimsTextField'));
    expect(read('bookings_list_screen'), contains('LimsStatusChip'));
    expect(read('booking_detail_screen'), contains('LimsStatusChip'));
  });

  test('the wizard debounces the test search at 300 ms (04-UI-UX A17 step 3) and generates its Idempotency-Key from a random source, not from the booking content', () {
    final w = read('booking_wizard_screen');
    expect(RegExp(r'Duration\(\s*milliseconds:\s*300\s*\)').hasMatch(w), isTrue);
    expect(RegExp('idempotency', caseSensitive: false).hasMatch(sources().map((f) => f.readAsStringSync()).join('\n')), isTrue);
    expect(RegExp(r'hashCode|DateTime\.now\(\)\.(millisecond|microsecond)').hasMatch(w), isFalse, reason: 'a content / clock derived key could collide or repeat');
  });

  test('the A.D. / B.S. choice reaches the slot picker through calendarMode (calendarDisplay setting)', () {
    expect(read('booking_wizard_screen'), contains('calendarMode'));
  });

  group('no patient identifiers on the wire (AB-7) and no map', () {
    test('no patient_id / account_id key is built in the bookings feature', () {
      for (final f in sources()) {
        expect(RegExp(r"""['"](patient_id|account_id)['"]""").hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} builds a patient_id / account_id field');
      }
    });
    test('no map / geolocation package and no latitude / longitude input (v1)', () {
      for (final f in sources()) {
        final s = f.readAsStringSync();
        expect(RegExp(r'google_maps|flutter_map|mapbox|geolocator|geocoding|latitude|longitude', caseSensitive: false).hasMatch(s), isFalse, reason: '${f.path} touches maps / coordinates');
      }
    });
  });

  group('LD-140 design-system rules', () {
    final banned = <String, RegExp>{
      'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
      'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
      'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
      'literal font size': RegExp(r'fontSize:\s*\d'),
      'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
      'inline TextStyle / BoxDecoration colour literal': RegExp(r'Colors\.(red|green|blue|orange|grey|black|white)'),
    };
    test('there are sources to check', () => expect(sources(), isNotEmpty));
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/bookings', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log, storage and transport hygiene (PHI: booking, address, profile)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'realtime / websocket / push': RegExp(r'WebSocket|web_socket|supabase|firebase_messaging|realtime', caseSensitive: false),
      'clipboard (address text is P2)': RegExp(r'Clipboard\.setData'),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/bookings', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
