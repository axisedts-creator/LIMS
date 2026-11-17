// T0A-06 / AC-0A-3.1, 3.2, 3.3 (Dart side; TRD §3.4 "same API in Dart naming"; gate 15).
// ASSUMED API (see .orchestra/notes/T0A-06-tests.md), in lib/src/bsdate/bsdate.dart:
//   class BsDate { const BsDate(int year, int month, int day); final int year, month, day; }  (positional ctor)
//   BsDate adToBs(String isoDate);  String bsToAd(BsDate bs);  int daysInBsMonth(int year, int month);
//   ({String short, String long, String startsOn, String endsOn}) or class with those getters: fiscalYearBs(String isoDate);
//   String formatBs(BsDate bs, {String style = 'iso'});   // 'iso' | 'display'
//   Out of range throws LimsException whose `.code` is ErrorCode.commonDateOutOfRange (errors.dart lands in T0A-08;
//   the test only inspects `.code.toString()`).
// Fixture shape: see test/bsdate.test.mjs header.
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/src/bsdate/bsdate.dart';
import 'package:test/test.dart';

Map<String, dynamic> _json(String f) =>
    jsonDecode(File('../test-fixtures/bsdate/$f').readAsStringSync()) as Map<String, dynamic>;
List<Map<String, dynamic>> _months() => (_json('golden-2000-2099.json')['months'] as List).cast();
List<Map<String, dynamic>> _probes() => (_json('golden-2000-2099.json')['probes'] as List).cast();

int _dn(String iso) => DateTime.utc(int.parse(iso.substring(0, 4)), int.parse(iso.substring(5, 7)),
        int.parse(iso.substring(8, 10)))
    .millisecondsSinceEpoch ~/
    86400000;
String _iso(int n) =>
    DateTime.fromMillisecondsSinceEpoch(n * 86400000, isUtc: true).toIso8601String().substring(0, 10);
String _p(int n, int w) => n.toString().padLeft(w, '0');
String _bsIso(int y, int m, int d) => '${_p(y, 4)}-${_p(m, 2)}-${_p(d, 2)}';
String _bs(BsDate b) => _bsIso(b.year, b.month, b.day);
String _fy(int y) => '$y/${_p((y + 1) % 100, 2)}';

Matcher _outOfRange() => throwsA(predicate((Object e) {
      final c = (e as dynamic).code.toString();
      return c == 'common.date_out_of_range' || c.endsWith('commonDateOutOfRange');
    }));

void main() {
  group('AC-0A-3.1 golden', () {
    test('every month: first/last day both ways, daysInBsMonth, day+1 throws', () {
      final ms = _months();
      expect(ms.length, 1200);
      for (final r in ms) {
        final y = r['bs_year'] as int, m = r['bs_month'] as int, days = r['days'] as int;
        final first = r['ad_first_day'] as String;
        final k = '$y-$m';
        expect(daysInBsMonth(y, m), days, reason: k);
        expect(bsToAd(BsDate(y, m, 1)), first, reason: k);
        expect(_bs(adToBs(first)), _bsIso(y, m, 1), reason: k);
        final last = _iso(_dn(first) + days - 1);
        expect(bsToAd(BsDate(y, m, days)), last, reason: k);
        expect(_bs(adToBs(last)), _bsIso(y, m, days), reason: k);
        expect(() => bsToAd(BsDate(y, m, days + 1)), throwsA(anything), reason: k);
      }
    });
    test('every probe converts both ways', () {
      final ps = _probes();
      expect(ps.length, 200);
      for (final p in ps) {
        final ad = p['ad'] as String, bs = p['bs'] as String;
        expect(_bs(adToBs(ad)), bs, reason: 'adToBs $ad');
        final parts = bs.split('-').map(int.parse).toList();
        expect(bsToAd(BsDate(parts[0], parts[1], parts[2])), ad, reason: 'bsToAd $bs');
      }
    });
    test('review.json has zero unresolved entries', () {
      final entries = (_json('review.json')['entries'] as List).cast<Map<String, dynamic>>();
      for (final e in entries) {
        expect(e['status'], 'resolved', reason: '${e['key']}');
        // LD-08 / LD-20: package-sourced entries must be flagged verify_before_golive.
        if (e['resolved_by'] == 'LD-08') {
          expect(e['verify_before_golive'], true, reason: '${e['key']}');
        }
      }
    });
  });

  group('AC-0A-3.2 range', () {
    test('adToBs out of 1975–2099 throws common.date_out_of_range', () {
      for (final ad in ['1900-01-01', '1918-01-01', '2050-01-01', '2100-01-01', '9999-12-31']) {
        expect(() => adToBs(ad), _outOfRange(), reason: ad);
      }
      expect(adToBs('1919-01-01').year, 1975);
      final last = _months().last;
      final lastAd = _iso(_dn(last['ad_first_day'] as String) + (last['days'] as int) - 1);
      expect(adToBs(lastAd).year, 2099);
      expect(() => adToBs(_iso(_dn(lastAd) + 1)), _outOfRange());
    });
    test('bsToAd / daysInBsMonth / fiscalYearBs out of range', () {
      for (final y in [1974, 2100, 0, -1]) {
        expect(() => bsToAd(BsDate(y, 1, 1)), _outOfRange(), reason: '$y');
        expect(() => daysInBsMonth(y, 1), _outOfRange(), reason: '$y');
      }
      expect(() => fiscalYearBs('1900-01-01'), _outOfRange());
      expect(() => fiscalYearBs('2100-01-01'), _outOfRange());
    });
    test('malformed input rejected', () {
      for (final bad in ['', 'not-a-date', '2025-02-30', '2025-13-01', '2025-7-17']) {
        expect(() => adToBs(bad), throwsA(anything), reason: bad);
      }
      for (final b in [BsDate(2082, 0, 1), BsDate(2082, 13, 1), BsDate(2082, 4, 0), BsDate(2082, 4, -1)]) {
        expect(() => bsToAd(b), throwsA(anything), reason: _bs(b));
      }
    });
  });

  group('AC-0A-3.3 fiscalYearBs', () {
    test('Shrawan 1 -> Y/(Y+1)%100; previous day -> (Y-1)/(Y%100); all golden years', () {
      for (final r in _months().where((m) => m['bs_month'] == 4)) {
        final y = r['bs_year'] as int, first = r['ad_first_day'] as String;
        final on = fiscalYearBs(first);
        expect(on.long, _fy(y), reason: 'Shrawan 1 $y');
        expect(on.short, _fy(y).substring(1), reason: 'short $y');
        expect(on.startsOn, first);
        final prev = fiscalYearBs(_iso(_dn(first) - 1));
        expect(prev.long, _fy(y - 1), reason: 'day before $y');
        expect(prev.short, _fy(y - 1).substring(1));
        expect(prev.endsOn, _iso(_dn(first) - 1));
      }
    });
    test('century wrap and spec example', () {
      Map<String, dynamic> m(int y, int mo) => _months().firstWhere((r) => r['bs_year'] == y && r['bs_month'] == mo);
      expect(fiscalYearBs(m(2099, 4)['ad_first_day'] as String).long, '2099/00');
      expect(fiscalYearBs(_iso(_dn(m(2000, 4)['ad_first_day'] as String) - 1)).long, '1999/00');
      final f = fiscalYearBs('2025-07-17');
      expect([f.short, f.long, f.startsOn, f.endsOn],
          ['082/83', '2082/83', '2025-07-17', _iso(_dn(m(2083, 4)['ad_first_day'] as String) - 1)]);
      expect(fiscalYearBs('2025-07-16').long, '2081/82');
    });
  });

  group('formatBs', () {
    test('iso / display', () {
      expect(formatBs(BsDate(2082, 4, 1), style: 'iso'), '2082-04-01');
      expect(formatBs(BsDate(2082, 4, 1), style: 'display'), '2082-04-01 B.S.');
    });
  });
}
