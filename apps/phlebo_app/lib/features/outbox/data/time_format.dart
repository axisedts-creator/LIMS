// HC-T24: IsoUtc with exactly three fractional digits (2026-11-06T00:30:00.000Z) — the format the server and the tests use.
String isoUtcMs(DateTime t) => DateTime.fromMillisecondsSinceEpoch(t.millisecondsSinceEpoch, isUtc: true).toIso8601String();

final RegExp _serverTime = RegExp(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$');

bool isIsoUtc(String s) => _serverTime.hasMatch(s) && DateTime.tryParse(s) != null;

bool validBootId(String s) => s.isNotEmpty && s.length <= 64;
