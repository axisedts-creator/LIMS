// Display helpers for A16-A19 (04-UI-UX A16-A19; 03-APP-FLOW §11 Bookings row). Pure. Wire text is shown only through these maps: raw codes never reach the screen.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';

/// status -> (LimsStatusChip tone, word); 04-UI-UX A16 tones.
const bookingStatuses = <String, (String, String)>{
  'confirmed': ('success', 'Confirmed'),
  'checked_in': ('info', 'Checked in'),
  'completed': ('neutral', 'Completed'),
  'cancelled': ('neutral', 'Cancelled'),
};

(String, String) bookingLook(Object? status) =>
    bookingStatuses[status] ?? ('neutral', 'In progress');

const addressLabels = <String, String>{
  'home': 'Home',
  'work': 'Work',
  'other': 'Other',
};

/// A home booking shows "Home collection" instead of a centre.
String placeText(Map<String, Object?> b) =>
    b['booking_kind'] == 'home_collection'
    ? 'Home collection'
    : (b['centre_display_name'] is String
          ? b['centre_display_name']! as String
          : '');

String priceText(Map<String, Object?> item) =>
    asMap(item['indicative_price']) == null
    ? 'Price at the lab'
    : rupees(asMap(item['indicative_price'])!['amount_paisa']);

/// Sum of the indicative prices (items without a price are left out); null when no item has one.
int? indicativeTotal(Iterable<Map<String, Object?>> items) {
  var any = false, sum = 0;
  for (final i in items) {
    final p = asMap(i['indicative_price'])?['amount_paisa'];
    if (p is num) {
      any = true;
      sum += p.toInt();
    }
  }
  return any ? sum : null;
}

/// 'yyyy-MM-dd' of the Asia/Kathmandu day of [iso].
String localYmd(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';

/// E32 slots -> LimsSlotPicker days (grouped by the Kathmandu date, time-of-day labels).
List<LimsSlotDay> slotDays(List<Map<String, Object?>> slots) {
  final byDay = <String, List<LimsSlot>>{};
  for (final s in slots) {
    final t = kathmandu(s['slot_start']);
    if (t == null || s['slot_start'] is! String) continue;
    final remaining = s['remaining'] is int ? s['remaining']! as int : 0;
    (byDay[localYmd(t)] ??= []).add((
      start: s['slot_start']! as String,
      label: clock12(t),
      remaining: remaining,
    ));
  }
  return [for (final e in byDay.entries) (date: e.key, slots: e.value)];
}

/// Friendly text for a failed booking call (03-APP-FLOW §11); never the code, never server detail.
String bookingErrorText(Object e) {
  if (e is LimsException) {
    return switch (e.code) {
      LimsErrorCodes.engagementSlotUnavailable =>
        'That time was just taken — pick another',
      LimsErrorCodes.engagementSlotOutsideWindow =>
        'That time can no longer be booked — pick another',
      LimsErrorCodes.engagementBookingLimitReached =>
        'You have reached the booking limit',
      LimsErrorCodes.engagementOrderableNotBookable => 'One of the tests cannot be booked for this person. Please change your selection.',
      LimsErrorCodes.engagementAddressRequired =>
        'Please choose an address for home collection.',
      LimsErrorCodes.engagementBookingNotCancellable =>
        'Too close to the appointment to cancel in the app — call the lab',
      LimsErrorCodes.engagementLinkLimitReached =>
        'You can save up to 10 addresses. Remove one to add another.',
      LimsErrorCodes.commonFeatureDisabled =>
        'This is not available right now.',
      LimsErrorCodes.commonNotFound => 'This is no longer available.',
      LimsErrorCodes.commonVersionConflict =>
        'This changed in the meantime. Please check and try again.',
      _ => 'Something went wrong. Please try again.',
    };
  }
  if (e is TimeoutException)
    return 'We could not reach the server. Please try again.';
  return 'Something went wrong. Please try again.';
}

/// A short banner: icon + words on a tone background (never colour-only).
class BookingBanner extends StatelessWidget {
  const BookingBanner({super.key, required this.text, this.tone = 'warning'});

  final String text;
  final String tone;

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone);
    return Container(
      width: double.infinity,
      color: c.bg,
      padding: const EdgeInsets.all(LimsTokens.space3),
      child: Row(
        children: [
          Icon(Icons.info_outline, color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(
            child: Text(text, style: TextStyle(color: c.fg)),
          ),
        ],
      ),
    );
  }
}

/// Radio-style choice rows (name only, no ids).
class ChoiceRow extends StatelessWidget {
  const ChoiceRow({
    super.key,
    required this.title,
    this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String? subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => LimsListTile(
    title: title,
    subtitle: subtitle,
    leading: Icon(
      selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
    ),
    onTap: onTap,
  );
}
