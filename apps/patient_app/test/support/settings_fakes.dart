// T-AC1 test support: fake AccountApi (E10/E11/E12 wire JSON as plain maps), host + pump helpers for A23 Settings. Synthetic data only (tenant "Synthetic Lab Alpha").
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes) - all under apps/patient_app/lib/features/settings/:
//   account_api.dart        abstract interface class AccountApi {
//                             Future<Object?> getMyAccount();                                                   // E10 GET /v1/engagement/me -> Account
//                             Future<Object?> updateMyAccount({required int version, required bool remindersOptOut}); // E11 PATCH /v1/engagement/me {reminders_opt_out}; If-Match "<version>" -> Account
//                             Future<void> deleteMyAccount({required int version});                             // E12 POST /v1/engagement/me/delete {confirm:true}; If-Match "<version>"; fresh Idempotency-Key per call -> 204
//                           }  Each returns the decoded wire JSON of contracts/openapi/engagement.yaml and throws LimsException.
//                           TransportAccountApi({required PatientTransport transport}).
//   settings_providers.dart accountApiProvider (Provider<AccountApi>).
//   settings_screen.dart    SettingsScreen({super.key, this.onSignedOut})   A23; onSignedOut: VoidCallback? (called after the local session is gone); a Riverpod consumer.
//                           Sign out = sessionControllerProvider.logout() (C2 logout). Delete = E12, then the LOCAL session is wiped WITHOUT a server logout call (C2 already revoked every session:
//                           SessionController.expire()). Legal links (LD-28) open through externalUrlOpenerProvider with flavourProvider's privacyUrl / termsUrl (and tenantPrivacyUrl under the lab name).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/settings/account_api.dart';
import 'package:patient_app/features/settings/settings_providers.dart';
import 'package:patient_app/features/settings/settings_screen.dart';

import 'auth_fakes.dart' show alphaFlavour;
import 'rig.dart';

Map<String, Object?> accountWire({int version = 3, bool optOut = false, String status = 'active'}) => {
      'id': '01950c16-0000-7000-8000-0000000000e1',
      'phone_masked': '+99X•••••42',
      'status': status,
      'reminders_opt_out': optOut,
      'last_login_at': '2026-11-05T04:15:00.000Z',
      'created_at': '2026-10-01T00:00:00.000Z',
      'version': version,
    };

/// In-memory account behind E10/E11/E12: E11/E12 compare the If-Match version like the server (stale -> `common.version_conflict`).
class FakeAccountApi implements AccountApi {
  FakeAccountApi({int version = 3, bool optOut = false}) : _version = version, _optOut = optOut;

  int _version;
  bool _optOut;
  bool deleted = false;

  int getCalls = 0;
  final updates = <({int version, bool optOut})>[];
  final deletes = <int>[];

  Future<void>? hold; // awaited by E12 before it answers (an in-flight deletion)
  Object? Function(int call)? updateFail;
  Object? Function(int call)? deleteFail;
  Object? Function(int call)? getFail;

  /// Another device changed the account: the server version moves on.
  void bump() => _version++;

  @override
  Future<Object?> getMyAccount() async {
    final call = ++getCalls;
    final f = getFail?.call(call);
    if (f != null) throw f;
    return accountWire(version: _version, optOut: _optOut);
  }

  @override
  Future<Object?> updateMyAccount({required int version, required bool remindersOptOut}) async {
    updates.add((version: version, optOut: remindersOptOut));
    final f = updateFail?.call(updates.length);
    if (f != null) throw f;
    if (version != _version) throw staleVersion();
    _optOut = remindersOptOut;
    _version++;
    return accountWire(version: _version, optOut: _optOut);
  }

  @override
  Future<void> deleteMyAccount({required int version}) async {
    deletes.add(version);
    if (hold != null) await hold;
    final f = deleteFail?.call(deletes.length);
    if (f != null) throw f;
    if (version != _version) throw staleVersion();
    deleted = true;
  }
}

/// `common.version_conflict` as the transport raises it.
Object staleVersion() => LimsException(LimsErrorCodes.commonVersionConflict);

class Host {
  Host(this.rig, this.api, this.opened, this.widget);
  final Rig rig;
  final FakeAccountApi api;
  final List<Uri> opened;
  final Widget widget;
}

/// A23 inside the providers it reads. The session is the real SessionController of the T-A1 rig (signed in by the caller); legal links are recorded, never launched.
Host settingsHost(Rig rig, FakeAccountApi api, {String? tenantPrivacyUrl, String? privacyUrl = 'https://legal.invalid/privacy', String? termsUrl = 'https://legal.invalid/terms', VoidCallback? onSignedOut}) {
  final opened = <Uri>[];
  return Host(
    rig,
    api,
    opened,
    ProviderScope(
      overrides: [
        accountApiProvider.overrideWithValue(api),
        sessionControllerProvider.overrideWithValue(rig.controller),
        flavourProvider.overrideWithValue(alphaFlavour(tenantPrivacyUrl: tenantPrivacyUrl, privacyUrl: privacyUrl, termsUrl: termsUrl)),
        externalUrlOpenerProvider.overrideWithValue((u) async => opened.add(u)),
      ],
      child: MaterialApp(home: SettingsScreen(onSignedOut: onSignedOut)),
    ),
  );
}

/// Settles UI + the real file / storage IO the session wipe does (secure storage mock, temp-file delete).
Future<void> settleIo(WidgetTester t) async {
  for (var i = 0; i < 4; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await t.pump(const Duration(milliseconds: 200));
  }
}
