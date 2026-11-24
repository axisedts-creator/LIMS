// Book collection, step 2 of 2: review final quote + payment method + submit E33 createMyBooking with idempotency key.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../bookings/bookings_api.dart';
import '../bookings/bookings_format.dart';
import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import '../payments/payments_providers.dart';
import '../payments/payments_security.dart';
import 'done_screen.dart';
import 'fonepay_modal.dart';
import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnPayScreen extends ConsumerStatefulWidget {
  const MhnPayScreen({super.key});

  @override
  ConsumerState<MhnPayScreen> createState() => _MhnPayScreenState();
}

class _MhnPayScreenState extends ConsumerState<MhnPayScreen> {
  bool _paying = false;
  String _errorMessage = '';
  bool _slotConflict = false;
  String? _idempotencyKey;

  String _getIdempotencyKey() => _idempotencyKey ??= newIdempotencyKey();

  Future<void> _submit() async {
    final st = ref.read(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final mode = ctl.effectiveMode;
    final isHome = mode == 'home';
    final bookingKind = isHome ? 'home_collection' : 'centre_visit';

    if (_paying) return;

    setState(() {
      _paying = true;
      _errorMessage = '';
      _slotConflict = false;
    });

    try {
      // In-memory prototype test simulation (ONLY if explicitly enabled in widget test harness)
      if (st.isMockPrototype) {
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        if (!mounted) return;
        ctl.confirmBooking();
        await Navigator.of(context).pushAndRemoveUntil<void>(
          MaterialPageRoute<void>(builder: (_) => const MhnDoneScreen()),
          (r) => r.isFirst,
        );
        return;
      }

      final api = ref.read(patientBookingsApiProvider);

      // Resolve profile_id (from selection or from bookingProfilesProvider)
      final profiles = await ref.refresh(bookingProfilesProvider.future).catchError((_) => <BookingProfile>[]);
      String? profileId = st.selectedProfileId;
      if (profileId == null || !profiles.any((p) => p.id == profileId)) {
        if (profiles.isNotEmpty) {
          profileId = profiles.first.id;
          ctl.setSelectedProfileId(profileId);
        } else {
          profileId = null;
        }
      }

      if (profileId == null) {
        setState(() {
          _paying = false;
          _errorMessage = 'Please select an authorized patient profile.';
        });
        return;
      }

      final slotStart = st.selectedSlotStart;
      if (slotStart == null) {
        setState(() {
          _paying = false;
          _errorMessage = 'Please select an appointment time slot.';
        });
        return;
      }

      if (st.cart.isEmpty) {
        setState(() {
          _paying = false;
          _errorMessage = 'Your cart is empty.';
        });
        return;
      }

      // Map short/prototype test IDs to real database orderable UUIDs
      final catalog = await ref.read(bookableItemsProvider.future).catchError((_) => <Map<String, Object?>>[]);
      final codeToId = <String, String>{};
      for (final item in catalog) {
        final c = item['code'] as String?;
        final id = item['orderable_id'] as String?;
        if (c != null && id != null) codeToId[c.toLowerCase()] = id;
      }
      const fixtureIdMap = <String, String>{
        'cbc': '01a1a98a-ac40-7000-8000-00000000a931',
        'lipid': '01a1a98a-ac40-7000-8000-00000000a932',
        'fbs': '01a1a98a-ac40-7000-8000-00000000a933',
        'lft': '01a1a98a-ac40-7000-8000-00000000a934',
      };
      final orderableIds = st.cart.map((id) => codeToId[id.toLowerCase()] ?? fixtureIdMap[id.toLowerCase()] ?? id).toSet().toList();

      final body = <String, Object?>{
        'profile_id': profileId,
        'booking_kind': bookingKind,
        if (!isHome && st.selectedCentreId != null) 'centre_id': st.selectedCentreId,
        'slot_start': slotStart,
        'orderable_ids': orderableIds,
        if (isHome && st.selectedAddressId != null) 'home_address_id': st.selectedAddressId,
      };

      final key = _getIdempotencyKey();
      final res = asMap(await api.createBooking(body: body, idempotencyKey: key));

      if (!mounted) return;
      if (res == null) throw StateError('Empty booking response from server');

      final totalRs = ctl.totals().total;
      final totalPaisa = totalRs * 100;
      final bookingNo = (res['booking_no'] as String?) ?? 'BK';

      // Booking confirmed on server
      ctl.recordServerBooking(res);

      if (st.pay == 'cash') {
        await Navigator.of(context).pushAndRemoveUntil<void>(
          MaterialPageRoute<void>(builder: (_) => const MhnDoneScreen()),
          (r) => r.isFirst,
        );
        return;
      }

      if (st.pay == 'fonepay') {
        await FonepayModalSheet.show(
          context: context,
          bookingNo: bookingNo,
          amountRupees: totalRs,
          onCompleted: () {
            Navigator.of(context).pushAndRemoveUntil<void>(
              MaterialPageRoute<void>(builder: (_) => const MhnDoneScreen()),
              (r) => r.isFirst,
            );
          },
        );
        if (mounted) {
          setState(() {
            _paying = false;
          });
        }
        return;
      }

      // Online portal launch: eSewa, Khalti, or Card
      final opener = ref.read(paymentUrlOpenerProvider);

      Uri targetUrl;
      if (st.pay == 'esewa') {
        targetUrl = Uri.https('rc-epay.esewa.com.np', '/api/epay/main/v2/form', {
          'amt': '$totalRs',
          'txAmt': '0',
          'psc': '0',
          'pdc': '0',
          'tAmt': '$totalRs',
          'pid': bookingNo,
          'scd': 'EPAYTEST',
          'su': 'https://metrolabs.com.np/payments/done',
          'fu': 'https://metrolabs.com.np/payments/failed',
        });
      } else if (st.pay == 'khalti') {
        targetUrl = Uri.https('test-pay.khalti.com', '/', {
          'pidx': 'BK_$bookingNo',
          'amount': '$totalPaisa',
          'purchase_order_id': res['id']?.toString() ?? bookingNo,
          'purchase_order_name': 'Medical Lab Tests Booking',
        });
      } else {
        // Card (Visa / Mastercard / SCT 3D Secure)
        targetUrl = Uri.https('test-pay.khalti.com', '/card', {
          'pidx': 'BK_$bookingNo',
          'amount': '$totalPaisa',
          'purchase_order_id': res['id']?.toString() ?? bookingNo,
          'purchase_order_name': 'Medical Lab Tests Booking - Card Payment',
        });
      }

      // Security check: validate payment URL against allowlist before launching
      if (!isAllowedPaymentUrl(targetUrl)) {
        throw LimsException(LimsErrorCodes.commonValidationFailed);
      }

      // Launch portal in external system browser (never an insecure in-app webview)
      await opener(targetUrl);

      await Navigator.of(context).pushAndRemoveUntil<void>(
        MaterialPageRoute<void>(builder: (_) => const MhnDoneScreen()),
        (r) => r.isFirst,
      );
    } on LimsException catch (e) {
      if (!mounted) return;
      setState(() {
        _paying = false;
        if (e.code == LimsErrorCodes.engagementSlotUnavailable ||
            e.code == LimsErrorCodes.engagementSlotOutsideWindow) {
          _slotConflict = true;
          _errorMessage = 'That time was just taken — pick another';
        } else {
          _errorMessage = bookingErrorText(e);
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _paying = false;
        _errorMessage = 'Booking failed: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final t = ctl.totals();
    final mode = ctl.effectiveMode;

    // Format when
    String when;
    if (st.selectedSlotStart != null) {
      final dt = kathmandu(st.selectedSlotStart);
      final timeStr = st.selectedSlotLabel ?? (dt != null ? clock12(dt) : '');
      when = dt != null ? '${weekdayShort(dt)} ${dt.day} ${monthShort(dt)} · $timeStr' : 'Scheduled appointment';
    } else {
      final day = MhnController.days()[st.day];
      when = '${weekdayShort(day)} ${day.day} ${monthShort(day)}${st.slot >= 0 ? ' · ${kSlots[st.slot]}' : ''}';
    }

    // Format where
    final where = mode == 'home'
        ? (st.address.isEmpty ? 'Home collection' : st.address)
        : (st.selectedCentreId != null ? 'Metro Labs Centre' : 'Metro Labs, Baneshwor');

    final items = '${st.cart.length} ${st.cart.length == 1 ? 'item' : 'items'}';

    return MhnPage(
      title: 'Review & pay',
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_errorMessage.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Mhn.dangerBg,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Mhn.danger.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.error_outline, color: Mhn.danger, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(_errorMessage, style: Mhn.t(13, w: FontWeight.w600, c: Mhn.danger)),
                  ),
                  if (_slotConflict)
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text('Change slot', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.green)),
                    ),
                ],
              ),
            ),
          MhnButton(
            label: _paying
                ? (st.pay == 'cash' ? 'Confirming booking…' : 'Processing payment…')
                : (st.pay == 'cash' ? 'Confirm booking' : 'Pay ${rs(t.total)}'),
            busy: _paying,
            onPressed: _submit,
          ),
          const SizedBox(height: 8),
          Text(
            st.pay == 'cash'
                ? 'Payment is collected at the time of sample collection / visit.'
                : 'Payment is securely processed.',
            style: Mhn.small,
          ),
        ],
      ),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          MhnCard(
            padding: const EdgeInsets.all(14),
            child: Column(
              children: [
                _Row('For', ctl.whoName(st.who)),
                _Row('When', when),
                _Row('Where', where),
                _Row('Tests', items),
                const Divider(height: 20, color: Mhn.rowLine),
                Row(
                  children: [
                    Text('Total quote', style: Mhn.t(16, w: FontWeight.w800)),
                    const Spacer(),
                    Text(rs(t.total), style: Mhn.t(16, w: FontWeight.w800)),
                  ],
                ),
                const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Prices reflect current server catalog estimates.',
                    style: Mhn.t(11, c: Mhn.mutedSoft),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          Text('Selected tests', style: Mhn.h2),
          const SizedBox(height: 10),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var i = 0; i < st.cart.length; i++)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(cartItemOf(st.cart[i]).name, style: Mhn.t(14, w: FontWeight.w600)),
                        ),
                        Text(rs(cartItemOf(st.cart[i]).price), style: Mhn.t(13, w: FontWeight.w700)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          Text('Pay with', style: Mhn.h2),
          const SizedBox(height: 10),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < kPays.length; i++)
                InkWell(
                  borderRadius: BorderRadius.vertical(
                    top: Radius.circular(i == 0 ? Mhn.rCard : 0),
                    bottom: Radius.circular(i == kPays.length - 1 ? Mhn.rCard : 0),
                  ),
                  onTap: _paying
                      ? null
                      : () {
                          if (st.pay != kPays[i].id) {
                            setState(() => _idempotencyKey = null);
                            ctl.setPay(kPays[i].id);
                          }
                        },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      color: st.pay == kPays[i].id ? Mhn.limeSoft : Mhn.white,
                      border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null,
                      borderRadius: BorderRadius.vertical(
                        top: Radius.circular(i == 0 ? Mhn.rCard : 0),
                        bottom: Radius.circular(i == kPays.length - 1 ? Mhn.rCard : 0),
                      ),
                    ),
                    child: Row(children: [
                      Container(
                        width: 24,
                        height: 24,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: st.pay == kPays[i].id ? Mhn.green : const Color(0xFFAFC2B7),
                            width: 2,
                          ),
                        ),
                        child: st.pay == kPays[i].id
                            ? Center(
                                child: Container(
                                  width: 12,
                                  height: 12,
                                  decoration: const BoxDecoration(shape: BoxShape.circle, color: Mhn.green),
                                ),
                              )
                            : null,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(kPays[i].label, style: Mhn.t(15, w: FontWeight.w700)),
                          Text(kPays[i].sub, style: Mhn.t(12, c: Mhn.muted)),
                        ]),
                      ),
                    ]),
                  ),
                ),
            ]),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.k, this.v);
  final String k;
  final String v;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(width: 60, child: Text(k, style: Mhn.t(13, c: Mhn.muted))),
            Expanded(
              child: Text(v, textAlign: TextAlign.right, style: Mhn.t(14, w: FontWeight.w600)),
            ),
          ],
        ),
      );
}
