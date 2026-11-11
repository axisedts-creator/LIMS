// LD-24 (2026-11-07, A33-1, binding): client error tracking goes to the self-hosted GlitchTip (Sentry protocol),
// DSN from runtime config, OFF when unset. beforeSend runs the PHI scrubber below — a Dart port of the T0A-08 logger
// corpus (packages/shared-ts/src/logger, CV §9.2): no request bodies, no query strings, no cookies/auth headers,
// no names/phones/MRNs, user = opaque membership id only.
import 'package:sentry_flutter/sentry_flutter.dart';

const _r = '[REDACTED]';

/// CV §9.2 denylist (same list as the TS logger): a key is redacted if its lowercase form contains any entry.
const _deny = [
  'patient_name', 'full_name', 'first_name', 'middle_name', 'last_name', 'phone', 'mobile', 'email', 'address',
  'dob', 'date_of_birth', 'birth', 'citizenship', 'national_id', 'photo', 'signature',
  'registration_no', 'barcode', 'sample_no', 'lab_no', 'accession', 'url', 'qr',
  'result_value', 'interpretation', 'diagnos', 'clinical', 'trf', 'report_content', 'report_text',
  'password', 'passwd', 'otp', 'jwt', 'token', 'cookie', 'authorization', 'secret', 'api_key', 'apikey',
  'card', 'wallet', 'comment', 'critical', 'test_name', 'panel_name', 'smart_report',
];

/// Value scrubbers (logger corpus + LD-24 "no query strings"). [CONV] Bearer/Basic credentials are replaced whole.
final _scrub = <(RegExp, String Function(Match))>[
  (RegExp(r'(?<=[\w/.])\?[^\s#"]*'), (_) => ''), // query string inside free text (URLs in messages/breadcrumbs)
  (
    RegExp(r'\b(barcode|sample_no|lab_no|otp|pin|password|passwd|token|phone|mobile)(\s*[:=]\s*|\s+)\S*\d\S*', caseSensitive: false),
    (m) => '${m[1]}${m[2]}$_r',
  ),
  (RegExp(r'\b(Bearer|Basic)\s+\S+', caseSensitive: false), (_) => _r),
  (RegExp(r'[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'), (_) => _r),
  (RegExp(r'(?<![0-9A-Za-z])(?:\+?977[-\s]?)?9\d{9}(?![0-9A-Za-z])'), (_) => _r),
];

String _str(String s) => _scrub.fold(s, (acc, p) => acc.replaceAllMapped(p.$1, p.$2));
bool _denied(String k) {
  final l = k.toLowerCase();
  return _deny.any(l.contains);
}

Object? _val(Object? v, int depth) {
  if (v is String) return _str(v);
  if (v is int && _str('$v') != '$v') return _r; // numeric phone
  if (v is List) return depth > 10 ? '[Truncated]' : [for (final x in v) _val(x, depth + 1)];
  if (v is Map) {
    if (depth > 10) return '[Truncated]';
    return {for (final e in v.entries) '${e.key}': _denied('${e.key}') ? _r : _val(e.value, depth + 1)};
  }
  return v;
}

const _dropHeaders = {'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'};

Map<String, dynamic>? _request(Object? r) {
  if (r is! Map) return null;
  final url = r['url'];
  final headers = r['headers'];
  return {
    if (url is String) 'url': _str(url.split(RegExp('[?#]')).first),
    if (r['method'] is String) 'method': r['method'],
    if (headers is Map)
      'headers': {
        for (final e in headers.entries)
          if (!_dropHeaders.contains('${e.key}'.toLowerCase()) && !_denied('${e.key}')) '${e.key}': _val(e.value, 1),
      },
    // body (data), query_string, cookies, env, fragment: dropped (LD-24).
  };
}

/// beforeSend hook (LD-24). Rebuilds the event from its scrubbed JSON so no field type is missed; never throws.
SentryEvent? limsBeforeSend(SentryEvent event, Hint hint) {
  try {
    final j = Map<String, dynamic>.from(event.toJson());
    final user = j.remove('user');
    final request = j.remove('request');
    final out = (_val(j, 0) as Map).cast<String, dynamic>();
    if (user is Map && user['id'] != null) out['user'] = {'id': _str('${user['id']}')};
    final req = _request(request);
    if (req != null) out['request'] = req;
    return SentryEvent.fromJson(out);
  } catch (_) {
    // Fail closed: report only that something happened, never the unscrubbed payload.
    return SentryEvent(eventId: event.eventId, level: event.level, message: SentryMessage('[scrubber failed]'));
  }
}

/// Wiring for `SentryFlutter.init((o) => LimsErrorTracking.configure(o, dsn: config.dsn, ...))` (LD-24).
abstract final class LimsErrorTracking {
  static void configure(SentryFlutterOptions options, {String? dsn, String? environment, String? release}) {
    options.beforeSend = limsBeforeSend; // installed even when off (defence in depth)
    options.sendDefaultPii = false;
    options.attachScreenshot = false;
    options.attachViewHierarchy = false;
    final d = dsn?.trim() ?? '';
    if (d.isNotEmpty) options.dsn = d; // empty/unset DSN -> SDK stays off, no network
    if (environment != null) options.environment = environment;
    if (release != null) options.release = release;
  }
}
