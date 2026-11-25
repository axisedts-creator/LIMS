// Payload shape check at enqueue. Mirrors services/api/src/modules/homecollection/domain/mutation.ts
// (contracts/openapi/homecollection.yaml Mutation* payloads) plus the GPS range check of sync.service.ts parseGps.
// Why here: the server validates the whole push envelope first (C17 02-TRD §6.3 step 1), so ONE payload that does not
// match fails the whole batch with 400 and the device re-sends the same frozen body: sync stays blocked for every
// visit. A payload that would be refused must therefore never enter the outbox. The server check stays the authority.

typedef _Check = bool Function(Object? v);

_Check _str(int min, int max, [RegExp? re]) =>
    (v) => v is String && v.length >= min && v.length <= max && (re == null || re.hasMatch(v));
_Check _int(int min, int max) => (v) => v is int && v >= min && v <= max;
_Check _oneOf(Set<String> vals) => (v) => v is String && vals.contains(v);
bool _bool(Object? v) => v is bool;

final _uuid = _str(36, 36, RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
final _uuidv7 = _str(36, 36, RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
final _code = _str(1, 100, RegExp(r'^[A-Za-z0-9][A-Za-z0-9_.:-]*$'));
final _decimal = _str(1, 40, RegExp(r'^-?[0-9]+(\.[0-9]+)?$'));
final _reasonCode = _str(1, 64, RegExp(r'^[a-z0-9_]{1,64}$'));
final _text200 = _str(1, 200);
final _gpsStatus = _oneOf(const {'off', 'denied', 'unavailable', 'ok'});

/// Closed object: every key of [req] present, every other key in [opt], each value passes its check.
_Check _shape(Map<String, _Check> req, [Map<String, _Check> opt = const {}]) => (v) {
      if (v is! Map) return false;
      if (!req.keys.every(v.containsKey)) return false;
      for (final e in v.entries) {
        final check = req[e.key] ?? opt[e.key];
        if (check == null || !check(e.value)) return false;
      }
      return true;
    };

final _gpsShape = _shape({'status': _gpsStatus}, {'latitude': _decimal, 'longitude': _decimal, 'accuracy_m': _int(0, 10000)});

bool _gps(Object? v) {
  if (v is! Map || !_gpsShape(v)) return false;
  if (v['status'] != 'ok') return !(v.containsKey('latitude') || v.containsKey('longitude') || v.containsKey('accuracy_m'));
  // parseGps: Number(undefined) is NaN on the server, so a missing coordinate with status ok is refused too.
  final lat = double.tryParse('${v['latitude']}'), lon = double.tryParse('${v['longitude']}');
  return lat != null && lon != null && lat.abs() <= 90 && lon.abs() <= 180;
}

final _money = _shape({'amount_paisa': _int(1, 50000000), 'currency': _oneOf(const {'NPR'})});

final Map<String, _Check> _schemas = {
  'visit.arrived': _shape({'gps': _gps}),
  'visit.identity_checked': _shape({
    'name_check': _oneOf(const {'matches', 'mismatch'}),
    'second_identifier': _oneOf(const {'phone', 'birth_date'}),
    'second_check': _oneOf(const {'matches', 'mismatch'}),
  }),
  'visit.consent_recorded': _shape({'consent_text_version': _str(1, 40), 'given': _bool}),
  'specimen.collected': _shape({
    'specimen_id': _uuid,
    'scanned_barcode': _str(1, 20, RegExp(r'^[A-Z0-9]{1,20}$')),
    'scan_method': _oneOf(const {'camera', 'hid', 'manual'}),
    'specimen_type_code': _code,
    'gps': _gps,
  }),
  'specimen.not_collected': _shape({'specimen_id': _uuid, 'reason_code': _reasonCode}, {'reason_text': _text200}),
  'payment.captured': _shape({'order_id': _uuid, 'payment_method_code': _code, 'amount': _money}, {'reference': _str(1, 100)}),
  'visit.completed': _shape({'outcome': _oneOf(const {'collected', 'partial'})}),
  'visit.failed': _shape({'reason_code': _reasonCode, 'gps': _gps}, {'reason_text': _text200}),
  'handover.recorded': _shape({
    'handover_id': _uuidv7,
    'to_centre_id': _uuid,
    'specimen_ids': (v) => v is List && v.isNotEmpty && v.length <= 50 && v.every(_uuid),
  }),
};

/// True when the server would accept this payload's shape for [type]. Unknown type = false.
bool mutationPayloadIsValid(String type, Object? payload) => _schemas[type]?.call(payload) ?? false;
