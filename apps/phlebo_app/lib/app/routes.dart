// HC-T21: location builders for the contract routes (contracts/routes.yaml phlebo_app.route / phlebo_app.visit).
// Arguments are validated so an id can never inject path segments or a query string.
import 'package:lims_shared/lims_shared.dart';

final _date = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');
final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

String phleboRouteLocation(String routeDate) {
  final m = _date.firstMatch(routeDate);
  final y = int.tryParse(m?[1] ?? ''), mo = int.tryParse(m?[2] ?? ''), d = int.tryParse(m?[3] ?? '');
  // DateTime rolls 2026-02-30 over to March, so compare the parts back.
  final t = (y == null || mo == null || d == null) ? null : DateTime.utc(y, mo, d);
  if (t == null || t.year != y || t.month != mo || t.day != d) throw ArgumentError.value(routeDate, 'routeDate', 'must be a real YYYY-MM-DD date');
  return limsRoutePaths['phlebo_app.route']!.replaceFirst('{route_date}', routeDate);
}

String phleboVisitLocation(String visitId) {
  if (!_uuid.hasMatch(visitId)) throw ArgumentError.value(visitId, 'visitId', 'must be a UUID');
  return limsRoutePaths['phlebo_app.visit']!.replaceFirst('{visit_id}', visitId);
}
