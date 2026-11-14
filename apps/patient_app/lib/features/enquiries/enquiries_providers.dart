// Providers and strict wire parsing for A22 (E48-E51, T3b). A body that is not the contract's shape is `common.internal`.
// 07-SECURITY §3: enquiry text is P3 — nothing is stored on the device; values live in provider state only while a screen watches them.
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import 'enquiries_api.dart';

final enquiriesApiProvider = Provider<EnquiriesApi>((ref) => TransportEnquiriesApi(transport: ref.watch(transportProvider)));

class EnquirySummary {
  const EnquirySummary({required this.id, required this.categoryCode, required this.subject, required this.status, required this.lastMessageAt, required this.version, this.profileId});

  final String id;
  final String categoryCode;
  final String subject;
  final String status; // open | answered | closed
  final String? profileId; // link id, never a patient id
  final String lastMessageAt;
  final int version;

  bool get isClosed => status == 'closed';
}

class EnquiryMessage {
  const EnquiryMessage({required this.authorKind, required this.body, required this.createdAt});

  final String authorKind; // patient | staff
  final String body;
  final String createdAt;

  bool get isMine => authorKind == 'patient';
}

class EnquiryThread {
  const EnquiryThread({required this.summary, required this.messages});

  final EnquirySummary summary;
  final List<EnquiryMessage> messages;
}

class EnquiryCategory {
  const EnquiryCategory({required this.code, required this.display});

  final String code;
  final String display;
}

LimsException _bad() => LimsException(LimsErrorCodes.commonInternal);

EnquirySummary _summary(Object? e) {
  if (e is Map && e['id'] is String && e['category_code'] is String && e['subject'] is String && e['status'] is String && e['last_message_at'] is String && e['version'] is int) {
    return EnquirySummary(
      id: e['id'] as String,
      categoryCode: e['category_code'] as String,
      subject: e['subject'] as String,
      status: e['status'] as String,
      profileId: e['profile_id'] is String ? e['profile_id'] as String : null,
      lastMessageAt: e['last_message_at'] as String,
      version: e['version'] as int,
    );
  }
  throw _bad();
}

List<EnquirySummary> parseEnquiryList(Object? json) {
  final data = json is Map ? json['data'] : null;
  if (data is! List) throw _bad();
  return [for (final e in data) _summary(e)];
}

EnquiryThread parseEnquiryThread(Object? json) {
  final msgs = json is Map ? json['messages'] : null;
  if (msgs is! List) throw _bad();
  return EnquiryThread(
    summary: _summary(json),
    messages: [
      for (final m in msgs)
        if (m is Map && m['author_kind'] is String && m['body'] is String && m['created_at'] is String)
          EnquiryMessage(authorKind: m['author_kind'] as String, body: m['body'] as String, createdAt: m['created_at'] as String)
        else
          throw _bad(),
    ],
  );
}

List<EnquiryCategory> parseCategories(Object? json) {
  final data = json is Map ? json['data'] : null;
  if (data is! List) throw _bad();
  final rows = [
    for (final c in data)
      if (c is Map && c['code'] is String && c['display'] is String) (c['sort_order'] is int ? c['sort_order'] as int : 0, EnquiryCategory(code: c['code'] as String, display: c['display'] as String)) else throw _bad(),
  ]..sort((a, b) => a.$1.compareTo(b.$1));
  return [for (final r in rows) r.$2];
}

// Riverpod's automatic retry is off so an error shows at once; the user's [Retry] invalidates.
/// A22 list: the first page of E48 (newest first).
final enquiriesProvider = FutureProvider.autoDispose<List<EnquirySummary>>(
  (ref) async => parseEnquiryList(await ref.watch(enquiriesApiProvider).listMyEnquiries()),
  retry: (_, __) => null,
);

/// A22 thread: E50.
final enquiryThreadProvider = FutureProvider.autoDispose.family<EnquiryThread, String>(
  (ref, id) async => parseEnquiryThread(await ref.watch(enquiriesApiProvider).getMyEnquiry(id: id)),
  retry: (_, __) => null,
);

/// A22 new: the Topic options (T3b enquiry_categories).
final enquiryCategoriesProvider = FutureProvider.autoDispose<List<EnquiryCategory>>(
  (ref) async => parseCategories(await ref.watch(enquiriesApiProvider).listMyCodedSet('enquiry_categories')),
  retry: (_, __) => null,
);
