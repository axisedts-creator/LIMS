// A23 providers: the account API over the app transport. The screen keeps the loaded account in its own state; nothing is stored (REQ-SEC-103).
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import 'account_api.dart';

final accountApiProvider = Provider<AccountApi>((ref) => TransportAccountApi(transport: ref.watch(transportProvider)));

/// The two fields of the E10 Account the screen needs. Parsing is strict: a body that is not the contract's shape is `common.internal`.
class AccountState {
  const AccountState({required this.version, required this.remindersOptOut});

  final int version;
  final bool remindersOptOut;
}

AccountState parseAccount(Object? json) {
  if (json is Map && json['version'] is int && json['reminders_opt_out'] is bool) {
    return AccountState(version: json['version'] as int, remindersOptOut: json['reminders_opt_out'] as bool);
  }
  throw LimsException(LimsErrorCodes.commonInternal);
}
