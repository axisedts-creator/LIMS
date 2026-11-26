// PHLEBO-UI-FULL-1 preview: a pretend centre inside the app so the screens can be tried on a phone with no server.
// Used only by lib/main_preview.dart (debug builds). Synthetic data only; nothing leaves the phone.
import 'dart:convert';

import 'package:lims_shared/lims_shared.dart';

import '../core/net/api_factory.dart';

/// Signing in with this password shows the "wrong password" state; any other value signs in.
const previewRejectedEntry = 'wrong';

String _iso(DateTime d) => DateTime.fromMillisecondsSinceEpoch(d.millisecondsSinceEpoch, isUtc: true).toIso8601String();

String _id(int n) => '01a1a98a-ac40-7000-8000-${n.toString().padLeft(12, '0')}';

String _date(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

Map<String, Object?> previewSnapshot(DateTime now) {
  final today = now.toLocal();
  String at(int h) => _iso(DateTime(today.year, today.month, today.day, h, 30));

  Map<String, Object?> visit(int n, String name, String area, {String kind = 'booking', List<String> containers = const ['RED_PLAIN']}) => {
        'visit_id': _id(130000 + n),
        'version': 1,
        'route_id': _id(170001),
        'route_sequence': n,
        'status': 'assigned',
        'kind': kind,
        'window_start': at(6 + n),
        'window_end': at(7 + n),
        'order_id': _id(50000 + n),
        'patient': {'full_name': name, 'phone_e164': '+977980000000$n'},
        'address': {'address_text': 'Demo Marg $n, $area (demo address)', 'landmark': 'Beside demo gate $n, $area'},
        // The preview has no printed tubes: the note tells you what to type.
        'note_for_phlebotomist': 'Demo: use "Type barcode" and enter ${[for (var i = 1; i <= containers.length; i++) 'DEMO$n$i'].join(', ')}',
        'specimens': [
          for (var i = 1; i <= containers.length; i++)
            {
              'specimen_id': _id(90000 + n * 10 + i),
              'barcode': 'DEMO$n$i',
              'specimen_type_code': i == 1 ? 'SERUM' : 'EDTA_WB',
              'container_code': containers[i - 1],
              'status': 'ordered',
            },
        ],
        'balance': {
          'balance_due': {'amount_paisa': 100000 + n * 50000, 'currency': 'NPR'},
          'as_of': _iso(now),
        },
      };

  return {
    'server_time': _iso(now),
    'cursor': 'preview-1',
    'unchanged': false,
    'device_command': 'none',
    'balances': <Object?>[],
    'route_date': _date(today),
    'config': {
      'sync_interval_seconds': 300,
      'offline_purge_hours': 16,
      'capture_gps': false,
      'map_handoff_enabled': true,
      'manual_barcode_entry_allowed': true,
      'second_identifier': 'phone',
      'collection_consent_text_version': 'demo-consent-v1',
      'collection_consent_text': 'I agree to a blood sample being taken at my home (demo consent text).',
      'payment_methods': [
        {'code': 'cash', 'display': 'Cash', 'requires_reference': false},
        {'code': 'fonepay_qr', 'display': 'Fonepay QR', 'requires_reference': true},
      ],
      'reasons': {
        'visit_fail_reasons': [
          {'code': 'patient_not_home', 'display': 'Patient not home'},
          {'code': 'address_not_found', 'display': 'Address not found'},
          {'code': 'patient_refused', 'display': 'Patient refused'},
          {'code': 'identity_mismatch', 'display': 'Identity mismatch'},
        ],
        'specimen_not_collected_reasons': [
          {'code': 'unable_to_draw', 'display': 'Unable to draw'},
        ],
      },
      'handover_centres': [
        {'centre_id': _id(20001), 'name': 'Central Lab (demo)'},
        {'centre_id': _id(20002), 'name': 'North Collection Point (demo)'},
      ],
      'min_app_version': '0.0.0',
    },
    'routes': [
      {'route_id': _id(170001), 'centre_id': _id(20001), 'version': 1},
    ],
    'visits': [
      visit(1, 'Asha Demo', 'Kirtipur', containers: ['RED_PLAIN', 'LAV_3ML']),
      visit(2, 'Bikash Demo', 'Balaju'),
      visit(3, 'Ekraj Demo', 'Thapathali', kind: 'recollection'),
      visit(4, 'Gita Demo', 'Patan', containers: ['RED_PLAIN', 'LAV_3ML']),
      {'visit_id': _id(130005), 'version': 2, 'route_id': _id(170001), 'route_sequence': 5, 'status': 'cancelled', 'kind': 'booking'},
    ],
  };
}

class PreviewApi implements ApiClient {
  PreviewApi(this.now);

  final DateTime Function() now;

  @override
  void close() {}

  @override
  Future<Map<String, Object?>> getJson(String path, {Map<String, String>? query}) async {
    if (path != '/sync/snapshot') throw LimsException(LimsErrorCodes.commonInternal);
    final snapshot = previewSnapshot(now());
    if (query?['cursor'] != snapshot['cursor']) return snapshot;
    return {
      'server_time': snapshot['server_time'],
      'cursor': snapshot['cursor'],
      'unchanged': true,
      'device_command': 'none',
      'balances': <Object?>[],
    };
  }

  @override
  Future<Map<String, Object?>> postJson(String path, Map<String, Object?> body, {String? idempotencyKey}) async {
    if (path.startsWith('/v1/identity/mobile/sessions')) {
      if (path.endsWith('/logout')) return {};
      if (body['password'] == previewRejectedEntry) throw LimsException(LimsErrorCodes.authLoginFailed);
      final claims = base64Url.encode(utf8.encode(jsonEncode({'sub': 'preview-user'}))).replaceAll('=', '');
      return {
        'session_token': 'preview'.padRight(43, 'x'),
        'access_token': 'preview.$claims.preview',
        'access_expires_at': _iso(now().add(const Duration(hours: 12))),
        'session_expires_at': _iso(now().add(const Duration(hours: 12))),
        'session': {
          'state': 'active',
          'actor': {'display_name': 'Sanjay Demo'},
        },
      };
    }
    if (path == '/sync/mutations') {
      return {
        'server_time': _iso(now()),
        'batch_id': body['batch_id'],
        'results': [
          for (final m in (body['mutations']! as List).cast<Map>())
            {'client_mutation_id': m['client_mutation_id'], 'device_seq': m['device_seq'], 'outcome': 'applied'},
        ],
        'handover_items': <Object?>[],
        'device_command': 'none',
      };
    }
    return {}; // device registration, ack, sign-off
  }
}
