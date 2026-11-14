import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import 'membership_api.dart';

final membershipApiProvider = Provider<MembershipApi>((ref) => TransportMembershipApi(transport: ref.watch(transportProvider)));

/// A21: raise the screen brightness while a card is shown so the front-desk scanner can read the QR; restore it afterwards. Best effort.
abstract interface class CardBrightness {
  Future<void> raise();
  Future<void> restore();
}

/// In-app platform channel (same convention as LimsSecureScreen); a platform without the hook is a no-op.
// ponytail: channel name [CONV]; the native side (Android/iOS brightness) is the app shell's, not built here.
class ChannelCardBrightness implements CardBrightness {
  static const _channel = MethodChannel('patient_app/card_brightness');

  Future<void> _call(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // platform without the hook (tests, web, desktop)
    } on PlatformException {
      // hook present but refused; the card still renders
    }
  }

  @override
  Future<void> raise() => _call('raise');

  @override
  Future<void> restore() => _call('restore');
}

final cardBrightnessProvider = Provider<CardBrightness>((_) => ChannelCardBrightness());

/// One card of E47 (MembershipCard schema). `token` is the secret behind the QR: it is never rendered as text.
class MembershipCardData {
  const MembershipCardData({required this.planName, required this.cardNo, required this.token, required this.validFrom, required this.validTo, required this.status});

  final String planName;
  final String cardNo;
  final String token;
  final String validFrom;
  final String validTo;
  final String status;
}

List<MembershipCardData> parseMemberships(Object? json) {
  final data = json is Map ? json['data'] : null;
  if (data is! List) throw LimsException('common.internal');
  return [
    for (final e in data)
      if (e is Map &&
          e['plan_display_name'] is String &&
          e['card_no'] is String &&
          e['card_token'] is String &&
          e['valid_from'] is String &&
          e['valid_to'] is String &&
          e['status'] is String)
        MembershipCardData(
          planName: e['plan_display_name'] as String,
          cardNo: e['card_no'] as String,
          token: e['card_token'] as String,
          validFrom: e['valid_from'] as String,
          validTo: e['valid_to'] as String,
          status: e['status'] as String,
        )
      else
        throw LimsException('common.internal'),
  ];
}

/// One GET on open (E47); a rebuild never asks again. Retry = the user's [Retry] (invalidate); Riverpod's automatic retry is off so the error state shows at once.
final myMembershipsProvider = FutureProvider.autoDispose<List<MembershipCardData>>(
  (ref) async => parseMemberships(await ref.watch(membershipApiProvider).listMyMemberships()),
  retry: (_, __) => null,
);
