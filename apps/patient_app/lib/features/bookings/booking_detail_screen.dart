// A18 Booking detail (04-UI-UX A18; 03-APP-FLOW §6.2, §11; US-EN-14.1-3). E35 on open; [Cancel booking] -> confirm -> E36 (If-Match = version, Idempotency-Key per attempt, reused on a retry of the same version);
// [Reschedule] opens A17 at the slot step. Both only while E35 carries cancellable_until (the server decides the cutoff). 404 = "no longer available" (AB-6).
// LD-140: lims_ui components and token names only; one primary button ([Reschedule]). REQ-SEC-109: LimsSecureScreen. PHI stays in widget state; server detail is never shown.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'booking_wizard_screen.dart';
import 'bookings_api.dart';
import 'bookings_format.dart';
import 'bookings_providers.dart';

class BookingDetailScreen extends ConsumerStatefulWidget {
  const BookingDetailScreen({super.key, required this.bookingId});

  final String bookingId;

  @override
  ConsumerState<BookingDetailScreen> createState() =>
      _BookingDetailScreenState();
}

class _BookingDetailScreenState extends ConsumerState<BookingDetailScreen> {
  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  Map<String, Object?>? _booking;
  String? _homeAddress, _notice, _cancelKey;
  int? _cancelKeyVersion;
  bool _gone = false, _failed = false, _cancelling = false;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    try {
      final b = asMap(await _api.getBooking(bookingId: widget.bookingId));
      if (!mounted) return;
      final addressId = b?['home_address_id'];
      String? text;
      if (addressId is String) {
        try {
          text = mapList(asMap(await _api.listAddresses())?['data'])
              .where((a) => a['id'] == addressId)
              .map((a) => a['address_text'])
              .whereType<String>()
              .firstOrNull;
        } on Object {
          text = null; // the booking is still readable without the address line
        }
      }
      if (!mounted) return;
      setState(() {
        _booking = b;
        _homeAddress = text;
        _failed = b == null;
      });
    } on LimsException catch (e) {
      if (mounted)
        setState(
          () => e.code == LimsErrorCodes.commonNotFound
              ? _gone = true
              : _failed = true,
        );
    } on Object {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _cancel() async {
    final b = _booking;
    if (b == null || _cancelling || b['id'] is! String || b['version'] is! int)
      return;
    final ok = await LimsConfirmDialog.show(
      context,
      title: 'Cancel this booking?',
      message: 'The time will be given to someone else.',
      confirmLabel: 'Yes, cancel',
      cancelLabel: 'Keep booking',
    );
    if (ok == null || !mounted) return;
    final version = b['version']! as int;
    if (_cancelKeyVersion != version) {
      _cancelKey = newIdempotencyKey(); // a retry of the same cancel reuses the key; a changed booking is a new request
      _cancelKeyVersion = version;
    }
    setState(() {
      _cancelling = true;
      _notice = null;
    });
    try {
      final done = asMap(
        await _api.cancelBooking(
          bookingId: b['id']! as String,
          version: version,
          idempotencyKey: _cancelKey!,
        ),
      );
      if (!mounted) return;
      if (done == null) throw StateError('empty answer');
      setState(() => _booking = done);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _notice = bookingErrorText(e));
      if (e is LimsException) await _fetch(); // the booking changed (cutoff passed, version moved): show it as it is now
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

  Future<void> _reschedule() async {
    final b = _booking;
    if (b == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BookingWizardScreen(rescheduleOf: b),
      ),
    );
    if (mounted) _fetch();
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('Booking')),
      body: _body(context),
    ),
  );

  Widget _body(BuildContext context) {
    if (_gone)
      return const Center(
        child: LimsEmptyState(title: 'This booking is no longer available'),
      );
    final b = _booking;
    if (b == null) {
      if (_failed)
        return Center(
          child: LimsErrorState(
            title: 'Something went wrong',
            message: 'We could not load this booking.',
            onRetry: () {
              setState(() => _failed = false);
              _fetch();
            },
          ),
        );
      return const Center(child: CircularProgressIndicator());
    }
    final items = mapList(b['items']);
    final total = indicativeTotal(items);
    final until = b['cancellable_until'];
    final open = b['status'] == 'confirmed' && until is String;
    final t = Theme.of(context).textTheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_notice != null) ...[
            BookingBanner(text: _notice!),
            const SizedBox(height: LimsTokens.space3),
          ],
          Align(
            alignment: Alignment.centerLeft,
            child: LimsStatusChip(
              kind: 'generic',
              status: '${b['status']}',
              tone: bookingLook(b['status']).$1,
              label: bookingLook(b['status']).$2,
            ),
          ),
          const SizedBox(height: LimsTokens.space2),
          Text('Booking ${b['booking_no']}', style: t.titleMedium),
          const SizedBox(height: LimsTokens.space2),
          Text(dateTimeText(b['slot_start'])),
          Text(placeText(b)),
          if (b['booking_kind'] == 'home_collection' && _homeAddress != null)
            Text(_homeAddress!),
          const SizedBox(height: LimsTokens.space4),
          Text('Tests', style: t.titleMedium),
          for (final i in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
              child: Row(
                children: [
                  Expanded(child: Text('${i['display_name']}')),
                  Text(priceText(i)),
                ],
              ),
            ),
          if (total != null)
            Padding(
              padding: const EdgeInsets.only(top: LimsTokens.space2),
              child: Text('Indicative total: ${rupees(total)}'),
            ),
          const Padding(
            padding: EdgeInsets.only(top: LimsTokens.space1),
            child: Text('Final price is confirmed at the lab.'),
          ),
          if (open) ...[
            const SizedBox(height: LimsTokens.space4),
            Text('You can cancel in the app until ${dateTimeText(until)}'),
            const SizedBox(height: LimsTokens.space3),
            LimsButton(
              label: 'Reschedule',
              onPressed: _cancelling ? null : _reschedule,
            ),
            const SizedBox(height: LimsTokens.space2),
            LimsButton(
              label: 'Cancel booking',
              secondary: true,
              onPressed: _cancelling ? null : _cancel,
            ),
          ],
        ],
      ),
    );
  }
}
