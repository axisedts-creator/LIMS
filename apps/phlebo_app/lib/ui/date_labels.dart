// Weekday / month words for the history and alert screens. Dates come from the caller (never DateTime.now in a widget).
const _days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String weekdayShort(DateTime d) => _days[d.weekday - 1].substring(0, 3);

String weekdayLong(DateTime d) => _days[d.weekday - 1];

/// "13 Nov"
String dayMonth(DateTime d) => '${d.day} ${_months[d.month - 1]}';

/// "Friday, 13 Nov"
String longDay(DateTime d) => '${weekdayLong(d)}, ${dayMonth(d)}';

/// "Today", "Yesterday" or "Friday, 13 Nov", relative to [now].
String relativeDay(DateTime d, DateTime now) {
  final a = DateTime(d.year, d.month, d.day), b = DateTime(now.year, now.month, now.day);
  final diff = b.difference(a).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  return longDay(d);
}

/// "9:20 AM"
String clock12(DateTime d) {
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour >= 12 ? 'PM' : 'AM'}';
}
