// Providers and wire parsing for A6-A9 (E1 consent, E13 list, E14-E17 answers). Parsing is strict: a body that is not the contract's shape is `common.internal`.
// Nothing here logs or stores the answers; every value lives in widget state only (07-SECURITY, REQ-SEC-103).
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import '../auth/patient_auth_api.dart';
import 'profiles_api.dart';

final profilesApiProvider = Provider<ProfilesApi>((ref) => TransportProfilesApi(transport: ref.watch(transportProvider)));

LimsException _bad() => LimsException(LimsErrorCodes.commonInternal);

/// One Profile of E13 (display name and relationship only: the profile id is the handle, never shown; patient_code is not read).
class ProfileItem {
  const ProfileItem({required this.id, required this.name, required this.relationship, required this.method, required this.version});

  final String id;
  final String name;
  final String relationship; // self | child | parent | spouse | sibling | other
  final String method; // link_code | report_link | self_registered
  final int version; // LD-164: the E18/E19 If-Match value
}

class ProfileList {
  const ProfileList({required this.profiles, required this.pendingRelationships, required this.paused});

  final List<ProfileItem> profiles;
  final List<String> pendingRelationships; // one entry per self-registration still being created
  final int paused;

  bool get hasSelf => profiles.any((p) => p.relationship == 'self') || pendingRelationships.contains('self');
}

ProfileItem parseProfile(Object? json) {
  if (json case {'profile_id': String id, 'display_name': String name, 'relationship': String rel, 'method': String method, 'version': int version} when version >= 1) {
    return ProfileItem(id: id, name: name, relationship: rel, method: method, version: version);
  }
  throw _bad();
}

/// The id of the profile an E14/E15 answer carries.
String profileIdOf(Object? json) => parseProfile(json).id;

ProfileList parseProfileList(Object? json) {
  if (json case {'data': List<Object?> data, 'pending': List<Object?> pending, 'paused_count': int paused}) {
    return ProfileList(
      profiles: [for (final p in data) parseProfile(p)],
      pendingRelationships: [for (final p in pending) if (p is Map && p['relationship'] is String) p['relationship'] as String else throw _bad()],
      paused: paused,
    );
  }
  throw _bad();
}

/// E16/E17 SelfRegistration.
class SelfRegistration {
  const SelfRegistration({required this.id, required this.status, this.profileId});

  final String id;
  final String status; // queued | created | failed (anything else is read as "not ready yet")
  final String? profileId;
}

SelfRegistration parseSelfRegistration(Object? json) {
  if (json case {'id': String id, 'status': String status}) {
    final pid = (json as Map)['profile_id'];
    return SelfRegistration(id: id, status: status, profileId: pid is String ? pid : null);
  }
  throw _bad();
}

/// What A6/A9 need from E1: the consent the tenant asks for (absent = the tenant has no app registration) and the calendar mode.
class AppConsent {
  const AppConsent({required this.version, required this.text, required this.calendar});

  final String version;
  final String text;
  final String calendar; // AD | BS
}

/// E1 through the existing pre-auth API (no new config endpoint). Null = no `consent.text_version`. Throws on a failed call.
Future<AppConsent?> readConsent(PatientAuthApi api) async {
  final body = await api.getAppConfig();
  if (body is! Map) throw _bad();
  final consent = body['consent'];
  final version = consent is Map ? consent['text_version'] : null;
  if (version is! String || version.isEmpty) return null;
  final text = consent is Map && consent['text'] is String ? consent['text'] as String : '';
  return AppConsent(version: version, text: text, calendar: body['calendar_display'] == 'BS' ? 'BS' : 'AD');
}
