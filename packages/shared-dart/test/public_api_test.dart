// T0A-11 / AC-0A-2.3, 3.1, 4.2 — `lims_shared` package completeness (TRD §3.4), unit.
// Everything here goes through the PUBLIC barrel `package:lims_shared/lims_shared.dart` only.
// ASSUMED (see .orchestra/notes/T0A-11-tests.md), in lib/src/errors.dart, exported by the barrel:
//   class FieldError { const FieldError({required String path, required String code, required String message}); }
//   class LimsException implements Exception {
//     LimsException(String code, {String? safeDetail, List<FieldError>? fieldErrors});  // IC §4.1 LimsError shape
//     final String code; final String? safeDetail; final List<FieldError>? fieldErrors; }
//   `code` is a String holding a LimsErrorCodes.* value (error_codes.g.dart, T0C-05 codegen).
// The barrel also exports error_codes.g.dart, routes.g.dart, uuidv7.dart, money.dart, bsdate.dart.
// bsdate throws LimsException (replacing the interim BsDateError of T0A-06).
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/lims_shared.dart' as l;
import 'package:test/test.dart';

String _read(String p) => File(p).readAsStringSync();
Map<String, dynamic> _json(String p) => jsonDecode(_read(p)) as Map<String, dynamic>;
List<Map<String, dynamic>> _list(Object? v) => (v! as List<Object?>).cast<Map<String, dynamic>>();
List<int> _ints(Object? v) => (v! as List<Object?>).cast<int>();
List<int> _hex(String h) =>
    <int>[for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)];

Matcher _limsError(String code) =>
    throwsA(isA<l.LimsException>().having((e) => e.code, 'code', code));

void main() {
  group('LimsException (errors.dart, consumes the generated codes)', () {
    test('carries code, safeDetail, fieldErrors; is an Exception', () {
      const fe = l.FieldError(
          path: 'body.name', code: l.LimsErrorCodes.commonFieldRequired, message: 'required');
      final e = l.LimsException(l.LimsErrorCodes.commonValidationFailed,
          safeDetail: 'bad body', fieldErrors: <l.FieldError>[fe]);
      expect(e, isA<Exception>());
      expect(e.code, 'common.validation_failed');
      expect(e.safeDetail, 'bad body');
      expect(e.fieldErrors, hasLength(1));
      expect(e.fieldErrors!.single.path, 'body.name');
      expect(e.fieldErrors!.single.code, 'common.field_required');
      expect(e.fieldErrors!.single.message, 'required');
      expect(e.toString(), contains('common.validation_failed'));
    });

    test('safeDetail / fieldErrors are optional and default to null', () {
      final e = l.LimsException(l.LimsErrorCodes.commonInternal);
      expect(e.safeDetail, isNull);
      expect(e.fieldErrors, isNull);
    });
  });

  group('generated codegen output is consumed and in sync with contracts/errors.yaml', () {
    final rows = RegExp(r'code:\s*([a-z0-9_.]+)\s*,\s*http:\s*(\d+)')
        .allMatches(_read('../../contracts/errors.yaml'))
        .map((m) => MapEntry<String, int>(m[1]!, int.parse(m[2]!)))
        .toList();

    test('errors.yaml parsed (sanity)', () {
      expect(rows.length, greaterThan(250));
      expect(rows.map((r) => r.key).toSet().length, rows.length);
    });

    test('limsErrorHttpStatus equals errors.yaml code -> http, exactly', () {
      expect(l.limsErrorHttpStatus.length, rows.length);
      for (final r in rows) {
        expect(l.limsErrorHttpStatus[r.key], r.value, reason: r.key);
      }
    });

    test('every LimsErrorCodes constant is a registered code (no drift in the .g.dart)', () {
      final consts = RegExp(r"static const String \w+ = '([a-z0-9_.]+)';")
          .allMatches(_read('lib/src/error_codes.g.dart'))
          .map((m) => m[1]!)
          .toSet();
      expect(consts, rows.map((r) => r.key).toSet());
      expect(l.LimsErrorCodes.commonDateOutOfRange, 'common.date_out_of_range');
      expect(l.limsErrorHttpStatus[l.LimsErrorCodes.commonDateOutOfRange], 422);
    });

    test('limsRoutePaths is exported and well-formed', () {
      expect(l.limsRoutePaths, isNotEmpty);
      for (final e in l.limsRoutePaths.entries) {
        expect(e.value, startsWith('/'), reason: e.key);
      }
      expect(l.limsRoutePaths['portal.qr_verify'], '/v/{qr_token}');
    });
  });

  group('bsdate errors are LimsException (TRD §3.4), not an interim type', () {
    test('out of range -> common.date_out_of_range (AC-0A-3.2 via barrel)', () {
      expect(() => l.adToBs('1900-01-01'), _limsError('common.date_out_of_range'));
      expect(() => l.bsToAd(const l.BsDate(2100, 1, 1)), _limsError('common.date_out_of_range'));
      expect(() => l.fiscalYearBs('2100-01-01'), _limsError('common.date_out_of_range'));
    });
    test('malformed -> common.validation_failed', () {
      expect(() => l.adToBs('not-a-date'), _limsError('common.validation_failed'));
      expect(() => l.bsToAd(const l.BsDate(2082, 13, 1)), _limsError('common.validation_failed'));
    });
    test('no BsDateError left in lib/', () {
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
        expect(f.readAsStringSync(), isNot(contains('BsDateError')), reason: f.path);
      }
    });
  });

  group('AC-0A-2.3 uuidv7 shared fixture via barrel', () {
    test('buildUuidv7 reproduces every vector', () {
      final v = _list(_json('../test-fixtures/uuidv7/vectors.json')['vectors']);
      expect(v.length, greaterThanOrEqualTo(5));
      for (final x in v) {
        expect(l.buildUuidv7(x['unixMs']! as int, _hex(x['randHex']! as String)), x['expected'],
            reason: '${x['name']}');
      }
    });
    test('public generators are exported and Uuidv7-shaped', () {
      final next = l.createSeededUuidv7(seed: 42, startMs: 1700000000000);
      final a = next(), b = next();
      expect(l.isUuidv7(a), isTrue);
      expect(a.compareTo(b), lessThan(0));
      expect(l.uuidv7Timestamp(a), 1700000000000);
      expect(l.isUuidv7(l.uuidv7()), isTrue);
    });
  });

  group('AC-0A-3.1 bsdate golden via barrel', () {
    test('every month first day both ways (1200 months)', () {
      final ms = _list(_json('../test-fixtures/bsdate/golden-2000-2099.json')['months']);
      expect(ms.length, 1200);
      for (final r in ms) {
        final y = r['bs_year']! as int, m = r['bs_month']! as int, days = r['days']! as int;
        final first = r['ad_first_day']! as String;
        expect(l.daysInBsMonth(y, m), days, reason: '$y-$m');
        expect(l.bsToAd(l.BsDate(y, m, 1)), first, reason: '$y-$m');
        expect(l.adToBs(first), l.BsDate(y, m, 1), reason: '$y-$m');
        expect(l.formatBs(l.BsDate(y, m, 1)),
            '${y.toString().padLeft(4, '0')}-${m.toString().padLeft(2, '0')}-01');
      }
    });
  });

  group('AC-0A-4.2 money golden via barrel', () {
    test('every case equals the fixture (>= 200)', () {
      final cs = _list(_json('../test-fixtures/money/golden.json')['cases']);
      expect(cs.length, greaterThanOrEqualTo(200));
      l.Money m(Object? n) => l.money(n! as int);
      for (final c in cs) {
        final id = '${c['id']}';
        switch (c['op']) {
          case 'percentOf':
            expect(l.percentOf(m(c['amountPaisa']), c['bp']! as int).amountPaisa, c['expected'], reason: id);
          case 'mulQty':
            expect(l.mulQty(m(c['amountPaisa']), c['qty']! as int).amountPaisa, c['expected'], reason: id);
          case 'add':
            expect(l.add(_ints(c['amounts']).map(l.money).toList()).amountPaisa, c['expected'], reason: id);
          case 'sub':
            expect(l.sub(m(c['a']), m(c['b'])).amountPaisa, c['expected'], reason: id);
          case 'compare':
            expect(l.compare(m(c['a']), m(c['b'])), c['expected'], reason: id);
          case 'allocate':
            expect(l.allocate(m(c['totalPaisa']), _ints(c['weights'])).map((x) => x.amountPaisa).toList(),
                _ints(c['expected']), reason: id);
          case 'format':
            expect(
                l.format(m(c['amountPaisa']),
                    grouping: (c['grouping'] as String?) ?? 'lakh', symbol: (c['symbol'] as String?) ?? 'Rs.'),
                c['expected'],
                reason: id);
          default:
            fail('unknown op ${c['op']} in $id');
        }
      }
    });
    test('VAT 13% = 1,300 bp, half-up to the paisa (04 L14, CV §4.9)', () {
      expect(l.percentOf(l.money(10050), 1300).amountPaisa, 1307); // 1306.5 -> 1307
      expect(l.percentOf(l.money(10049), 1300).amountPaisa, 1306); // 1306.37 -> 1306
    });
  });

  group('package metadata (done_when: analysis config; package resolves in workspace)', () {
    test('analysis_options.yaml: strict-casts, strict-inference, strict-raw-types (CV §1.3)', () {
      final f = File('analysis_options.yaml');
      expect(f.existsSync(), isTrue, reason: 'packages/shared-dart/analysis_options.yaml missing');
      var text = f.readAsStringSync();
      final inc = RegExp(r'^include:\s*(\S+)\s*$', multiLine: true).firstMatch(text);
      if (inc != null && !inc[1]!.startsWith('package:')) {
        text += File(inc[1]!).readAsStringSync(); // relative include (root analysis_options.yaml)
      }
      for (final k in ['strict-casts', 'strict-inference', 'strict-raw-types']) {
        expect(RegExp('$k:\\s*true').hasMatch(text), isTrue, reason: k);
      }
    });
    test('pubspec: name lims_shared, workspace resolution, listed in the root workspace', () {
      final p = _read('pubspec.yaml');
      expect(p, matches(RegExp(r'^name:\s*lims_shared\s*$', multiLine: true)));
      expect(p, matches(RegExp(r'^resolution:\s*workspace\s*$', multiLine: true)));
      expect(_read('../../pubspec.yaml'), contains('packages/shared-dart'));
    });
    test('barrel exports every module', () {
      final b = _read('lib/lims_shared.dart');
      for (final m in [
        'errors.dart',
        'error_codes.g.dart',
        'routes.g.dart',
        'uuidv7.dart',
        'money.dart',
        'bsdate/bsdate.dart'
      ]) {
        expect(b, contains('src/$m'), reason: m);
      }
      expect(File('lib/src/errors.dart').existsSync(), isTrue);
    });
    test('nepali_utils imported only under lib/src/bsdate (AC-0A-3.4, Dart side)', () {
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
        final p = f.path.replaceAll(r'\', '/');
        if (p.contains('lib/src/bsdate/')) continue;
        expect(f.readAsStringSync(), isNot(contains('package:nepali_utils')), reason: p);
      }
    });
  });
}
