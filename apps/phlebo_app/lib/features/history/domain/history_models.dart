// Past working days kept on the phone (board M5 History). Display only: names stay on the screen, never in a mutation.

/// collected | partial | missed
class HistoryRow {
  const HistoryRow({required this.name, required this.locality, required this.time, required this.summary, required this.status, this.reason});

  final String name;
  final String locality;
  final String time;

  /// "CBC, LFT": test names or the tube count; no results, no diagnoses.
  final String summary;
  final String status;

  /// Missed visits: the reason the phlebotomist chose ("Patient not home").
  final String? reason;
}

class HistoryDay {
  const HistoryDay({required this.id, required this.date, required this.rows});

  final String id;
  final DateTime date;
  final List<HistoryRow> rows;

  int get collected => rows.where((r) => r.status == 'collected' || r.status == 'partial').length;
  int get missed => rows.where((r) => r.status == 'missed').length;
}

/// Whole-number success rate of a set of days; 0 when there were no visits (never a divide by zero).
int successPercent(Iterable<HistoryDay> days) {
  var done = 0, total = 0;
  for (final d in days) {
    done += d.collected;
    total += d.rows.length;
  }
  return total == 0 ? 0 : (done * 100 / total).round();
}
