// HC-T27: plain date/time labels. Times come from the caller (never DateTime.now) so tests control them.
String _two(int n) => n.toString().padLeft(2, '0');

/// hh:mm
String formatHm(DateTime d) => '${_two(d.hour)}:${_two(d.minute)}';

/// DD/MM/YYYY
String formatDmy(DateTime d) => '${_two(d.day)}/${_two(d.month)}/${d.year}';
