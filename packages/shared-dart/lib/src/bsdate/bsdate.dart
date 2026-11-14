// B.S. wrapper (02-TRD §3.2 / §3.4; 04 D13, L16; CV §13). Same API as packages/shared-ts/src/bsdate.
// The only file allowed to import nepali_utils (AC-0A-3.4).
import 'package:nepali_utils/nepali_utils.dart' show NepaliDateTime;

import '../error_codes.g.dart';
import '../errors.dart';

const bsMinYear = 1975, bsMaxYear = 2099; // 04 D13 common range

LimsException _outOfRange(String what) => LimsException(LimsErrorCodes.commonDateOutOfRange,
    safeDetail: '$what is outside B.S. $bsMinYear–$bsMaxYear');
LimsException _invalid(String what) =>
    LimsException(LimsErrorCodes.commonValidationFailed, safeDetail: 'invalid date: $what');

/// month 1 = Baisakh … 4 = Shrawan … 12 = Chaitra.
class BsDate {
  const BsDate(this.year, this.month, this.day);
  final int year, month, day;
  @override
  bool operator ==(Object o) => o is BsDate && o.year == year && o.month == month && o.day == day;
  @override
  int get hashCode => Object.hash(year, month, day);
  @override
  String toString() => formatBs(this);
}

// Day numbers (days since 1970-01-01, UTC) avoid local-time/DST drift.
int _dn(int y, int m, int d) => DateTime.utc(y, m, d).millisecondsSinceEpoch ~/ 86400000;
String _p(int n, int w) => n.toString().padLeft(w, '0');
String _isoDn(int n) {
  final t = DateTime.fromMillisecondsSinceEpoch(n * 86400000, isUtc: true);
  return '${_p(t.year, 4)}-${_p(t.month, 2)}-${_p(t.day, 2)}';
}

/// First-day day numbers of every B.S. month bsMinYear-01 … (bsMaxYear+1)-01, read once from the library.
late final List<int> _firsts = [
  for (var y = bsMinYear; y <= bsMaxYear; y++)
    for (var m = 1; m <= 12; m++) _libFirst(y, m),
  _libFirst(bsMaxYear + 1, 1),
];
// LD-08 (2026-11-07): the golden follows @remotemerge/nepali-date-converter@1.2.7 for unresolved
// months (verify_before_golive). nepali_utils 3.0.8 disagrees only on B.S. 2093-09/10
// (29/30 vs 30/29 days), so the package value wins via this first-day override.
const _ld08FirstDay = {'2093-10': [2037, 1, 15]};

int _libFirst(int y, int m) {
  final o = _ld08FirstDay['$y-${_p(m, 2)}'];
  if (o != null) return _dn(o[0], o[1], o[2]);
  final t = NepaliDateTime(y, m, 1).toDateTime();
  return _dn(t.year, t.month, t.day);
}

int _idx(int y, int m) => (y - bsMinYear) * 12 + (m - 1);

void _checkYm(int y, int m) {
  if (y < bsMinYear || y > bsMaxYear) throw _outOfRange('B.S. year $y');
  if (m < 1 || m > 12) throw _invalid('B.S. $y-$m');
}

int daysInBsMonth(int year, int month) {
  _checkYm(year, month);
  final i = _idx(year, month);
  return _firsts[i + 1] - _firsts[i];
}

String bsToAd(BsDate b) {
  _checkYm(b.year, b.month);
  if (b.day < 1 || b.day > daysInBsMonth(b.year, b.month)) throw _invalid(formatBs(b));
  return _isoDn(_firsts[_idx(b.year, b.month)] + b.day - 1);
}

final _isoRe = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

BsDate adToBs(String isoDate) {
  final m = _isoRe.firstMatch(isoDate);
  if (m == null) throw _invalid(isoDate);
  final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
  final t = DateTime.utc(y, mo, d);
  if (mo < 1 || mo > 12 || t.month != mo || t.day != d) throw _invalid(isoDate);
  final n = _dn(y, mo, d);
  if (n < _firsts.first || n >= _firsts.last) throw _outOfRange('A.D. $isoDate');
  // Binary search: last month whose first day <= n.
  var lo = 0, hi = _firsts.length - 2;
  while (lo < hi) {
    final mid = (lo + hi + 1) >> 1;
    if (_firsts[mid] <= n) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return BsDate(bsMinYear + lo ~/ 12, lo % 12 + 1, n - _firsts[lo] + 1);
}

/// FY starts Shrawan 1 (04 L16). startsOn/endsOn are getters: for FY 1974/75 and 2099/00 the
/// boundary lies outside the table and reading it throws common.date_out_of_range (same as TS).
class FiscalYearBs {
  FiscalYearBs._(this._y) : long = '$_y/${_p((_y + 1) % 100, 2)}';
  final int _y;
  final String long;
  String get short => long.substring(1);
  String get startsOn => bsToAd(BsDate(_y, 4, 1));
  String get endsOn {
    if (_y + 1 > bsMaxYear) throw _outOfRange('B.S. year ${_y + 1}');
    return _isoDn(_firsts[_idx(_y + 1, 4)] - 1);
  }
}

FiscalYearBs fiscalYearBs(String isoDate) {
  final b = adToBs(isoDate);
  return FiscalYearBs._(b.month >= 4 ? b.year : b.year - 1);
}

/// 'iso' = 'YYYY-MM-DD'; 'display' = 'YYYY-MM-DD B.S.' (CV §13).
String formatBs(BsDate b, {String style = 'iso'}) {
  final s = '${_p(b.year, 4)}-${_p(b.month, 2)}-${_p(b.day, 2)}';
  if (style == 'iso') return s;
  if (style == 'display') return '$s B.S.';
  throw ArgumentError.value(style, 'style', "must be 'iso' or 'display'");
}
