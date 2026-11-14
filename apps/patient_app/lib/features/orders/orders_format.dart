// Display helpers for A10 / A11 (04-UI-UX A10, A11). Pure. Wire text is shown only through these maps: raw stage codes never reach the screen.
/// stage -> (LimsStatusChip tone, label); 04-UI-UX A10 tones.
const orderStages = <String, (String, String)>{
  'registered': ('neutral', 'Registered'),
  'sample_collected': ('info', 'Sample collected'),
  'in_lab': ('info', 'In the lab'),
  'partial_report': ('warning', 'Partial report'),
  'report_ready': ('success', 'Report ready'),
  'recollection_needed': ('danger', 'New sample needed'),
  'cancelled': ('neutral', 'Cancelled'),
};

(String, String) stageLook(Object? stage) => orderStages[stage] ?? ('neutral', 'In progress');

/// [CONV] Display time is Asia/Kathmandu (UTC+05:45, no DST), the lab convention; the app has no tenant timezone yet.
DateTime? kathmandu(Object? iso) {
  final t = iso is String ? DateTime.tryParse(iso) : null;
  return t?.toUtc().add(const Duration(hours: 5, minutes: 45));
}

String _2(int n) => n.toString().padLeft(2, '0');

String clock12(DateTime t) => '${_2(t.hour % 12 == 0 ? 12 : t.hour % 12)}:${_2(t.minute)} ${t.hour < 12 ? 'AM' : 'PM'}';

String dateText(Object? iso) {
  final t = kathmandu(iso);
  return t == null ? '' : '${_2(t.day)}/${_2(t.month)}/${t.year}';
}

String dateTimeText(Object? iso) {
  final t = kathmandu(iso);
  return t == null ? '' : '${dateText(iso)} ${clock12(t)}';
}

/// "Updated hh:mm" line: 24 h local-lab clock of the last successful check.
String updatedText(DateTime nowUtc) {
  final t = nowUtc.toUtc().add(const Duration(hours: 5, minutes: 45));
  return 'Updated ${_2(t.hour)}:${_2(t.minute)}';
}

/// NPR paisa -> "Rs. 2,250.00".
String rupees(Object? paisa) {
  final p = paisa is num ? paisa.toInt() : 0;
  final whole = (p.abs() ~/ 100).toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${p < 0 ? '-' : ''}Rs. $whole.${_2(p.abs() % 100)}';
}

Map<String, Object?>? asMap(Object? v) => v is Map ? v.cast<String, Object?>() : null;

/// Screens read wire maps defensively; a malformed row is skipped, never thrown on.
List<Map<String, Object?>> mapList(Object? v) => v is List ? [for (final e in v) if (e is Map) e.cast<String, Object?>()] : const [];
